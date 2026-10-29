import * as fs from "node:fs";
import * as path from "node:path";
import { defaultDataDir } from "./quarantine.js";

export interface AutoCheckpointSettings {
  /** Copy the saved .aep before every write tool. */
  enabled: boolean;
  /** Skip projects whose .aep is larger than this, in megabytes. */
  max_mb: number;
}

export interface Settings {
  auto_checkpoint: AutoCheckpointSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  auto_checkpoint: { enabled: true, max_mb: 250 },
};

export function defaultSettingsFilePath(): string {
  return path.join(defaultDataDir(), "settings.json");
}

function cloneDefaults(): Settings {
  return { auto_checkpoint: { ...DEFAULT_SETTINGS.auto_checkpoint } };
}

/**
 * Server settings, held in memory and mirrored to
 * `%LOCALAPPDATA%\chroma-ae-mcp\settings.json` so they survive a restart.
 * Unknown or invalid values on disk fall back to the defaults.
 */
export class SettingsStore {
  private readonly filePath: string;
  private settings: Settings = cloneDefaults();

  constructor(filePath: string = defaultSettingsFilePath()) {
    this.filePath = filePath;
    this.loadFromDisk();
  }

  get path(): string {
    return this.filePath;
  }

  get(): Settings {
    return { auto_checkpoint: { ...this.settings.auto_checkpoint } };
  }

  updateAutoCheckpoint(patch: Partial<AutoCheckpointSettings>): Settings {
    const next = { ...this.settings.auto_checkpoint };
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.max_mb !== undefined) next.max_mb = patch.max_mb;
    this.settings = { ...this.settings, auto_checkpoint: next };
    this.saveToDisk();
    return this.get();
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as {
        auto_checkpoint?: Partial<AutoCheckpointSettings>;
      };
      const ac = parsed?.auto_checkpoint;
      if (ac && typeof ac === "object") {
        if (typeof ac.enabled === "boolean") this.settings.auto_checkpoint.enabled = ac.enabled;
        if (typeof ac.max_mb === "number" && ac.max_mb > 0) this.settings.auto_checkpoint.max_mb = ac.max_mb;
      }
    } catch {
      // Ignore a corrupt or unreadable file on startup; keep the defaults
    }
  }

  private saveToDisk(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmpFile = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpFile, JSON.stringify(this.settings, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpFile, this.filePath);
  }
}
