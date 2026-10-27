import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface QuarantineEntry {
  op_id: string;
  tool: string;
  label: string;
  quarantined_at: string;
  reason: string;
}

export class QuarantineBlockedError extends Error {
  readonly kind = "quarantined" as const;
  readonly entries: QuarantineEntry[];

  constructor(entries: QuarantineEntry[]) {
    const ids = entries.map((e) => e.op_id).join(", ");
    super(
      `Mutating tool refused: operation(s) [${ids}] are in quarantine because a previous mutation timed out with an unknown outcome. ` +
        `To clear quarantine: 1) call ae_status to check the panel's /health, 2) inspect the project/comp state with read tools (ae_get_project, ae_get_comp, ae_get_layer_props), ` +
        `and 3) call ae_acknowledge with { op_id, note } for each quarantined op.`
    );
    this.name = "QuarantineBlockedError";
    this.entries = entries;
  }
}

export function defaultDataDir(): string {
  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ||
      path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "chroma-ae-mcp");
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "chroma-ae-mcp"
    );
  }
  return path.join(os.homedir(), ".local", "share", "chroma-ae-mcp");
}

export function defaultQuarantineFilePath(): string {
  return path.join(defaultDataDir(), "quarantine.json");
}

/**
 * Manages uncertain-write quarantine state in memory, mirrored synchronously
 * to `%LOCALAPPDATA%\chroma-ae-mcp\quarantine.json` so it survives a server restart.
 */
export class QuarantineStore {
  private readonly filePath: string;
  private entries: Map<string, QuarantineEntry> = new Map();

  constructor(filePath: string = defaultQuarantineFilePath()) {
    this.filePath = filePath;
    this.loadFromDisk();
  }

  get path(): string {
    return this.filePath;
  }

  get isQuarantined(): boolean {
    return this.entries.size > 0;
  }

  list(): QuarantineEntry[] {
    return Array.from(this.entries.values());
  }

  get(opId: string): QuarantineEntry | undefined {
    return this.entries.get(opId);
  }

  /**
   * Throws QuarantineBlockedError if any operation is currently in quarantine.
   */
  assertClear(): void {
    if (this.entries.size > 0) {
      throw new QuarantineBlockedError(this.list());
    }
  }

  /**
   * Adds a timed-out mutating operation to quarantine and persists to disk.
   */
  add(entry: {
    op_id: string;
    tool: string;
    label: string;
    reason?: string;
    quarantined_at?: string;
  }): QuarantineEntry {
    const record: QuarantineEntry = {
      op_id: entry.op_id,
      tool: entry.tool,
      label: entry.label,
      quarantined_at: entry.quarantined_at ?? new Date().toISOString(),
      reason:
        entry.reason ??
        "Mutating operation timed out; outcome in After Effects is unknown.",
    };
    this.entries.set(record.op_id, record);
    this.saveToDisk();
    return record;
  }

  /**
   * Removes an operation from quarantine by op_id and updates the JSON mirror.
   */
  acknowledge(
    opId: string,
    note: string
  ): {
    acknowledged: boolean;
    op_id: string;
    note: string;
    removed?: QuarantineEntry;
    remaining: QuarantineEntry[];
  } {
    const existing = this.entries.get(opId);
    if (!existing) {
      return {
        acknowledged: false,
        op_id: opId,
        note,
        remaining: this.list(),
      };
    }
    this.entries.delete(opId);
    this.saveToDisk();
    return {
      acknowledged: true,
      op_id: opId,
      note,
      removed: existing,
      remaining: this.list(),
    };
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        return;
      }
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : parsed &&
          typeof parsed === "object" &&
          Array.isArray((parsed as { entries?: unknown }).entries)
        ? (parsed as { entries: unknown[] }).entries
        : [];
      for (const item of list) {
        if (
          item &&
          typeof item === "object" &&
          typeof (item as QuarantineEntry).op_id === "string"
        ) {
          const e = item as QuarantineEntry;
          this.entries.set(e.op_id, {
            op_id: e.op_id,
            tool: typeof e.tool === "string" ? e.tool : "unknown",
            label: typeof e.label === "string" ? e.label : "",
            quarantined_at:
              typeof e.quarantined_at === "string"
                ? e.quarantined_at
                : new Date().toISOString(),
            reason: typeof e.reason === "string" ? e.reason : "",
          });
        }
      }
    } catch {
      // Ignore corrupt/unreadable mirror on startup; keep memory map empty
    }
  }

  private saveToDisk(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const payload = JSON.stringify({ entries: this.list() }, null, 2);
    const tmpFile = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpFile, payload, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpFile, this.filePath);
  }
}
