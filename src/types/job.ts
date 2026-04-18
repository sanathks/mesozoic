export type UserJobWeekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

export type UserJobSchedule =
  | {
      type: "daily";
      time: string;
      timezone?: string;
    }
  | {
      type: "weekdays";
      time: string;
      days: UserJobWeekday[];
      timezone?: string;
    }
  | {
      type: "weekly";
      day: UserJobWeekday;
      time: string;
      timezone?: string;
    }
  | {
      type: "interval";
      everyMinutes: number;
    }
  | {
      type: "once";
      at: string;
    };

export interface UserScheduledJob {
  id: string;
  enabled: boolean;
  kind: "agent-prompt";
  schedule: UserJobSchedule;
  prompt?: string;
  createdAt?: string;
  updatedAt?: string;
  policy?: {
    maxStalenessMinutes?: number;
    maxCatchupMinutes?: number;
    retryOnError?: false;
  };
  lastRunAt?: string;
  nextRunAt?: string;
  lastStatus?: "success" | "error" | "skipped" | "expired";
  lastError?: string;
}

export interface ImmediateEvent {
  id: string;
  type: "immediate";
  prompt: string;
  createdAt: string;
  dedupeKey?: string;
  source?: string;
  expiresAt?: string;
  meta?: Record<string, unknown>;
}

export interface InternalScheduledJob {
  id: string;
  enabled: boolean;
  kind: "dream";
  schedule: {
    type: "interval-hours";
    everyHours: number;
  };
}
