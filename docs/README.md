# Meso Docs

This folder explains the core concepts behind Meso.

## Recommended onboarding

Start with:

```bash
meso new <agent>
```

This is the interactive setup wizard.
It can also write an agent-local `.env`, run login, and start pm2.

## Docs

- [concepts.md](./concepts.md) - runtime model, agent layout, setup flow, config, storage, scheduler
- [tools.md](./tools.md) - how shared tools and agent-local tools work
- [scheduler.md](./scheduler.md) - scheduler responsibilities, execution model, reliability
- [channels.md](./channels.md) - channel runners, channel tools, provider context
- [jobs.md](./jobs.md) - prompt-first job design, schedule shapes, examples
- [skills.md](./skills.md) - Pi-native skills in agent-local `skills/` directories
- `meso doctor <agent>` - check env, pm2 wiring, and common process issues
