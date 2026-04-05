import "dotenv/config";
import { execSync } from "node:child_process";
import { App, Assistant } from "@slack/bolt";
import { loadAgent } from "./agent-loader.js";
import { createAgentRuntime, type AgentRuntime } from "./runtime.js";
import { buildChannelContextBlock } from "./channel-context.js";
import { appendChannelLog } from "./channel-log.js";

/**
 * Kill any stale processes running the same Slack bot. Slack's Socket Mode
 * load-balances events across ALL active connections for the same app token,
 * so duplicate processes silently steal events from the primary one.
 */
function killStaleSlackProcesses(agentId: string): void {
  try {
    const myPid = process.pid;
    const result = execSync(
      `ps ax -o pid=,command= | grep -E 'node.*run\\s+${agentId}.*--(channel|slack)' | grep -v grep`,
      { encoding: "utf-8" },
    ).trim();
    if (!result) return;
    for (const line of result.split("\n")) {
      const pid = parseInt(line.trim().split(/\s+/)[0], 10);
      if (pid && pid !== myPid) {
        try {
          process.kill(pid, "SIGTERM");
          console.log(`[meso:${agentId}] Killed stale process pid=${pid}`);
        } catch {}
      }
    }
  } catch {}
}

export async function runSlackChannel(agentId: string): Promise<void> {
  const agent = loadAgent(agentId);
  const slack = agent.config.runners?.slack;
  if (!slack?.enabled) throw new Error(`[meso] Slack channel provider not enabled for agent ${agentId}`);

  killStaleSlackProcesses(agentId);

  const botToken = process.env[slack.botTokenEnv];
  const appToken = process.env[slack.appTokenEnv];
  const signingSecret = slack.signingSecretEnv ? process.env[slack.signingSecretEnv] : undefined;
  if (!botToken || !appToken) {
    throw new Error(`[meso] Missing Slack env vars for ${agentId}: ${slack.botTokenEnv}, ${slack.appTokenEnv}`);
  }

  // Bolt's SocketModeClient has an unhandled promise rejection in its reconnect
  // path (delayReconnectAttempt calls cb.apply(this).then(res) with no .catch()).
  // Node 24 kills the process on unhandled rejections, causing silent restarts.
  process.on("unhandledRejection", (reason) => {
    console.error(`[meso:${agentId}] Unhandled rejection (kept alive):`, reason instanceof Error ? reason.stack || reason.message : reason);
  });

  const app = new App({
    token: botToken,
    appToken,
    signingSecret,
    socketMode: true,
  });

  // Increase ping/pong timeouts — Bolt's SocketModeReceiver doesn't expose these,
  // so we patch the SocketModeClient after creation. Default 5000ms is too tight;
  // GC pauses or network jitter trigger unnecessary disconnects and reconnect storms.
  const socketClient = (app as any).receiver?.client;
  if (socketClient) {
    socketClient.clientPingTimeoutMS = 15_000;
    socketClient.serverPingTimeoutMS = 60_000;
  }
  let reconnectTimer: NodeJS.Timeout | undefined;
  let socketWatchdogTimer: NodeJS.Timeout | undefined;
  const reconnectDeadlineMs = 45_000;
  const reconnectWindowMs = 10 * 60_000;
  const reconnectBurstLimit = 4;
  const reconnectEvents: number[] = [];
  let lastSocketConnectedAt = 0;
  let lastSlackIngressAt = 0;

  const clearReconnectTimer = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  };

  const armReconnectTimer = (reason: string) => {
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      console.error(`[meso:${agentId}] Slack socket unhealthy (${reason}) for ${reconnectDeadlineMs}ms. Exiting for restart.`);
      process.exit(1);
    }, reconnectDeadlineMs);
  };

  const recordReconnectEvent = (reason: string) => {
    const now = Date.now();
    reconnectEvents.push(now);
    while (reconnectEvents.length && now - reconnectEvents[0] > reconnectWindowMs) {
      reconnectEvents.shift();
    }
    console.warn(
      `[meso:${agentId}] Slack reconnect event=${reason} count=${reconnectEvents.length} windowMs=${reconnectWindowMs}`,
    );
    if (reconnectEvents.length >= reconnectBurstLimit) {
      console.error(
        `[meso:${agentId}] Slack reconnect burst detected (${reconnectEvents.length} events/${reconnectWindowMs}ms). Exiting for restart.`,
      );
      process.exit(1);
    }
  };

  const clearSocketWatchdog = () => {
    if (socketWatchdogTimer) {
      clearTimeout(socketWatchdogTimer);
      socketWatchdogTimer = undefined;
    }
  };

  const armSocketWatchdog = () => {
    clearSocketWatchdog();
    socketWatchdogTimer = setInterval(() => {
      const now = Date.now();
      const connectedForMs = lastSocketConnectedAt ? now - lastSocketConnectedAt : 0;
      const ingressIdleMs = lastSlackIngressAt ? now - lastSlackIngressAt : -1;
      if (lastSocketConnectedAt && connectedForMs > 5 * 60_000 && lastSlackIngressAt && ingressIdleMs > 20 * 60_000 && reconnectEvents.length > 0) {
        console.error(
          `[meso:${agentId}] Slack socket appears stale: connectedForMs=${connectedForMs} ingressIdleMs=${ingressIdleMs} reconnectCount=${reconnectEvents.length}. Exiting for restart.`,
        );
        process.exit(1);
      }
    }, 30_000);
  };

  if (socketClient?.on) {
    socketClient.on("ws_message", (data: Buffer | string, isBinary: boolean) => {
      if (isBinary) {
        console.log(`[meso:${agentId}] socket ws_message binary=true`);
        return;
      }
      try {
        const raw = data.toString();
        const parsed = JSON.parse(raw);
        console.log(
          `[meso:${agentId}] socket ws_message type=${parsed?.type || ""} envelope_id=${parsed?.envelope_id || ""} accepts_response_payload=${parsed?.accepts_response_payload || false}`,
        );
      } catch {
        console.log(`[meso:${agentId}] socket ws_message non-json`);
      }
    });
    socketClient.on("slack_event", (args: any) => {
      const body = args?.body;
      const eventType = body?.event?.type || body?.type || "unknown";
      const eventSubtype = body?.event?.subtype || "";
      const channel = body?.event?.channel || body?.channel || "";
      const ts = body?.event?.ts || body?.event_time || "";
      const threadTs = body?.event?.thread_ts || "";
      console.log(
        `[meso:${agentId}] socket slack_event eventType=${eventType} subtype=${eventSubtype} channel=${channel} ts=${ts} thread_ts=${threadTs}`,
      );
    });
    socketClient.on("connecting", () => {
      console.log(`[meso:${agentId}] Slack socket connecting`);
    });
    socketClient.on("authenticated", () => {
      console.log(`[meso:${agentId}] Slack socket authenticated`);
      clearReconnectTimer();
    });
    socketClient.on("connected", () => {
      lastSocketConnectedAt = Date.now();
      console.log(`[meso:${agentId}] Slack socket connected at=${new Date(lastSocketConnectedAt).toISOString()}`);
      clearReconnectTimer();
      armSocketWatchdog();
    });
    socketClient.on("reconnecting", () => {
      console.warn(`[meso:${agentId}] Slack socket reconnecting`);
      recordReconnectEvent("reconnecting");
      armReconnectTimer("reconnecting");
    });
    socketClient.on("disconnected", () => {
      console.warn(`[meso:${agentId}] Slack socket disconnected`);
      recordReconnectEvent("disconnected");
      armReconnectTimer("disconnected");
    });
    socketClient.on("error", (error: unknown) => {
      console.error(`[meso:${agentId}] Slack socket error:`, error instanceof Error ? error.stack || error.message : error);
    });
    socketClient.on("close", (...args: unknown[]) => {
      console.warn(`[meso:${agentId}] Slack socket close event`, args);
      recordReconnectEvent("close");
      armReconnectTimer("close");
    });
    socketClient.on("hello", (...args: unknown[]) => {
      console.log(`[meso:${agentId}] Slack socket hello`, args);
    });
  }

  app.use(async (args) => {
    const payload = (args as any).payload;
    const body = (args as any).body;
    const event = (args as any).event;
    const type = payload?.type || event?.type || body?.type || "unknown";
    const channel = payload?.channel || event?.channel || payload?.item?.channel || "";
    const ts = payload?.ts || event?.ts || payload?.event_ts || "";
    const threadTs = payload?.thread_ts || event?.thread_ts || "";
    const subtype = payload?.subtype || event?.subtype || "";
    console.log(
      `[meso:${agentId}] bolt inbound type=${type} channel=${channel} ts=${ts} thread_ts=${threadTs} subtype=${subtype}`,
    );
    await (args as any).next();
  });

  const sessions = new Map<string, AgentRuntime>();
  const queues = new Map<string, Promise<void>>();
  const seenMessageKeys = new Map<string, number>();
  const stopWord = (agent.config.behavior?.stopWord || "stop").toLowerCase();
  const continuousDmSession = agent.config.behavior?.continuousDmSession !== false;

  function getSessionKey(channel: string, threadTs: string): string {
    if (continuousDmSession && channel.startsWith("D")) return channel;
    return `${channel}-${threadTs}`;
  }

  async function getOrCreate(channel: string, threadTs: string): Promise<AgentRuntime> {
    const key = getSessionKey(channel, threadTs);
    let runtime = sessions.get(key);
    if (!runtime) {
      console.log(`[meso:${agentId}] New session: ${key}`);
      runtime = await createAgentRuntime(agentId, key, "slack");
      sessions.set(key, runtime);
    }
    return runtime;
  }

  function markSeenMessage(channel: string, ts: string, source: string): boolean {
    const now = Date.now();
    for (const [key, value] of seenMessageKeys.entries()) {
      if (now - value > 5 * 60_000) seenMessageKeys.delete(key);
    }
    const dedupeKey = `${channel}:${ts}`;
    if (seenMessageKeys.has(dedupeKey)) {
      console.log(`[meso:${agentId}] slack ingress deduped source=${source} channel=${channel} ts=${ts}`);
      return false;
    }
    seenMessageKeys.set(dedupeKey, now);
    lastSlackIngressAt = now;
    console.log(`[meso:${agentId}] slack ingress accepted source=${source} channel=${channel} ts=${ts} at=${new Date(now).toISOString()}`);
    return true;
  }

  function enqueueConversationWork(key: string, work: () => Promise<void>): Promise<void> {
    const previous = queues.get(key) || Promise.resolve();
    const next = previous
      .catch((error) => {
        console.error(`[meso:${agentId}] queue previous task failed session=${key}:`, error);
      })
      .then(async () => {
        console.log(`[meso:${agentId}] queue start session=${key}`);
        await work();
        console.log(`[meso:${agentId}] queue done session=${key}`);
      })
      .finally(() => {
        if (queues.get(key) === next) queues.delete(key);
      });
    queues.set(key, next);
    return next;
  }

  async function handleSlackConversationMessage(args: {
    text: string;
    channel: string;
    threadTs: string;
    userId?: string;
    source: string;
    slackTs?: string;
    say: (text: string) => Promise<any>;
    setStatus?: (status: string) => Promise<any>;
  }): Promise<void> {
    const { text, channel, threadTs, userId, source, slackTs, say, setStatus } = args;
    const sessionKey = getSessionKey(channel, threadTs);
    console.log(
      `[meso:${agentId}] handle message source=${source} channel=${channel} threadTs=${threadTs} session=${sessionKey} text=${JSON.stringify(text).slice(0, 120)}`,
    );
    const runtime = await getOrCreate(channel, threadTs);

    appendChannelLog(agent.paths, {
      date: new Date().toISOString(),
      provider: "slack",
      direction: "incoming",
      channelId: channel,
      threadId: sessionKey,
      userId: userId || "unknown",
      text,
      meta: { source, slackTs },
    });

    if (text.toLowerCase() === stopWord) {
      await runtime.session.abort();
      appendChannelLog(agent.paths, {
        date: new Date().toISOString(),
        provider: "slack",
        direction: "system",
        channelId: channel,
        threadId: sessionKey,
        userId: userId || "unknown",
        text: "Stopped.",
        meta: { kind: "stop" },
      });
      await say("Stopped.");
      return;
    }

    const lowerText = text.toLowerCase();
    if (lowerText === "switch model" || lowerText === "next model" || lowerText === "cycle model") {
      const newModel = await runtime.cycleModel();
      await say(`Switched to *${newModel}*`);
      return;
    }
    if (lowerText === "current model" || lowerText === "which model") {
      await say(`Currently using *${runtime.getCurrentModel()}*`);
      return;
    }

    await enqueueConversationWork(sessionKey, async () => {
      const statusStartedAt = Date.now();
      const minStatusMs = 2000;
      if (setStatus) {
        try {
          await setStatus("Thinking…");
        } catch {}
      }

      let lastStatusAt = Date.now();
      let lastStatusText = "";
      const updateProgress = async (progress: string) => {
        if (!setStatus) return;
        const now = Date.now();
        if (progress === lastStatusText) return;
        if (now - lastStatusAt < 3000) return;
        lastStatusAt = now;
        lastStatusText = progress;
        try {
          await setStatus(progress);
        } catch {}
      };
      const promptText = `${buildChannelContextBlock("slack", {
        channelId: channel,
        threadTs,
        userId: userId || "unknown",
      })}\n\n${text}`;
      console.log(`[meso:${agentId}] prompt prepared session=${sessionKey} threadTs=${threadTs} source=${source}`);

      let switchedModel: string | undefined;
      try {
        const response = await runtime.prompt(promptText, {
          onProgress: updateProgress,
          onModelSwitch: async (from, to, reason) => {
            switchedModel = to;
            if (setStatus) {
              try { await setStatus(`Switching model (${reason})…`); } catch {}
            }
          },
        });
        const elapsedMs = Date.now() - statusStartedAt;
        if (elapsedMs < minStatusMs) {
          await new Promise((resolve) => setTimeout(resolve, minStatusMs - elapsedMs));
        }
        const responseText = response || "_No response_";
        const finalText = switchedModel
          ? `_Switched to ${switchedModel}_\n\n${responseText}`
          : responseText;
        appendChannelLog(agent.paths, {
          date: new Date().toISOString(),
          provider: "slack",
          direction: "outgoing",
          channelId: channel,
          threadId: sessionKey,
          text: finalText,
        });
        console.log(`[meso:${agentId}] slack send start session=${sessionKey} threadTs=${threadTs} chars=${finalText.length}`);
        await say(finalText);
        console.log(`[meso:${agentId}] slack send ok session=${sessionKey} threadTs=${threadTs}`);
      } catch (error) {
        console.error(`[meso:${agentId}] Slack message error:`, error);
        const elapsedMs = Date.now() - statusStartedAt;
        if (elapsedMs < minStatusMs) {
          await new Promise((resolve) => setTimeout(resolve, minStatusMs - elapsedMs));
        }
        const finalText = `⚠️ Sorry, I hit an error: ${error instanceof Error ? error.message : "Unknown error"}`;
        appendChannelLog(agent.paths, {
          date: new Date().toISOString(),
          provider: "slack",
          direction: "outgoing",
          channelId: channel,
          threadId: sessionKey,
          text: finalText,
          meta: { error: true },
        });
        console.log(`[meso:${agentId}] slack error reply start session=${sessionKey} threadTs=${threadTs}`);
        await say(finalText);
        console.log(`[meso:${agentId}] slack error reply ok session=${sessionKey} threadTs=${threadTs}`);
      } finally {
        if (setStatus) {
          try {
            await setStatus("");
          } catch {}
        }
      }
    });
  }

  const assistant = new Assistant({
    threadStarted: async ({ setSuggestedPrompts, setTitle }) => {
      await setTitle(agent.config.name);
      await setSuggestedPrompts({
        prompts: [
          { title: "Help with code", message: "Help me write a function that..." },
          { title: "Search the web", message: "Search for the latest news about AI" },
          { title: "Explain something", message: "Explain how..." },
        ],
      });
    },
    userMessage: async ({ message, say, setStatus }) => {
      const msg = message as any;
      const text = msg.text?.trim();
      if (!text) return;
      const source = "assistant-user-message";
      if (!markSeenMessage(msg.channel, msg.ts, source)) return;
      await handleSlackConversationMessage({
        text,
        channel: msg.channel,
        threadTs: msg.thread_ts || msg.ts,
        userId: msg.user,
        source,
        slackTs: msg.ts,
        say: async (replyText: string) => {
          await say(replyText);
        },
        setStatus: async (status: string) => {
          await setStatus(status);
        },
      });
    },
  });

  app.assistant(assistant);

  // Channels where the bot listens to ALL messages (not just mentions/DMs)
  const listenChannels: string[] = slack.listenChannels || [];

  app.event("message", async ({ event, client }) => {
    const msg = event as any;
    console.log(
      `[meso:${agentId}] raw message event channel=${msg.channel} channel_type=${msg.channel_type} ts=${msg.ts} thread_ts=${msg.thread_ts || ""} subtype=${msg.subtype || ""} bot_id=${msg.bot_id || ""} user=${msg.user || ""}`,
    );
    const isListenChannel = listenChannels.includes(msg.channel);
    if (msg.channel_type !== "im" && !isListenChannel) {
      console.log(`[meso:${agentId}] raw message ignored: non-im non-listen channel=${msg.channel} type=${msg.channel_type}`);
      return;
    }

    const effectiveMsg =
      msg.subtype === "message_changed" && msg.message
        ? {
            channel: msg.channel,
            channel_type: msg.channel_type,
            ts: msg.message.ts || msg.ts,
            thread_ts: msg.message.thread_ts || msg.thread_ts,
            user: msg.message.user,
            bot_id: msg.message.bot_id,
            text: msg.message.text,
            subtype: msg.message.subtype,
            outerSubtype: msg.subtype,
          }
        : msg;

    if (msg.subtype && msg.subtype !== "file_share" && msg.subtype !== "message_changed") {
      console.log(`[meso:${agentId}] raw message ignored: subtype=${msg.subtype}`);
      return;
    }
    if (effectiveMsg.bot_id) {
      console.log(`[meso:${agentId}] raw message ignored: bot message bot_id=${effectiveMsg.bot_id}`);
      return;
    }
    const text = effectiveMsg.text?.trim();
    if (!text) {
      console.log(`[meso:${agentId}] raw message ignored: empty text ts=${effectiveMsg.ts}`);
      return;
    }

    const source = msg.subtype === "message_changed" ? "raw-message-changed-event" : "raw-message-event";
    if (!markSeenMessage(effectiveMsg.channel, effectiveMsg.ts, source)) return;
    await handleSlackConversationMessage({
      text,
      channel: effectiveMsg.channel,
      threadTs: effectiveMsg.thread_ts || effectiveMsg.ts,
      userId: effectiveMsg.user,
      source,
      slackTs: effectiveMsg.ts,
      say: async (replyText: string) => {
        const payload = effectiveMsg.thread_ts
          ? { channel: effectiveMsg.channel, thread_ts: effectiveMsg.thread_ts, text: replyText }
          : { channel: effectiveMsg.channel, text: replyText };
        console.log(`[meso:${agentId}] chat.postMessage payload=${JSON.stringify(payload)}`);
        const result = await client.chat.postMessage(payload);
        console.log(`[meso:${agentId}] chat.postMessage result ok=${result.ok} ts=${result.ts || ""}`);
      },
    });
  });

  // For listen channels, also handle message_changed edits addressed to bot
  // (already covered by the message event above — no extra handler needed)

  app.event("app_mention", async ({ event, client }) => {
    console.log(
      `[meso:${agentId}] app mention channel=${event.channel} ts=${event.ts} thread_ts=${event.thread_ts || ""} user=${event.user || ""}`,
    );
    const threadTs = event.thread_ts || event.ts;
    const text = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!text) return;
    const sessionKey = getSessionKey(event.channel, threadTs);
    const runtime = await getOrCreate(event.channel, threadTs);

    appendChannelLog(agent.paths, {
      date: new Date().toISOString(),
      provider: "slack",
      direction: "incoming",
      channelId: event.channel,
      threadId: sessionKey,
      userId: event.user || "unknown",
      text,
      meta: { source: "app-mention", slackTs: event.ts },
    });

    if (text.toLowerCase() === stopWord) {
      await runtime.session.abort();
      appendChannelLog(agent.paths, {
        date: new Date().toISOString(),
        provider: "slack",
        direction: "system",
        channelId: event.channel,
        threadId: sessionKey,
        userId: event.user || "unknown",
        text: "Stopped.",
        meta: { kind: "stop" },
      });
      await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: "Stopped." });
      return;
    }

    const setMentionStatus = async (status: string) => {
      try {
        await client.assistant.threads.setStatus({ channel_id: event.channel, thread_ts: threadTs, status });
      } catch {}
    };

    await handleSlackConversationMessage({
      text,
      channel: event.channel,
      threadTs,
      userId: event.user,
      source: "app-mention",
      slackTs: event.ts,
      say: async (replyText: string) => {
        await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: replyText });
      },
      setStatus: setMentionStatus,
    });
  });

  await app.start();
  armSocketWatchdog();
  console.log(`⚡ ${agent.config.name} is running on Slack via Meso!`);

  // Graceful shutdown: cleanly disconnect the socket so Slack stops routing
  // events to this connection. Without this, restarts leave stale connections
  // and Slack sends events into the void.
  const shutdown = async (signal: string) => {
    console.log(`[meso:${agentId}] ${signal} received, shutting down gracefully…`);
    clearSocketWatchdog();
    clearReconnectTimer();
    try {
      await app.stop();
      console.log(`[meso:${agentId}] Slack socket closed cleanly.`);
    } catch (err) {
      console.error(`[meso:${agentId}] Error during shutdown:`, err);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
