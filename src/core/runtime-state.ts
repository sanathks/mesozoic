import fs from "node:fs";
import path from "node:path";

export interface RuntimeStateData {
  model: {
    currentIndex: number;
    primaryCooldownUntil: number;
  };
  [key: string]: unknown;
}

const defaults: RuntimeStateData = {
  model: {
    currentIndex: 0,
    primaryCooldownUntil: 0,
  },
};

/**
 * Persisted runtime state for an agent. Lives at ~/.meso/agents/{id}/runtime-state.json.
 * Provides typed get/set with automatic file persistence.
 */
export class RuntimeState {
  private data: RuntimeStateData;
  private filePath: string;

  constructor(stateFilePath: string) {
    this.filePath = stateFilePath;
    this.data = this.load();
  }

  private load(): RuntimeStateData {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      return { ...defaults, ...parsed, model: { ...defaults.model, ...parsed?.model } };
    } catch {
      return { ...defaults, model: { ...defaults.model } };
    }
  }

  save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
    } catch {}
  }

  get<K extends keyof RuntimeStateData>(key: K): RuntimeStateData[K] {
    return this.data[key] as RuntimeStateData[K];
  }

  set<K extends keyof RuntimeStateData>(key: K, value: RuntimeStateData[K]): void {
    this.data[key] = value;
    this.save();
  }

  update<K extends keyof RuntimeStateData>(key: K, updater: (current: RuntimeStateData[K]) => RuntimeStateData[K]): void {
    this.data[key] = updater(this.data[key] as RuntimeStateData[K]);
    this.save();
  }
}
