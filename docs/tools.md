# Tools in Meso

## Two kinds of tools

### 1. Shared runtime tools
These live in the Meso repo under:

```text
src/tools/
```

Examples:
- memory
- search

These are generic and reusable across many agents.

## 2. Agent-local tools
These live in the agent folder under:

```text
~/.meso/agents/<agent>/tools/
```

This is where you put agent-specific capabilities.

## Important implementation detail

The `tools/` folder uses Pi's extension mechanism under the hood.

That means files in an agent's `tools/` folder can register:
- custom tools
- custom commands
- custom hooks

So the user-facing concept is **tools**, even though Pi internally loads them as extensions.

## When to put something in shared runtime
Put a tool in the Meso repo when:
- it is generic
- multiple agents should use it
- it belongs to the framework

## When to put something in an agent tools folder
Put it in `~/.meso/agents/<agent>/tools/` when:
- it is specific to one agent
- it depends on one user's workflow
- it should not be part of the shared runtime

## Example agent-local tool file

A tool file in the agent `tools/` folder is just a Pi extension file.

Example shape:

```ts
import { Type } from "@sinclair/typebox";

export default function (pi: any) {
  pi.registerTool({
    name: "hello_tool",
    label: "Hello Tool",
    description: "Example agent-local tool",
    parameters: Type.Object({
      name: Type.String(),
    }),
    async execute(_toolCallId: string, params: { name: string }) {
      return {
        content: [{ type: "text", text: `Hello ${params.name}` }],
        details: {},
      };
    },
  });
}
```

Save that under:

```text
~/.meso/agents/rex/tools/hello-tool.ts
```

and Meso will load it for that agent.

## Channel tools

Communication channels should also be modeled as tools.

For example:
- `slack_post_message`
- future `discord_post_message`
- future `telegram_send_message`
- future email/webhook/chat tools

The scheduler should not directly send messages.
Instead, it triggers the main agent with a self-contained job prompt, and the agent chooses the appropriate channel tool.

This means the channel layer is extensible without changing scheduler behavior.

For scheduled jobs, Meso also provides management tools like:
- `schedule_job`
- `list_jobs`
- `pause_job`
- `resume_job`
- `remove_job`

## Skills vs tools

Meso also supports Pi-native agent skills.
Use:
- `tools/` for runtime-callable extensions, tools, hooks, and commands
- `skills/` for on-demand capability packages with `SKILL.md`, scripts, and references

## Design rule

- shared tool -> repo
- agent-specific tool -> agent `tools/` folder
- agent-specific skill -> agent `skills/` folder
