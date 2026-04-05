import "dotenv/config";
import { runChannelAgent } from "./core/channel-runner.js";
import { loadAgentEnvFile } from "./core/storage.js";

const agentId = process.env.MESO_AGENT_ID || process.env.MESO_DEFAULT_AGENT || "rex";
loadAgentEnvFile(agentId);

process.on("uncaughtException", (err) => {
  console.error("[meso] Uncaught exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[meso] Unhandled rejection:", err);
});

runChannelAgent(agentId).catch((err) => {
  console.error(`[meso] Failed to start channel agent ${agentId}:`, err);
  process.exit(1);
});
