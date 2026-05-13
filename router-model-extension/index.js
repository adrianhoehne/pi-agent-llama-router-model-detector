/**
 * Dynamic Model Loader for llama-cpp provider
 *
 * Reads modelDefinitionUrl from models.json provider config.
 * Fetches available models at startup, injects them into the provider.
 * Discovers context windows via before_provider_request hook on first use.
 *
 * All other provider config (baseUrl, api, apiKey, compat) comes from
 * models.json — only the models array is replaced dynamically.
 */

import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_PATH = resolve(__dirname, "../../models.json");

const DEFAULT_CONTEXT_WINDOW = 65536;
const PROPS_TIMEOUT_MS = 120_000; // 2 minutes for router mode
const PROVIDER_NAME = "llama-cpp";

let currentModels = [];
const contextWindowCache = new WeakMap();
const pendingFetches = new Set(); // avoid duplicate concurrent fetches

export default async function (pi) {
  console.log("[dynamic-models] Extension loaded");

  const config = readModelsConfig();
  if (!config) {
    console.log("[dynamic-models] No models.json or provider config found — skipping");
    return;
  }

  const providerConfig = config.providers?.[PROVIDER_NAME];
  if (!providerConfig) {
    console.log(`[dynamic-models] No "${PROVIDER_NAME}" provider in models.json — skipping`);
    return;
  }

  const modelDefinitionUrl = providerConfig.modelDefinitionUrl;
  if (!modelDefinitionUrl) {
    console.log("[dynamic-models] No modelDefinitionUrl in provider config — skipping");
    return;
  }

  console.log(`[dynamic-models] modelDefinitionUrl = ${modelDefinitionUrl}`);

  try {
    const response = await fetch(modelDefinitionUrl);
    if (!response.ok) {
      console.error(
        `[dynamic-models] Failed to fetch models: ${response.status} ${response.statusText}`
      );
      return;
    }

    const data = await response.json();
    const models = transformModels(data.data || []);

    if (models.length === 0) {
      console.warn(
        "[dynamic-models] No valid models found — keeping static models.json"
      );
      return;
    }

    currentModels = models;

    pi.registerProvider(PROVIDER_NAME, {
      baseUrl: providerConfig.baseUrl,
      apiKey: providerConfig.apiKey,
      api: providerConfig.api,
      models,
      compat: providerConfig.compat,
    });

    console.log(`[dynamic-models] Registered ${models.length} models from ${modelDefinitionUrl}`);
  } catch (err) {
    console.error(
      `[dynamic-models] Error loading models: ${err.message}`
    );
  }

  // ── Phase 2: Discover context windows on first provider request ──────
  pi.on("before_provider_request", (event, _ctx) => {
    const modelId = event.payload?.model;
    if (!modelId) return;

    const model = currentModels.find((m) => m.id === modelId);
    if (!model) return;

    const cached = contextWindowCache.get(model);
    if (cached) return; // Already discovered

    // Avoid duplicate concurrent fetches for the same model
    if (pendingFetches.has(modelId)) return;
    pendingFetches.add(modelId);

    fetchContextWindow(model, modelId, pi).finally(() => {
      pendingFetches.delete(modelId);
    });
  });
}

// ── Helpers ────────────────────────────────────────────────────────────

function readModelsConfig() {
  try {
    const raw = readFileSync(MODELS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
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

async function fetchContextWindow(model, modelId, pi) {
  const config = readModelsConfig();
  const baseUrl = config?.providers?.[PROVIDER_NAME]?.baseUrl;
  const encoded = encodeURIComponent(model.id);
  const url = `${baseUrl.replace("/v1", "")}/props?model=${encoded}&autoload=`;

  console.log(`[dynamic-models] Fetching props for ${modelId}...`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROPS_TIMEOUT_MS);

  try {
    var response = await fetch(`${url}false`, { signal: controller.signal });

    // 400/404 = model not loaded on server yet → leave default, try later
    if (response.status === 400 || response.status === 404) {
      console.log(
        `[dynamic-models] Model ${modelId} not loaded yet (${response.status}) — try to load model`
      );
      response = await fetch(`${url}true`, { signal: controller.signal });
    }

    if (!response.ok) {
      console.warn(
        `[dynamic-models] Props fetch failed for ${url}: ${response.status} ${response.statusText}`
      );
      return;
    }

    const data = await response.json();
    const nCtx =
      data?.default_generation_settings?.n_ctx;
      console.warn(`[dynamic-models] Given: ${nCtx}`);
    if (typeof nCtx === "number" && nCtx > 0) {
      model.contextWindow = nCtx;
      contextWindowCache.set(model, nCtx);

      // Update provider registry so UI picks up the new value
      pi.registerProvider(PROVIDER_NAME, {
        baseUrl: config.providers[PROVIDER_NAME].baseUrl,
        apiKey: config.providers[PROVIDER_NAME].apiKey,
        api: config.providers[PROVIDER_NAME].api,
        models: currentModels,
        compat: config.providers[PROVIDER_NAME].compat,
      });

      console.log(`[dynamic-models] Context window for ${modelId}: ${nCtx}`);
    } else {
      console.warn(
        `[dynamic-models] No n_ctx in props response for ${modelId}: ${JSON.stringify(data).slice(0, 200)}`
      );
    }
  } catch (err) {
    if (err.name === "AbortError") {
      console.warn(`[dynamic-models] Props fetch timed out for ${modelId}`);
    } else {
      console.warn(
        `[dynamic-models] Failed to fetch props. ${err.message}`
      );
    }
  } finally {
    clearTimeout(timer);
  }
}
