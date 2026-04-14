# Creating Skills

Skills are prompt+tool bundles in a directory with a `SKILL.md` file.

## Minimal Skill

```
~/.meso/agents/{your-id}/skills/
  summarize/
    SKILL.md
```

### SKILL.md

```markdown
---
name: summarize
description: Summarize text or documents into concise bullet points.
---

# Summarize

When asked to summarize content:
1. Read the full content
2. Extract key points
3. Present as concise bullet points (max 5-7)
4. Include the most important details only
```

## Skill with Scripts

```
my-skill/
  SKILL.md
  scripts/
    fetch-data.sh
  references/
    api-docs.md
```

The agent can read files in the skill directory for reference.

## SKILL.md Frontmatter

```yaml
---
name: my-skill              # must match directory name, lowercase a-z 0-9 hyphens
description: What it does    # max 1024 chars, be specific
license: MIT                 # optional
---
```

## Rules

- Name must match parent directory
- Lowercase letters, numbers, hyphens only
- Skills are discovered on startup and after `self reload`
- Description appears in system prompt so the LLM knows when to use it
- Keep SKILL.md focused — the agent reads it when the skill is invoked

## After Creating

1. Create the directory in your skills folder
2. Write SKILL.md with frontmatter
3. Call `self reload` to discover it
