# Meso

Run AI agents that live on Slack, remember conversations, and use tools — all from a single config file.

```bash
npm install -g mesozoic
meso init
```

## How It Works

Each agent is a folder. You define its personality in markdown, configure models and safety rules in JSON, and drop custom tools into a directory. Meso handles the rest.

```
~/.meso/agents/rex/
  IDENTITY.md       ← who the agent is
  SOUL.md           ← core values
  agent.json        ← models, behavior, guardrails
  tools/            ← custom tools (auto-loaded)
  skills/           ← reusable prompt+tool bundles
  memory/           ← agent remembers over time
```

No Docker. No database. Just Node.

## Features

**Memory** — agents save, search, and consolidate knowledge. A nightly dream job prunes stale memories and reinforces important ones.

**Guardrails** — four safety modes (off / permissive / standard / strict). Block dangerous commands, protect secrets, scope file access — all configurable per agent.

**Model Rotation** — define a fallback chain of models across providers. If one fails, the agent switches automatically and waits before retrying.

**Prompt Caching** — static system prompts stay cached across conversations. Memory is injected per-session, not baked into the cache-busting path.

## Commands

```bash
meso init                # Setup from scratch
meso new <agent>         # Create agent
meso configure <agent>   # Personality, guardrails, settings
meso start [agent]       # Start
meso stop [agent]        # Stop
meso restart [agent]     # Restart
meso status              # Running agents
meso logs <agent> -f     # Tail logs
meso login               # Connect model providers
meso run <agent> --tui   # Chat in terminal
```

## Built On

Core agent engine powered by [Pi](https://github.com/mariozechner/pi-coding-agent) — sessions, streaming, tool execution, and model providers.

## License

MIT
