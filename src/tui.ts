import "dotenv/config";
import { runTuiAgent } from "./core/tui-runner.js";
import { loadAgentEnvFile } from "./core/storage.js";

const agentId = process.env.MESO_AGENT_ID || process.env.MESO_DEFAULT_AGENT || "rex";
loadAgentEnvFile(agentId);

runTuiAgent(agentId).catch((err) => {
  console.error(`[meso] Failed to start TUI agent ${agentId}:`, err);
  process.exit(1);
});
