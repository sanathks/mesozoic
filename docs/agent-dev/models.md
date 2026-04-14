# Managing Models

Models are configured in `agent.json` under `models.main` (fallback chain) and `models.side` (for guardrails).

## Current Config

Use `self status` to see configured models and which is active.

## Switch Model (Instant)

Use `self switch-model` with provider and model_id. Takes effect immediately, no restart.

## Add a Model

Use `self add-model` with provider and model_id. Adds to the fallback chain in agent.json.

## Remove a Model

Use `self remove-model` with provider and model_id. Cannot remove the last model.

## Available Providers

Common providers and their models:

```
anthropic:
  claude-sonnet-4-6
  claude-haiku-4-5
  claude-opus-4-6

openai-codex:
  gpt-5.4
  gpt-5.4-mini

google:
  gemini-2.5-pro
  gemini-2.5-flash

ollama (local):
  gemma4:e4b
  gemma4:e2b
  llama3
  (any model installed via `ollama pull`)

lm-studio (local):
  (models configured in ~/.meso/models.json)
```

Use `self list-models` to see all available models from authenticated providers.

## Model Rotation

When the primary model errors, the runtime automatically switches to the next model in `models.main` and puts the primary on a 1-hour cooldown. State persists across restarts in `.runtime/state.json`.

## Custom Providers

Add to `~/.meso/models.json`:

```json
{
  "providers": {
    "my-provider": {
      "baseUrl": "http://localhost:8000/v1",
      "api": "openai-completions",
      "apiKey": "MY_KEY",
      "models": [{ "id": "my-model" }]
    }
  }
}
```
