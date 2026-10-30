import * as fs from "node:fs";
import * as path from "node:path";
import { defaultDataDir } from "./quarantine.js";

export interface AutoCheckpointSettings {
  /** Copy the saved .aep before every write tool. */
  enabled: boolean;
  /** Skip projects whose .aep is larger than this, in megabytes. */
  max_mb: number;
}

/** The user's motion taste, kept across projects (ae_taste); ae_motion_review follows it. */
export interface TasteSettings {
  /** cubic-bezier [x1, y1, x2, y2] whose handle lengths review fixes use instead of easy ease. */
  preferred_ease: number[] | null;
  /** Linear timing on opacity and effect parameters is deliberate, so the review leaves it alone. */
  allow_linear_non_motion: boolean;
  /** Overshoot past keyframe values is unwanted, so the review reports it as low instead of info. */
  avoid_overshoot: boolean;
  /** What the user has said about their taste, for the agent to read. */
  notes: string;
}

/** Auto-import of new files in `<project dir>/_assets/` into the `_Assets` bin (ae_import_assets watch). */
export interface AssetWatchSettings {
  enabled: boolean;
  /** When watching was turned on (ISO); only files changed after it are imported automatically. */
  since: string | null;
  /** Mirrors the `recursive` arg the watch was turned on with; scanAssets() default (true) otherwise. */
  recursive: boolean;
  /** Mirrors the `sequences` arg the watch was turned on with; scanAssets() default (true) otherwise. */
  sequences: boolean;
}

export interface Settings {
  auto_checkpoint: AutoCheckpointSettings;
  taste: TasteSettings;
  asset_watch: AssetWatchSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  auto_checkpoint: { enabled: true, max_mb: 250 },
  taste: { preferred_ease: null, allow_linear_non_motion: false, avoid_overshoot: false, notes: "" },
  asset_watch: { enabled: false, since: null, recursive: true, sequences: true },
};

export function defaultSettingsFilePath(): string {
  return path.join(defaultDataDir(), "settings.json");
}

function cloneTaste(t: TasteSettings): TasteSettings {
  return { ...t, preferred_ease: t.preferred_ease ? [...t.preferred_ease] : null };
}

function cloneDefaults(): Settings {
  return {
    auto_checkpoint: { ...DEFAULT_SETTINGS.auto_checkpoint },
    taste: cloneTaste(DEFAULT_SETTINGS.taste),
    asset_watch: { ...DEFAULT_SETTINGS.asset_watch },
  };
}

// Same MIN_HANDLE bound ext/animate.ts's curveToSides() clamps to at apply
// time (duplicated here rather than imported, to avoid this settings module
// depending on a tools/ext/* module): x1 can't be 0 (AE's influence floor
// is 0.1%) and x2 can't be 1, or the stored curve would silently come out
// different from what was stored the moment it's actually applied. x1 = 1
// and x2 = 0 are both fine -- curveToSides() doesn't clamp those ends.
const MIN_HANDLE = 0.001;

function isCurve(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length === 4 &&
    v.every((n) => typeof n === "number" && Number.isFinite(n)) &&
    v[0] >= MIN_HANDLE && v[0] <= 1 && v[2] >= 0 && v[2] <= 1 - MIN_HANDLE
  );
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
    return {
      auto_checkpoint: { ...this.settings.auto_checkpoint },
      taste: cloneTaste(this.settings.taste),
      asset_watch: { ...this.settings.asset_watch },
    };
  }

  updateAssetWatch(patch: Partial<AssetWatchSettings>): Settings {
    const next = { ...this.settings.asset_watch };
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.since !== undefined) next.since = patch.since;
    if (patch.recursive !== undefined) next.recursive = patch.recursive;
    if (patch.sequences !== undefined) next.sequences = patch.sequences;
    this.settings = { ...this.settings, asset_watch: next };
    this.saveToDisk();
    return this.get();
  }

  updateTaste(patch: Partial<TasteSettings>): Settings {
    const next = cloneTaste(this.settings.taste);
    if (patch.preferred_ease !== undefined) next.preferred_ease = isCurve(patch.preferred_ease) ? [...patch.preferred_ease] : null;
    if (patch.allow_linear_non_motion !== undefined) next.allow_linear_non_motion = patch.allow_linear_non_motion;
    if (patch.avoid_overshoot !== undefined) next.avoid_overshoot = patch.avoid_overshoot;
    if (patch.notes !== undefined) next.notes = patch.notes;
    this.settings = { ...this.settings, taste: next };
    this.saveToDisk();
    return this.get();
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
        taste?: Partial<TasteSettings>;
        asset_watch?: Partial<AssetWatchSettings>;
      };
      const ac = parsed?.auto_checkpoint;
      if (ac && typeof ac === "object") {
        if (typeof ac.enabled === "boolean") this.settings.auto_checkpoint.enabled = ac.enabled;
        if (typeof ac.max_mb === "number" && ac.max_mb > 0) this.settings.auto_checkpoint.max_mb = ac.max_mb;
      }
      const t = parsed?.taste;
      if (t && typeof t === "object") {
        if (isCurve(t.preferred_ease)) this.settings.taste.preferred_ease = [...t.preferred_ease];
        if (typeof t.allow_linear_non_motion === "boolean") this.settings.taste.allow_linear_non_motion = t.allow_linear_non_motion;
        if (typeof t.avoid_overshoot === "boolean") this.settings.taste.avoid_overshoot = t.avoid_overshoot;
        if (typeof t.notes === "string") this.settings.taste.notes = t.notes;
      }
      const aw = parsed?.asset_watch;
      if (aw && typeof aw === "object") {
        if (typeof aw.enabled === "boolean") this.settings.asset_watch.enabled = aw.enabled;
        if (typeof aw.since === "string" && !Number.isNaN(Date.parse(aw.since))) this.settings.asset_watch.since = aw.since;
        if (typeof aw.recursive === "boolean") this.settings.asset_watch.recursive = aw.recursive;
        if (typeof aw.sequences === "boolean") this.settings.asset_watch.sequences = aw.sequences;
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
