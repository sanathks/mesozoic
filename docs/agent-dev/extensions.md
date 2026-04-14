# Creating Extensions

Extensions hook into the agent lifecycle. They can register tools, commands, and intercept events.

## Minimal Extension

```typescript
export default function (pi) {
  // Runs on session start
  pi.on("session_start", async (event, ctx) => {
    ctx.ui.notify("Extension loaded!", "info");
  });
}
```

Save to: `~/.meso/agents/{your-id}/tools/my-extension.ts`

## Available Hooks

```typescript
pi.on("session_start", async (event, ctx) => { ... });
pi.on("tool_call", async (event, ctx) => {
  // Intercept/block tool calls
  if (event.toolName === "bash" && event.input.command.includes("rm")) {
    return { block: true, reason: "Blocked dangerous command" };
  }
});
pi.on("agent_start", async (event, ctx) => { ... });
pi.on("agent_end", async (event, ctx) => { ... });
pi.on("tool_execution_start", async (event, ctx) => { ... });
pi.on("tool_execution_end", async (event, ctx) => { ... });
```

## Register a Command

```typescript
export default function (pi) {
  pi.registerCommand("greet", {
    description: "Greet the user",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello, ${args || "world"}!`, "info");
    },
  });
}
```

## Dynamic Tool Registration

Tools can be registered at any time — in hooks, commands, or on load:

```typescript
export default function (pi) {
  pi.on("session_start", async () => {
    pi.registerTool({
      name: "dynamic_tool",
      label: "Dynamic",
      description: "A dynamically registered tool",
      parameters: Type.Object({ input: Type.String() }),
      async execute(_, params) {
        return { content: [{ type: "text", text: params.input.toUpperCase() }] };
      },
    });
  });
}
```

## After Creating

1. Write the file to your tools directory
2. Call `self reload` to load it
3. Extensions and their tools are available immediately
