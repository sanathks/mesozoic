export interface AgentModelRef {
  provider: string;
  id: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  description?: string;
  prompts: {
    identity: string;
    soul: string;
    extra?: string[];
  };
  models: {
    main: AgentModelRef[];
    side: AgentModelRef;
  };
  runners?: {
    slack?: {
      enabled: boolean;
      botTokenEnv: string;
      appTokenEnv: string;
      signingSecretEnv?: string;
      mode?: "assistant";
      listenChannels?: string[];
    };
    discord?: {
      enabled: boolean;
      botTokenEnv: string;
    };
    telegram?: {
      enabled: boolean;
      botTokenEnv: string;
    };
    tui?: {
      enabled: boolean;
    };
  };
  storage?: {
    sessionsDir?: string;
    logsDir?: string;
    memoryDir?: string;
    memoryDb?: string;
    settingsFile?: string;
    guardrailsLocalConfig?: string;
    jobsFile?: string;
    eventsDir?: string;
    eventStateFile?: string;
  };
  tools?: {
    enabled: string[];
  };
  extensions?: {
    enabled: string[];
  };
  memory?: {
    enabled: boolean;
    maxRelevantItems?: number;
  };
  guardrails?: {
    enabled: boolean;
    projectConfig?: string;
    localConfig?: string;
  };
  behavior?: {
    progressUpdates?: "off" | "single-message" | "verbose";
    stopWord?: string;
    continuousDmSession?: boolean;
  };
  runtime?: {
    thinking?: "off" | "low" | "medium" | "high";
    compaction?: {
      enabled?: boolean;
      reserveTokens?: number;
      keepRecentTokens?: number;
    };
    retry?: {
      enabled?: boolean;
      maxRetries?: number;
      baseDelayMs?: number;
      maxDelayMs?: number;
    };
  };
}

export interface AgentPaths {
  root: string;
  runtimeDir: string;
  sessionsDir: string;
  logsDir: string;
  memoryDir: string;
  memoryDb: string;
  settingsFile: string;
  stateFile: string;
  guardrailsLocalConfig: string;
  jobsFile: string;
  eventsDir: string;
  eventStateFile: string;
}
