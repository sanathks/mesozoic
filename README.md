# Meso

A runtime for AI agents. Each agent is a folder with a personality, memory, and tools.

## Get Started

```bash
npm install -g meso
meso init
```

## What It Does

- **Guardrails** — configurable safety per agent (off / permissive / standard / strict)
- **Memory** — agents remember, consolidate, and forget over time
- **Prompt Caching** — reduce cost and latency
- **Model Rotation** — automatic provider failover with cooldown

## Commands

```bash
meso init                # Full setup
meso new <agent>         # Create agent
meso configure <agent>   # Personality, guardrails, settings
meso start [agent]       # Start
meso stop [agent]        # Stop
meso restart [agent]     # Restart
meso status              # Running agents
meso logs <agent> -f     # Tail logs
meso login               # Connect model providers
meso upgrade [agent]     # Apply config updates
meso doctor <agent>      # Health check
meso run <agent> --tui   # Chat in terminal
```

## License

MIT
