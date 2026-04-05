# AGENTS.md

This repository is **Meso**, a generic agent runtime built on Pi.

## What this repo is

Meso provides:
- generic agent runtime
- channel runner layer
- TUI runner
- tool registry
- extension registry
- guardrails
- memory system
- agent scaffolding CLI

It is not a single hardcoded bot anymore.

## Agent model

Agents live outside the repo under:

```text
~/.meso/agents/<agent>/
```

Each agent owns its own:
- config
- prompt files
- tools
- memory
- sessions
- logs
- jobs
- local guardrail overrides

## Main runtime entrypoints

- `src/cli/main.ts` - Meso CLI
- `src/core/runtime.ts` - generic agent runtime
- `src/core/channel-runner.ts` - generic channel runner dispatcher
- `src/core/slack-runner.ts` - Slack channel implementation
- `src/core/tui-runner.ts` - generic TUI runner
- `src/dream.ts` - generic per-agent memory consolidation job

## Important runtime modules

- `src/core/agent-loader.ts`
- `src/core/storage.ts`
- `src/core/tool-registry.ts`
- `src/core/extension-registry.ts`
- `src/guardrails.ts`
- `src/db/memory-db.ts`
- `src/tools/memory.ts`
- `src/extract-memories.ts`

## Agent prompt model

Each agent config has:

```json
"prompts": {
  "identity": "IDENTITY.md",
  "soul": "SOUL.md",
  "extra": ["COMMS.md"]
}
```

Notes:
- `IDENTITY.md` and `SOUL.md` are the main prompt files
- `COMMS.md` should be included through `prompts.extra`
- additional domain/persona files can also go in `extra`

## Agent config

Main agent config file:

```text
~/.meso/agents/<agent>/agent.json
```

That file controls:
- models
- Slack env var names
- shared tool selection
- storage paths
- behavior
- guardrails

## Storage

Per-agent runtime state lives under:

```text
~/.meso/agents/<agent>/
```

Typical contents:
- `tools/`
- `sessions/`
- `logs/`
- `memory/`
- `memory.db`
- `jobs.json`
- `settings.json`
- `guardrails.local.json`

## Tools

There are two kinds of tools.

### Shared tools
Shared runtime tools belong in this repo under:

```text
src/tools/
```

### Agent-local tools
Agent-specific tools belong under:

```text
~/.meso/agents/<agent>/tools/
```

These files use Pi's extension mechanism under the hood, but in Meso the user-facing concept is **tools**.

Agent-local tool files can register:
- custom tools
- custom commands
- custom hooks

## Scheduler

Agents can also run a background scheduler process.

The scheduler combines:
- internal runtime jobs defined by Meso
- user jobs loaded from `jobs.json`

Internal jobs are not user-editable.
This is where dream/memory consolidation now lives.

## Guardrails

Repo-level guardrail policy:
- `guardrails.json`

Per-agent local override:
- `~/.meso/agents/<agent>/guardrails.local.json`

Machine-specific paths must stay in the local override, not in repo policy.

## CLI commands

```bash
meso new <agent>
meso list
meso run <agent> --channel
meso run <agent> --tui
```

`--slack` still exists as a compatibility alias, but `--channel` is the preferred interface.

## Production

The included pm2 config currently starts the default agent `rex` as:
- `meso-rex`
- `meso-rex-dream`

## If you are resuming work

Check these first:
1. `git log --oneline -12`
2. `src/cli/main.ts`
3. `src/core/runtime.ts`
4. `src/core/channel-runner.ts`
5. `src/core/slack-runner.ts`
5. `src/core/tui-runner.ts`
6. `src/guardrails.ts`
7. `src/config.ts`
8. `guardrails.json`
9. `~/.meso/agents/<agent>/agent.json`
10. `~/.meso/agents/<agent>/guardrails.local.json`

## Rule for future work

- runtime-generic logic belongs in the repo
- agent-specific state belongs under `~/.meso/agents/<agent>/`
- agent-specific tools should be implemented in `~/.meso/agents/<agent>/tools/`
- secrets must be referenced by env var name, never hardcoded
