import { runDreamJob } from "./core/dream-job.js";

const agentId = process.env.MESO_AGENT_ID || process.env.MESO_DEFAULT_AGENT || "rex";

runDreamJob(agentId).catch((e) => {
  console.error(`[dream:${agentId}] fatal:`, e);
  process.exit(1);
});
