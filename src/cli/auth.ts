import { exec } from "node:child_process";
import * as p from "@clack/prompts";
import { createAuthStorage } from "../config.js";

function canOpenBrowser(): boolean {
  // No browser if no DISPLAY on Linux, or explicitly headless
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  return true;
}

function openUrl(url: string): boolean {
  if (!canOpenBrowser()) return false;
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  try {
    exec(`${cmd} ${JSON.stringify(url)}`);
    return true;
  } catch {
    return false;
  }
}

async function selectProvider(authStorage: ReturnType<typeof createAuthStorage>): Promise<string> {
  const providers = authStorage.getOAuthProviders();
  if (providers.length === 0) throw new Error("No OAuth providers available");

  const selected = await p.select({
    message: "Select provider",
    options: providers.map((prov) => ({
      value: prov.id,
      label: prov.name,
      hint: prov.id,
    })),
  });

  if (p.isCancel(selected)) { p.cancel("Cancelled."); process.exit(0); }
  return selected as string;
}

export async function runLogin(providerId?: string): Promise<void> {
  const authStorage = createAuthStorage();
  const provider = providerId || await selectProvider(authStorage);

  p.intro(`Login to ${provider}`);
  const s = p.spinner();

  // Pi races onManualCodeInput against the localhost callback server.
  // We show a spinner ("Waiting for browser...") that resolves automatically when
  // the callback fires. If it doesn't, the user can press Enter to switch to manual paste.
  let callbackDone = false;
  let unblockManual: ((value: string) => void) | null = null;

  await authStorage.login(provider as any, {
    onAuth: ({ url }: { url: string; instructions?: string }) => {
      const opened = openUrl(url);
      if (opened) {
        p.log.info("Opening browser...");
      } else {
        p.log.warn("Could not open browser. Copy this URL:");
      }
      console.log();
      console.log(url);
      console.log();
    },
    onPrompt: async (message: string, placeholder?: string) => {
      const result = await p.text({ message, placeholder: placeholder || "" });
      if (p.isCancel(result)) { p.cancel("Cancelled."); process.exit(0); }
      return result;
    },
    onProgress: (message: string) => {
      if (message.toLowerCase().includes("exchanging") || message.toLowerCase().includes("token")) {
        callbackDone = true;
        if (unblockManual) unblockManual("");
      }
      p.log.step(message);
    },
    onManualCodeInput: () => {
      const headless = !canOpenBrowser();

      // Headless: show paste field immediately (callback server won't work)
      if (headless) {
        return p.text({ message: "Paste the callback URL or code" }).then((result) => {
          if (p.isCancel(result)) { p.cancel("Cancelled."); process.exit(0); }
          return result;
        });
      }

      // Desktop: wait for callback, press Enter for manual fallback
      return new Promise<string>((resolve) => {
        unblockManual = resolve;

        const cleanup = () => {
          process.stdin.removeListener("data", onData);
          try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
          process.stdin.pause();
        };

        const onData = (data: Buffer) => {
          if (callbackDone) { cleanup(); return; }
          const key = data.toString();
          if (key === "\r" || key === "\n" || key.length > 0) {
            cleanup();
            p.text({ message: "Paste the callback URL or code" }).then((result) => {
              if (p.isCancel(result)) { p.cancel("Cancelled."); process.exit(0); }
              resolve(result);
            });
          }
        };

        const origResolve = resolve;
        unblockManual = (value: string) => {
          cleanup();
          origResolve(value);
        };

        try { if (process.stdin.isTTY) process.stdin.setRawMode(true); } catch {}
        process.stdin.resume();
        process.stdin.on("data", onData);

        p.log.info("Waiting for browser... (press Enter to paste manually)");
      });
    },
    signal: new AbortController().signal,
  } as any);

  p.outro(`Logged in to ${provider}`);

  // Pi's OAuth callback server may still be listening, keeping the event loop alive.
  // Force exit since login is complete.
  process.exit(0);
}

export function runLogout(providerId?: string): void {
  const authStorage = createAuthStorage();
  if (!providerId) {
    const providers = authStorage.list();
    if (providers.length === 0) {
      console.log("No stored credentials.");
      return;
    }
    providers.forEach((prov) => authStorage.logout(prov));
    console.log(`Logged out from: ${providers.join(", ")}`);
    return;
  }
  authStorage.logout(providerId);
  console.log(`Logged out from ${providerId}`);
}

export function runWhoAmI(): void {
  const authStorage = createAuthStorage();
  const providers = authStorage.list();
  if (providers.length === 0) {
    console.log("No stored credentials. Run: meso login");
    return;
  }
  for (const provider of providers) {
    const cred = authStorage.get(provider);
    console.log(`${provider}: ${cred?.type || "unknown"}`);
  }
}
