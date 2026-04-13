# Meso

Run AI agents that live on Slack, remember conversations, and use tools — all from a single config file.

Built on [Pi](https://github.com/mariozechner/pi-coding-agent).

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

**Voice Mode** — talk to your agent in real-time. Local STT (Moonshine) and TTS (Kokoro) with Smart Turn detection and echo cancellation for natural conversations.

## Quick Start

```bash
# Install
npm install -g mesozoic

# Full guided setup (creates agent, connects providers)
meso init

# Or step by step
meso new rex
meso login
meso start rex
```

## Voice Mode

Talk to your agent instead of typing.

```bash
# One-time setup (downloads ~1GB of local models)
meso setup voice

# Start a voice conversation
meso run rex --voice
```

Voice mode runs STT and TTS locally — only the LLM uses your configured cloud model. Includes Smart Turn v3 for natural turn detection and WebRTC echo cancellation for barge-in (interrupt the agent mid-sentence).

## Commands

```bash
# Setup
meso init                # Full guided setup
meso new <agent>         # Create agent
meso configure <agent>   # Personality, guardrails, settings
meso setup voice         # Setup voice mode (models, mic, speaker)

# Running
meso start [agent]       # Start agent (background)
meso stop [agent]        # Stop
meso restart [agent]     # Restart
meso status              # Running agents
meso run <agent> --tui   # Chat in terminal
meso run <agent> --voice # Voice conversation

# Management
meso logs <agent> -f     # Tail logs
meso login               # Connect model providers
meso upgrade [agent]     # Apply config updates
meso doctor <agent>      # Health check
```

## Agent Configuration

Everything lives in `agent.json`:

```json
{
  "name": "Rex",
  "models": {
    "main": [
      { "provider": "anthropic", "id": "claude-sonnet-4-6" },
      { "provider": "openai-codex", "id": "gpt-5.4" }
    ]
  },
  "behavior": {
    "stopWord": "stop",
    "continuousDmSession": true
  },
  "runtime": {
    "thinking": "off",
    "compaction": { "enabled": true }
  }
}
```

Personality in markdown:

```markdown
# IDENTITY.md
You are Rex, a coding assistant that lives on Slack.

# SOUL.md
- be useful
- be concise
- use tools when needed
```

Guardrails in `guardrails.local.json`:

```json
{
  "mode": "standard",
  "blockedCommands": ["rm -rf /"],
  "allowedPaths": ["/Users/me/projects"]
}
```

## License

MIT
