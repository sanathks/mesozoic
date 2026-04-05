# Meso Concepts

## What Meso is

Meso is a generic agent runtime built on top of Pi.

The repo contains the shared runtime:
- CLI
- channel runner layer
- TUI runner
- memory system
- guardrails
- shared tools
- tool/extension loading

The channel runner layer chooses a provider such as Slack, Discord, or Telegram.
Provider-specific communication actions should be exposed as tools, not embedded into the scheduler.

## First-time setup flow

The main onboarding path is:

```bash
meso new <agent>
```

This command is an interactive wizard that can:
- create the agent scaffold
- configure basic options
- write agent-local env values to `.env`
- run login
- start pm2

## What an agent is

An agent is a local instance that lives outside the repo under:

```text
~/.meso/agents/<agent>/
```

Each agent has its own:
- `agent.json`
- prompt files
- `tools/`
- `.env`
- `sessions/`
- `logs/`
- `memory/`
- `jobs.json`
- local guardrail overrides

## Shared runtime vs agent-specific behavior

### Shared runtime
Belongs in this repo.
Examples:
- memory tool
- web search tool
- generic Slack integration
- generic TUI
- guardrails

### Agent-specific behavior
Belongs in the agent folder.
Examples:
- custom tools for one agent
- custom commands for one agent
- hooks that only one agent needs
- user-defined scheduled jobs in `jobs.json`

## Prompt model

Prompt config looks like:

```json
"prompts": {
  "identity": "IDENTITY.md",
  "soul": "SOUL.md",
  "extra": ["COMMS.md"]
}
```

Meaning:
- `IDENTITY.md` = who the agent is
- `SOUL.md` = deeper behavior and principles
- `extra` = extra prompt files layered on top

## Storage model

Shared auth still uses Pi auth under the hood:

```text
~/.pi/agent/auth.json
~/.pi/agent/models.json
```

Per-agent state lives in:

```text
~/.meso/agents/<agent>/
```

## Agent config

Main config file:

```text
~/.meso/agents/<agent>/agent.json
```

This controls:
- prompts
- models
- runners
- storage
- shared tool selection
- behavior
- guardrails

## Scheduler model

Each agent can have a background scheduler process.

The scheduler combines:
- internal runtime jobs defined by Meso
- user-defined jobs loaded from `jobs.json`

The scheduler also includes basic reliability protections:
- no overlapping scheduler ticks
- duplicate-run suppression per job
- timeout protection for scheduled runs

Internal jobs cannot be edited by the user.
This protects core maintenance tasks like dream/memory consolidation.

User jobs should be self-contained.
The scheduler only triggers the main agent with the saved prompt.
If a job needs to send something to a channel, that instruction should be inside the prompt and the agent should use the appropriate channel tool.
Provider-specific context is injected during interactive conversations using hidden context blocks such as `<slack_context>`.

Supported user schedule shapes currently include:
- daily at HH:MM
- selected weekdays at HH:MM
- one-time at an ISO timestamp
