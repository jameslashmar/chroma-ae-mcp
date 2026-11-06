/**
 * server/src/transcribe.ts
 *
 * Speech-to-text engines for ae_transcribe. An engine takes an audio or video
 * file and returns the engine's own JSON (kept as returned) plus a summary.
 * ElevenLabs Scribe is the first; a local whisper.cpp / WhisperX engine can
 * implement the same interface later.
 *
 * Plain node:https (the panel's Node 17 has no fetch). The file is streamed
 * from disk into a multipart body, never held in memory.
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";

export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
export const ELEVENLABS_KEY_VAR = "ELEVENLABS_API_KEY";
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export const SOURCE_EXTENSIONS = [".wav", ".aif", ".aiff", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".mp4", ".mov", ".webm"];

export type TranscribeErrorCode = "no_api_key" | "upload_failed" | "api_error" | "bad_response";

export class TranscribeError extends Error {
  constructor(
    readonly code: TranscribeErrorCode,
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

export interface TranscribeOptions {
  model: string;
  language?: string;
  diarize: boolean;
  num_speakers?: number;
  tag_audio_events: boolean;
}

export interface TranscriptSummary {
  language_code: string | null;
  language_probability: number | null;
  duration_s: number;
  words: number;
  speakers: string[];
  audio_events: number;
  /** First ~30 words as text. */
  preview: string;
}

export interface EngineResult {
  /** The engine's response as returned; this is what is written to disk. */
  raw: unknown;
  summary: TranscriptSummary;
}

export interface TranscribeEngine {
  id: string;
  /** `signalLike.aborted` is checked between steps; an in-flight upload is not killed. */
  transcribe(file: string, opts: TranscribeOptions, signalLike?: { aborted: boolean }): Promise<EngineResult>;
}

// ---------- API key ----------

export interface KeyLookupDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Runs a program and returns its stdout. Default: child_process.execFile with windowsHide. */
  execFile?: (file: string, args: string[]) => Promise<string>;
  /** Reads a text file, or returns undefined when it cannot be read. */
  readFile?: (p: string) => string | undefined;
  home?: string;
}

const defaultExecFile = (file: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    childProcess.execFile(file, args, { windowsHide: true, timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });

const defaultReadFile = (p: string): string | undefined => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

/** Process environment first, then (Windows) the User environment, then (macOS) ~/.zprofile. Never written to. */
export async function lookupElevenLabsKey(deps: KeyLookupDeps = {}): Promise<string | undefined> {
  const env = deps.env ?? process.env;
  const fromEnv = env[ELEVENLABS_KEY_VAR]?.trim();
  if (fromEnv) return fromEnv;
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    try {
      const out = await (deps.execFile ?? defaultExecFile)("reg", ["query", "HKCU\\Environment", "/v", ELEVENLABS_KEY_VAR]);
      const m = new RegExp(`${ELEVENLABS_KEY_VAR}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)`, "i").exec(out);
      const v = m?.[1].trim();
      if (v) return v;
    } catch {
      // Not set for this user.
    }
  } else if (platform === "darwin") {
    const text = (deps.readFile ?? defaultReadFile)(path.join(deps.home ?? os.homedir(), ".zprofile"));
    if (text) {
      const re = new RegExp(`^\\s*export\\s+${ELEVENLABS_KEY_VAR}=(.*)$`, "gm");
      let last: string | undefined;
      for (let m = re.exec(text); m; m = re.exec(text)) last = m[1];
      if (last !== undefined) {
        let v = last.trim();
        const q = /^(["'])(.*?)\1/.exec(v);
        v = q ? q[2] : v.replace(/\s+#.*$/, "");
        if (v) return v;
      }
    }
  }
  return undefined;
}

/** Looks the key up once per resolver; the key lives in memory only. */
export function createKeyResolver(deps: KeyLookupDeps = {}): () => Promise<string> {
  let cached: string | undefined;
  return async () => {
    if (cached) return cached;
    const key = await lookupElevenLabsKey(deps);
    if (!key) {
      throw new TranscribeError(
        "no_api_key",
        `No ${ELEVENLABS_KEY_VAR} found. Set it as an environment variable: on Windows as a User variable (Settings > System > About > Advanced system settings > Environment Variables), ` +
          `on macOS with 'export ${ELEVENLABS_KEY_VAR}=...' in ~/.zprofile, then restart After Effects.`
      );
    }
    cached = key;
    return key;
  };
}

/** Removes the key and anything shaped like an ElevenLabs key from text that may reach a result. */
export function redactKey(text: string, key?: string): string {
  let out = text;
  if (key) out = out.split(key).join("[key]");
  return out.replace(/\bsk[_-][A-Za-z0-9_-]{8,}/g, "[key]");
}

// ---------- summary ----------

interface ScribeWord {
  text?: unknown;
  start?: unknown;
  end?: unknown;
  type?: unknown;
  speaker_id?: unknown;
}

export function summariseScribe(raw: Record<string, unknown>): TranscriptSummary {
  const items = (raw.words as ScribeWord[]).filter((w) => w && typeof w === "object");
  const isWord = (w: ScribeWord) => w.type === undefined || w.type === "word";
  const words = items.filter(isWord);
  const speakers: string[] = [];
  for (const w of words) {
    if (w.speaker_id !== undefined && w.speaker_id !== null) {
      const s = String(w.speaker_id);
      if (!speakers.includes(s)) speakers.push(s);
    }
  }
  let duration = 0;
  for (const w of items) if (typeof w.end === "number" && w.end > duration) duration = w.end;
  const prob = raw.language_probability;
  return {
    language_code: typeof raw.language_code === "string" ? raw.language_code : null,
    language_probability: typeof prob === "number" ? prob : null,
    duration_s: Math.round(duration * 1000) / 1000,
    words: words.length,
    speakers: speakers.slice(0, 500),
    audio_events: items.filter((w) => w.type === "audio_event").length,
    preview: words
      .slice(0, 30)
      .map((w) => String(w.text ?? ""))
      .join(" ")
      .trim()
      .slice(0, 2000),
  };
}

// ---------- ElevenLabs Scribe ----------

const CONTENT_TYPES: Record<string, string> = {
  ".wav": "audio/wav",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

export interface ElevenLabsEngineOptions {
  getKey?: () => Promise<string>;
  /** Default https.request; tests pass a fake. */
  request?: typeof https.request;
  host?: string;
  idleTimeoutMs?: number;
}

/** What the API says is wrong, from its usual {"detail": {"message"}} or {"detail": "..."} body. */
function apiMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { detail?: unknown; message?: unknown };
    const d = j.detail;
    if (typeof d === "string") return d;
    if (d && typeof d === "object") {
      const o = d as { message?: unknown; status?: unknown };
      if (typeof o.message === "string") return o.message;
      return JSON.stringify(d).slice(0, 400);
    }
    if (Array.isArray(d)) return JSON.stringify(d).slice(0, 400);
    if (typeof j.message === "string") return j.message;
  } catch {
    // Not JSON.
  }
  return body.slice(0, 300);
}

export function createElevenLabsEngine(options: ElevenLabsEngineOptions = {}): TranscribeEngine {
  const getKey = options.getKey ?? createKeyResolver();
  const request = options.request ?? https.request;
  const host = options.host ?? "api.elevenlabs.io";
  const idleMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;

  return {
    id: "elevenlabs",
    async transcribe(file, opts, signalLike) {
      const key = await getKey();
      const stat = fs.statSync(file);
      const boundary = `----chromaAe${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
      const fields: Array<[string, string]> = [["model_id", opts.model]];
      if (opts.language) fields.push(["language_code", opts.language]);
      fields.push(["diarize", String(opts.diarize)]);
      if (opts.num_speakers !== undefined) fields.push(["num_speakers", String(opts.num_speakers)]);
      fields.push(["tag_audio_events", String(opts.tag_audio_events)], ["timestamps_granularity", "word"]);
      const text = fields.map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join("");
      const ext = path.extname(file).toLowerCase();
      const filename = path.basename(file).replace(/["\r\n\\]/g, "_");
      const head = Buffer.from(
        `${text}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${CONTENT_TYPES[ext] ?? "application/octet-stream"}\r\n\r\n`,
        "utf8"
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
      if (signalLike?.aborted) throw new TranscribeError("upload_failed", "Cancelled before the upload started");

      const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        let settled = false;
        const fail = (err: unknown) => {
          if (settled) return;
          settled = true;
          reject(new TranscribeError("upload_failed", redactKey(`Upload to ElevenLabs failed: ${err instanceof Error ? err.message : String(err)}`, key)));
        };
        const req = request(
          {
            method: "POST",
            host,
            path: "/v1/speech-to-text",
            headers: {
              "xi-api-key": key,
              "Content-Type": `multipart/form-data; boundary=${boundary}`,
              "Content-Length": head.length + stat.size + tail.length,
              Accept: "application/json",
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer | string) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
            res.on("error", fail);
            res.on("end", () => {
              if (settled) return;
              settled = true;
              resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
            });
          }
        );
        // An idle socket fails the job; a slow but moving upload does not.
        req.setTimeout(idleMs, () => req.destroy(new Error(`no data for ${Math.round(idleMs / 60000)} minutes`)));
        req.on("error", fail);
        req.write(head);
        const stream = fs.createReadStream(file);
        stream.on("error", (e) => {
          fail(e);
          req.destroy();
        });
        stream.on("end", () => {
          req.write(tail);
          req.end();
        });
        stream.on("data", (chunk) => {
          if (!req.write(chunk)) {
            stream.pause();
            req.once("drain", () => stream.resume());
          }
        });
      });

      if (status < 200 || status >= 300) {
        throw new TranscribeError("api_error", redactKey(`ElevenLabs returned HTTP ${status}: ${apiMessage(body)}`, key), status);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        throw new TranscribeError("bad_response", "ElevenLabs answered 200 but the body was not JSON", status);
      }
      if (!raw || typeof raw !== "object" || !Array.isArray((raw as { words?: unknown }).words)) {
        throw new TranscribeError("bad_response", "ElevenLabs answered 200 but the JSON has no words array", status);
      }
      return { raw, summary: summariseScribe(raw as Record<string, unknown>) };
    },
  };
}
