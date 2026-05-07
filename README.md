# Router Model Extension

A model loader for the `llama.cpp` router mode, that automatically discovers and registers available models at startup from a remote model definition endpoint.

## Overview

This extension replaces the static `models` array in the `models.json` configuration with a dynamically fetched list of models it `modelDefinitionUrl` is set. 

It works in two phases:

1. **Startup** — Fetches a model definition JSON from a configurable URL (`modelDefinitionUrl`) and injects the discovered models into the provider registry.
2. **First use** — On the first request for each model, it queries the llama.cpp server's `/props` endpoint to discover the actual context window (`n_ctx`) for that model, then updates the provider registry so the UI reflects the correct value. If the model is not loaded, it loads the model automatically.

## Configuration

### 1. Register the extension

Add the extension path to `settings.json` under the `extensions` array:

```json
{
  "extensions": [
    "~/.pi/agent/extensions/router-model-extension"
  ]
}
```

### 2. Configure the `models.json` config

Add a `modelDefinitionUrl` field to the `llama-cpp` or whatever you named your provider in `models.json`:

```json
{
  "providers": {
    "llama-cpp": {
      "baseUrl": "http://127.0.0.1:28002/v1",
      "api": "openai-completions",
      "apiKey": "no",
      "compat": {
        "supportsDeveloperRole": true,
        "supportsReasoningEffort": true
      },
      "modelDefinitionUrl": "http://127.0.0.1:28002/v1/models"
    }
  }
}
```

### Required provider fields

| Field              | Description                                                        | File          |
|--------------------|--------------------------------------------------------------------|---------------|
| `modelDefinitionUrl` | URL to fetch the model definition JSON from (required)           | `models.json` |
| `baseUrl`            | Base URL of the llama.cpp server (required)                        | `models.json` |
| `apiKey`             | API key for the provider (optional, depending on your setup)       | `models.json` |
| `api`                | API compatibility mode (optional, e.g. `"openai"`)                 | `models.json` |
| `compat`             | Compatibility setting passed through to the provider (optional)    | `models.json` |

Only the `modelDefinitionUrl` is specific to this extension — all other fields are just forwarded.

## Model format

The extension expects the model definition URL to return JSON with a `data` array containing objects with at least an `id` field (e.g., `"unsloth/Qwen3.6-35B-A3B-GGUF:Q6_K_XL"`). These are transformed into Pi model objects with:

- `id`: the raw model ID
- `name`: formatted name (e.g., `"Qwen3.6-35B-A3B (Q6_K_XL)"`)
- `reasoning`: `true`
- `input`: `["text"]`
- `cost`: all zeros
- `contextWindow`: default `65536` (updated dynamically on first use)
