# Skills

Meso supports Pi's native skills system.

## What a skill is

A skill is a self-contained capability package that the agent loads on demand.
A skill usually contains:
- `SKILL.md`
- helper scripts
- references/docs
- templates/assets

Skills are not the same as tools:
- **tools** are executable capabilities registered with the runtime
- **skills** are instruction packages and helper resources the model can load when relevant

## Agent-local skills

Each agent can define local skills in:

```text
~/.meso/agents/<agent>/skills/
```

Meso wires this into Pi through the agent-local `settings.json` file:

```json
{
  "skills": ["./skills"],
  "enableSkillCommands": true
}
```

## Structure

Example:

```text
skills/
  gmail/
    SKILL.md
    scripts/
    references/
```

Example `SKILL.md`:

```md
---
name: gmail
description: Read, search, and summarize Gmail messages. Use when working with inbox triage and email summaries.
---

# Gmail

## Setup

Run once before first use:

```bash
./scripts/setup.sh
```
```

## How Meso uses skills

Pi discovers skills from the configured paths in `settings.json`.
Only skill names and descriptions are always present in context.
When a task matches, the agent should read the full `SKILL.md` and follow it.

## Where skills work

Skills are available in:
- TUI mode
- channel mode
- scheduled runs

The best interactive UX for skills is in TUI, because Pi can also expose `/skill:name` commands there.
In Slack/channel runs, skill selection depends more on the model matching the skill description.

## Design rule

- put reusable executable integration code in `tools/`
- put workflow instructions, setup docs, and helper scripts in `skills/`
