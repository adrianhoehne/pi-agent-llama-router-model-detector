/**
 * Dynamic Model Loader for llama-cpp router providers
 *
 * Reads modelDefinitionUrl from models.json provider config.
 * Fetches available models at startup, injects them into the provider.
 * Discovers context windows via before_provider_request hook on first use.
 *
 * All other provider config comes from models.json — only the models array
 * is replaced dynamically.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_PATH = resolve(__dirname, "../../models.json");

const DEFAULT_CONTEXT_WINDOW = 65536;
const PROPS_TIMEOUT_MS = 120_000; // 2 minutes for router mode

const providers = new Map();
const contextWindowCache = new WeakMap();
const pendingFetches = new Set(); // avoid duplicate concurrent fetches

export default async function (pi) {
  console.log("[dynamic-models] Extension loaded");
  providers.clear();
  pendingFetches.clear();

  const config = readModelsConfig();
  if (!config) {
    console.log("[dynamic-models] No models.json or provider config found — skipping");
    return;
  }

  const dynamicProviders = Object.entries(config.providers ?? {}).filter(
    ([, providerConfig]) => providerConfig?.modelDefinitionUrl
  );

  if (dynamicProviders.length === 0) {
    console.log("[dynamic-models] No provider with modelDefinitionUrl in models.json — skipping");
    return;
  }

  await Promise.all(
    dynamicProviders.map(([providerName, providerConfig]) =>
      loadProvider(pi, providerName, providerConfig)
    )
  );

  if (providers.size === 0) {
    console.log("[dynamic-models] No dynamic providers registered — skipping context discovery");
    return;
  }

  // ── Phase 2: Discover context windows on first provider request ──────
  pi.on("before_provider_request", (event, ctx) => {
    const modelId = event.payload?.model;
    if (!modelId) return;

    for (const [providerName, providerState] of matchingProviders(event, ctx, modelId)) {
      const model = providerState.models.find((m) => m.id === modelId);
      if (!model) continue;

      const cached = contextWindowCache.get(model);
      if (cached) continue; // Already discovered

      // Avoid duplicate concurrent fetches for the same provider/model pair
      const fetchKey = `${providerName}\0${modelId}`;
      if (pendingFetches.has(fetchKey)) continue;
      pendingFetches.add(fetchKey);

      fetchContextWindow(providerName, model, modelId, pi).finally(() => {
        pendingFetches.delete(fetchKey);
      });
    }
  });
}

// ── Helpers ────────────────────────────────────────────────────────────

async function loadProvider(pi, providerName, providerConfig) {
  const { modelDefinitionUrl } = providerConfig;

  console.log(`[dynamic-models] ${providerName}: modelDefinitionUrl = ${modelDefinitionUrl}`);

  try {
    const response = await fetch(modelDefinitionUrl);
    if (!response.ok) {
      console.error(
        `[dynamic-models] ${providerName}: Failed to fetch models: ${response.status} ${response.statusText}`
      );
      return;
    }

    const data = await response.json();
    const models = transformModels(data.data || []);

    if (models.length === 0) {
      console.warn(
        `[dynamic-models] ${providerName}: No valid models found — keeping static models.json`
      );
      return;
    }

    providers.set(providerName, { models });

    registerProvider(pi, providerName, providerConfig, models);

    console.log(`[dynamic-models] ${providerName}: Registered ${models.length} models from ${modelDefinitionUrl}`);
  } catch (err) {
    console.error(
      `[dynamic-models] ${providerName}: Error loading models: ${err.message}`
    );
  }
}

function registerProvider(pi, providerName, providerConfig, models) {
  const providerOptions = { ...providerConfig };
  delete providerOptions.modelDefinitionUrl;
  delete providerOptions.models;

  pi.registerProvider(providerName, {
    ...providerOptions,
    models,
  });
}

function matchingProviders(event, ctx, modelId) {
  const providerName = getProviderName(event, ctx);

  if (providerName) {
    const providerState = providers.get(providerName);
    return providerState ? [[providerName, providerState]] : [];
  }

  return [...providers.entries()].filter(([, providerState]) =>
    providerState.models.some((model) => model.id === modelId)
  );
}

function getProviderName(event, ctx) {
  const candidates = [
    event.providerName,
    event.provider?.name,
    event.provider?.id,
    event.provider,
    event.payload?.providerName,
    event.payload?.provider?.name,
    event.payload?.provider?.id,
    event.payload?.provider,
    ctx?.providerName,
    ctx?.provider?.name,
    ctx?.provider?.id,
    ctx?.provider,
  ];

  return candidates.find((candidate) => typeof candidate === "string");
}

function readModelsConfig() {
  try {
    const raw = readFileSync(MODELS_PATH, "utf-8");
    return JSON.parse(stripJsonComments(raw));
  } catch (err) {
    console.warn(`[dynamic-models] Failed to read ${MODELS_PATH}: ${err.message}`);
    return null;
  }
}

function stripJsonComments(input) {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) =>
      match[0] === "\"" ? match : ""
    )
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) =>
      tail ?? (match[0] === "\"" ? match : "")
    );
}

function transformModels(rawModels) {
  return rawModels.map((m) => ({
    id: m.id,
    name: formatModelName(m.id),
    reasoning: true,
    input: (m.architecture?.input_modalities ?? ["text"]).filter(
      (modality) => modality === "text" || modality === "image"
    ),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  }));
}

function formatModelName(id) {
  // unsloth/Qwen3.6-35B-A3B-GGUF:Q6_K_XL → "Qwen3.6-35B-A3B (Q6_K_XL)"
  const parts = id.split(":");
  const base = parts[0].replace(/^.*\//, "");
  const quant = parts[1] || "";
  return quant ? `${base} (${quant})` : base;
}

async function fetchContextWindow(providerName, model, modelId, pi) {
  const config = readModelsConfig();
  const providerConfig = config?.providers?.[providerName];
  const baseUrl = providerConfig?.baseUrl;
  if (!baseUrl) {
    console.warn(`[dynamic-models] ${providerName}: No baseUrl configured for props fetch`);
    return;
  }

  const encoded = encodeURIComponent(model.id);
  const url = `${baseUrl.replace(/\/v1\/?$/, "")}/props?model=${encoded}&autoload=`;

  console.log(`[dynamic-models] ${providerName}: Fetching props for ${modelId}...`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROPS_TIMEOUT_MS);

  try {
    let response = await fetch(`${url}false`, { signal: controller.signal });

    // 400/404 = model not loaded on server yet → leave default, try later
    if (response.status === 400 || response.status === 404) {
      console.log(
        `[dynamic-models] ${providerName}: Model ${modelId} not loaded yet (${response.status}) — try to load model`
      );
      response = await fetch(`${url}true`, { signal: controller.signal });
    }

    if (!response.ok) {
      console.warn(
        `[dynamic-models] ${providerName}: Props fetch failed for ${url}: ${response.status} ${response.statusText}`
      );
      return;
    }

    const data = await response.json();
    const nCtx = data?.default_generation_settings?.n_ctx;
    console.warn(`[dynamic-models] ${providerName}: Given: ${nCtx}`);
    if (typeof nCtx === "number" && nCtx > 0) {
      model.contextWindow = nCtx;
      contextWindowCache.set(model, nCtx);

      // Update provider registry so UI picks up the new value
      registerProvider(pi, providerName, providerConfig, providers.get(providerName).models);

      console.log(`[dynamic-models] ${providerName}: Context window for ${modelId}: ${nCtx}`);
    } else {
      console.warn(
        `[dynamic-models] ${providerName}: No n_ctx in props response for ${modelId}: ${JSON.stringify(data).slice(0, 200)}`
      );
    }
  } catch (err) {
    if (err.name === "AbortError") {
      console.warn(`[dynamic-models] ${providerName}: Props fetch timed out for ${modelId}`);
    } else {
      console.warn(
        `[dynamic-models] ${providerName}: Failed to fetch props. ${err.message}`
      );
    }
  } finally {
    clearTimeout(timer);
  }
}
