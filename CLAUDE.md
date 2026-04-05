# Meso

Meso is an agent runtime that lets you create and run AI agents on Slack. Each agent has its own personality, memory, tools, and safety guardrails.

## Commands

```bash
meso init                # Setup everything from scratch
meso new <agent>         # Create a new agent
meso configure <agent>   # Set personality, style, guardrails
meso start [agent]       # Start (or all agents)
meso stop [agent]        # Stop
meso restart [agent]     # Restart
meso status              # Running processes
meso logs <agent> -f     # Tail logs
meso upgrade [agent]     # Apply config updates after meso update
meso login               # Connect model providers (Anthropic, OpenAI, etc.)
meso doctor <agent>      # Health check
meso run <agent> --tui   # Chat in terminal
```

## Agent Files

Each agent lives in `~/.meso/agents/{name}/`:

```
agent.json              # All settings — models, behavior, runtime config
.env                    # Secrets (Slack tokens, API keys)
IDENTITY.md             # Who the agent is
SOUL.md                 # Core values
COMMS.md                # Communication style
guardrails.local.json   # Safety rules
jobs.json               # Scheduled tasks
sessions/               # Conversation history
logs/                   # Process logs
memory/                 # Agent memory (MEMORY.md, daily logs, search index)
events/                 # Scheduled events
skills/                 # Custom skills
tools/                  # Custom tools
.runtime/               # System internals (auto-managed)
```

## How It Works

### Models

`agent.json` → `models.main` is an ordered list. If the primary model errors, meso switches to the next one and waits 1 hour before retrying the primary. State survives restarts.

Slack commands: `switch model`, `current model`.

### Guardrails

Four modes in `guardrails.local.json`:

- **off** — no restrictions
- **permissive** — blocks only catastrophic commands and secret reads
- **standard** — blocklist + safe whitelist, no model overhead (default)
- **strict** — unknown commands checked by a side model before running

`.env` files are always blocked from reading (except in off mode).

Set via `meso configure <agent>` or edit the file directly.

### Memory

Agents remember things across conversations:
- `memory/MEMORY.md` — long-term curated knowledge
- `memory/memory-YYYY-MM-DD.md` — daily logs
- `memory/memory.db` — search index

The dream job consolidates daily logs into MEMORY.md periodically.

### Process Management

`meso start` runs a lightweight supervisor per agent (no PM2 needed). It handles:
- Auto-restart on crash (exponential backoff)
- Memory limit enforcement
- Log rotation (10MB/file, 7 retained, compressed)
- Clean shutdown

### Auth

`meso login` connects to model providers via OAuth. Credentials stored at `~/.meso/auth.json`, shared across all agents.

### Config Upgrades

When meso updates add new config fields, `meso upgrade` applies them to existing agents without overwriting your changes.

## Development

```
src/
  cli/               # Commands (citty + clack)
  core/              # Runtime (session, Slack, storage, tools)
  daemon/            # Process supervisor
  tools/             # Agent tools (memory, search, scheduler)
  types/             # TypeScript types
  db/                # SQLite memory store
  guardrails.ts      # Command safety
  config.ts          # Model/auth resolution
  agent-factory.ts   # System prompt + guardrail extension
```

```bash
npm run build        # Build with tsup
npm run dev          # Dev mode with watch
```

### Slack Runner Notes

- Socket Mode (websocket) with Slack Assistant API for DMs
- Kills stale processes on startup to prevent event stealing
- Pong timeout patched to 15s (Bolt default 5s causes false disconnects)
- Catches Bolt's unhandled rejection bug in reconnect path
- Graceful shutdown closes socket cleanly so Slack stops routing to dead connections

### Adding Config Migrations

1. Bump `CURRENT_CONFIG_VERSION` in `src/cli/upgrade.ts`
2. Add migration to the `migrations` array
3. Rule: add missing fields, never overwrite user values
