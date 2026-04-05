import { createGuardrailExtension } from "../agent-factory.js";

const EXTENSION_REGISTRY: Record<string, () => any> = {
  guardrails: createGuardrailExtension,
};

export function resolveExtensionFactories(names: string[] = []): Array<() => any> {
  return names
    .map((name) => EXTENSION_REGISTRY[name])
    .filter(Boolean)
    .filter((factory, index, arr) => arr.indexOf(factory) === index);
}
