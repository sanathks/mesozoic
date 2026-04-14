# Agent Config Reference

All config lives in `~/.meso/agents/{id}/agent.json`.

## Full Schema

```json
{
  "configVersion": 1,
  "id": "rex",
  "name": "Rex",
  "description": "Personal coding agent",

  "prompts": {
    "identity": "IDENTITY.md",
    "soul": "SOUL.md",
    "extra": ["COMMS.md"]
  },

  "models": {
    "main": [
      { "provider": "anthropic", "id": "claude-sonnet-4-6" },
      { "provider": "openai-codex", "id": "gpt-5.4" }
    ],
    "side": { "provider": "openai-codex", "id": "gpt-5.4-mini" }
  },

  "runners": {
    "slack": {
      "enabled": true,
      "botTokenEnv": "SLACK_BOT_TOKEN",
      "appTokenEnv": "SLACK_APP_TOKEN",
      "signingSecretEnv": "SLACK_SIGNING_SECRET",
      "mode": "assistant"
    },
    "tui": { "enabled": true }
  },

  "tools": { "enabled": ["memory", "search"] },
  "extensions": { "enabled": ["guardrails"] },

  "memory": { "enabled": true, "maxRelevantItems": 8 },

  "guardrails": {
    "enabled": true,
    "projectConfig": "__RUNTIME__/guardrails.json",
    "localConfig": "guardrails.local.json"
  },

  "behavior": {
    "progressUpdates": "single-message",
    "stopWord": "stop",
    "continuousDmSession": true
  },

  "runtime": {
    "thinking": "off",
    "compaction": { "enabled": true, "reserveTokens": 16384, "keepRecentTokens": 20000 },
    "retry": { "enabled": true, "maxRetries": 3, "baseDelayMs": 2000, "maxDelayMs": 60000 }
  }
}
```

## Key Fields

- `models.main` — fallback chain, first model is primary
- `models.side` — used for guardrails classification (strict mode only)
- `behavior.stopWord` — user types this to abort
- `behavior.continuousDmSession` — DMs share one session per channel (true) or per thread (false)
- `runtime.thinking` — extended thinking: off, low, medium, high
- `runtime.compaction` — auto-compress long conversations

## File Locations

```
~/.meso/agents/{id}/
  agent.json           ← this file
  IDENTITY.md          ← personality
  SOUL.md              ← values
  COMMS.md             ← communication style
  guardrails.local.json ← safety rules
  jobs.json            ← scheduled jobs
  tools/               ← custom tools (auto-loaded)
  skills/              ← custom skills
  memory/              ← MEMORY.md + daily logs + memory.db
  .runtime/            ← system files (don't edit)
```

## Modifying Config

Use the `self` tool to change models. For other config changes, use `write` or `edit` tools to modify agent.json directly, then call `self reload`.

Note: Some changes (like runner config, prompts) require a full restart via `meso restart {id}`.
