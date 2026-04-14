# Creating Tools

Write a `.ts` file in your tools directory as a Pi extension that registers tools.

## Minimal Example

```typescript
import { Type } from "@sinclair/typebox";

export default function (pi) {
  pi.registerTool({
    name: "hello",
    label: "Hello",
    description: "Says hello to someone",
    parameters: Type.Object({
      name: Type.String({ description: "Person to greet" }),
    }),
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: `Hello, ${params.name}!` }] };
    },
  });
}
```

Save to: `~/.meso/agents/{your-id}/tools/hello.ts`
Then call: `self reload`

## Parameter Types

```typescript
Type.String({ description: "..." })
Type.Number({ description: "..." })
Type.Boolean()
Type.Optional(Type.String())
Type.Array(Type.String())
Type.Union([Type.Literal("a"), Type.Literal("b")])
```

## Returning Results

```typescript
return {
  content: [{ type: "text", text: "result text" }],
  details: { any: "metadata" },  // optional
};
```

## Tool with Network Request

```typescript
export default function (pi) {
  pi.registerTool({
    name: "fetch_url",
    label: "Fetch URL",
    description: "Fetch a URL and return the body",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
    }),
    async execute(_toolCallId, params) {
      const res = await fetch(params.url);
      const text = await res.text();
      return { content: [{ type: "text", text: text.slice(0, 5000) }] };
    },
  });
}
```

## Multiple Tools in One File

```typescript
export default function (pi) {
  pi.registerTool({ name: "tool_a", ... });
  pi.registerTool({ name: "tool_b", ... });
}
```

## After Creating

1. Write the file to your tools directory
2. Call `self reload` to load it
3. The tool is immediately available — no restart needed
