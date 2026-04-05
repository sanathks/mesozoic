import fs from "node:fs";
import * as p from "@clack/prompts";
import { getAgentRoot } from "../core/storage.js";
import { stopAgent } from "../daemon/daemon.js";

export async function runRemoveAgent(agentId: string, force = false): Promise<void> {
  const root = getAgentRoot(agentId);
  if (!fs.existsSync(root)) {
    throw new Error(`[meso] Agent not found: ${agentId}`);
  }

  if (!force) {
    const confirm = await p.text({
      message: `Type '${agentId}' to confirm removal (deletes all files and stops processes)`,
    });
    if (p.isCancel(confirm) || confirm !== agentId) {
      p.cancel("Cancelled.");
      return;
    }
  }

  stopAgent(agentId);
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`Removed agent ${agentId}`);
}
