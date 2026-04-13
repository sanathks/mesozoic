#!/usr/bin/env node
import "dotenv/config";
import { defineCommand, runMain } from "citty";

const main = defineCommand({
  meta: { name: "meso", description: "Meso agent runtime" },
  subCommands: {
    init: defineCommand({
      meta: { description: "Full setup (deps, build, agent, start)" },
      async run() {
        const { runInit } = await import("./init.js");
        await runInit();
      },
    }),

    new: defineCommand({
      meta: { description: "Create a new agent" },
      args: { agent: { type: "positional", description: "Agent ID", required: true } },
      async run({ args }) {
        const { runNewAgentWizard } = await import("./new.js");
        await runNewAgentWizard(args.agent);
      },
    }),

    upgrade: defineCommand({
      meta: { description: "Upgrade agent config to latest schema" },
      args: { agent: { type: "positional", description: "Agent ID (optional, upgrades all if omitted)", required: false } },
      async run({ args }) {
        const { runUpgrade } = await import("./upgrade.js");
        await runUpgrade(args.agent);
      },
    }),

    configure: defineCommand({
      meta: { description: "Configure agent personality, style, and settings" },
      args: { agent: { type: "positional", description: "Agent ID", required: true } },
      async run({ args }) {
        const { runConfigure } = await import("./configure.js");
        await runConfigure(args.agent);
      },
    }),

    remove: defineCommand({
      meta: { description: "Remove an agent" },
      args: {
        agent: { type: "positional", description: "Agent ID", required: true },
        force: { type: "boolean", description: "Skip confirmation", default: false },
      },
      async run({ args }) {
        const { runRemoveAgent } = await import("./remove.js");
        await runRemoveAgent(args.agent, args.force);
      },
    }),

    list: defineCommand({
      meta: { description: "List all agents" },
      async run() {
        const { runListAgents } = await import("./list.js");
        runListAgents();
      },
    }),

    inspect: defineCommand({
      meta: { description: "Show agent config" },
      args: { agent: { type: "positional", description: "Agent ID", required: true } },
      async run({ args }) {
        const { runInspectAgent } = await import("./inspect.js");
        runInspectAgent(args.agent);
      },
    }),

    doctor: defineCommand({
      meta: { description: "Diagnose agent issues" },
      args: { agent: { type: "positional", description: "Agent ID", required: true } },
      async run({ args }) {
        const { runDoctor } = await import("./doctor.js");
        runDoctor(args.agent);
      },
    }),

    run: defineCommand({
      meta: { description: "Run an agent" },
      args: {
        agent: { type: "positional", description: "Agent ID", required: true },
        channel: { type: "boolean", description: "Run in channel mode (Slack/Discord/Telegram)" },
        slack: { type: "boolean", description: "Run in Slack channel mode" },
        tui: { type: "boolean", description: "Run in terminal UI mode" },
        voice: { type: "boolean", description: "Run in voice conversation mode" },
        provider: { type: "string", description: "Channel provider (slack, discord, telegram)" },
      },
      async run({ args }) {
        const { runAgent } = await import("./run.js");
        const mode = args.voice ? "voice" : args.tui ? "tui" : (args.channel || args.slack) ? "channel" : null;
        if (!mode) throw new Error("Specify --channel, --tui, or --voice");
        const provider = args.provider || (args.slack ? "slack" : undefined);
        await runAgent(args.agent, mode, provider as any);
      },
    }),

    start: defineCommand({
      meta: { description: "Start agent (default: all)" },
      args: { agent: { type: "positional", description: "Agent ID (optional)" } },
      async run({ args }) {
        // Check for outdated configs before starting
        const { checkNeedsUpgrade } = await import("./upgrade.js");
        const { listAgents } = await import("../core/agent-loader.js");
        const agents = args.agent ? [args.agent] : listAgents();
        const outdated = agents.filter(checkNeedsUpgrade);
        if (outdated.length > 0) {
          console.warn(`Warning: ${outdated.join(", ")} need config upgrade. Run: meso upgrade`);
        }

        const d = await import("../daemon/daemon.js");
        args.agent ? d.startAgent(args.agent) : d.startAll();
      },
    }),

    stop: defineCommand({
      meta: { description: "Stop agent (default: all)" },
      args: { agent: { type: "positional", description: "Agent ID (optional)" } },
      async run({ args }) {
        const d = await import("../daemon/daemon.js");
        args.agent ? d.stopAgent(args.agent) : d.stopAll();
      },
    }),

    restart: defineCommand({
      meta: { description: "Restart agent (default: all)" },
      args: { agent: { type: "positional", description: "Agent ID (optional)" } },
      async run({ args }) {
        const d = await import("../daemon/daemon.js");
        args.agent ? d.restartAgent(args.agent) : d.restartAll();
      },
    }),

    status: defineCommand({
      meta: { description: "Show process status" },
      async run() {
        const { printStatus } = await import("../daemon/daemon.js");
        printStatus();
      },
    }),

    setup: defineCommand({
      meta: { description: "Setup optional features" },
      subCommands: {
        voice: defineCommand({
          meta: { description: "Setup voice mode (models, mic, speaker)" },
          async run() {
            const { runSetupVoice } = await import("./setup-voice.js");
            await runSetupVoice();
          },
        }),
      },
    }),

    logs: defineCommand({
      meta: { description: "Tail agent logs" },
      args: {
        agent: { type: "positional", description: "Agent ID", required: true },
        follow: { type: "boolean", alias: "f", description: "Follow log output" },
      },
      async run({ args }) {
        const { runAgentLogs } = await import("./logs.js");
        runAgentLogs(args.agent, args.follow || false);
      },
    }),

    login: defineCommand({
      meta: { description: "Login to model provider" },
      args: { provider: { type: "positional", description: "Provider name", required: false } },
      async run({ args }) {
        const { runLogin } = await import("./auth.js");
        await runLogin(args.provider);
      },
    }),

    logout: defineCommand({
      meta: { description: "Logout from model provider" },
      args: { provider: { type: "positional", description: "Provider name", required: false } },
      async run({ args }) {
        const { runLogout } = await import("./auth.js");
        runLogout(args.provider);
      },
    }),

    whoami: defineCommand({
      meta: { description: "Show logged-in providers" },
      async run() {
        const { runWhoAmI } = await import("./auth.js");
        runWhoAmI();
      },
    }),
  },
});

runMain(main);
