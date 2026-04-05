import { createAuthStorage, createModelRegistry } from "./config.js";

async function main() {
  const auth = createAuthStorage();
  const registry = createModelRegistry(auth);
  const available = await registry.getAvailable();

  console.log("Available models:\n");
  for (const m of available) {
    console.log(`  ${m.provider}/${m.id}`);
  }
}

main();
