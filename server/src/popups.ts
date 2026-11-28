/**
 * server/src/popups.ts
 *
 * Every After Effects popup, seen as it appears, asked about, and reported. The panel service watches
 * AE's windows (startDialogWatch); on a change it reads the popups (ae-dialogs.ps1 list: text, buttons,
 * screenshot) and for each new one:
 *
 * - One OK-like button, raised by an operation of ours (caused_by_op): there is nothing to decide, so it is
 *   pressed at once (the operation would otherwise wait on it) and reported.
 * - A progress window (only Cancel / Stop / Abort): left alone.
 * - Anything else: the user is asked, with the popup's own buttons as the options: in the panel ("After
 *   Effects asks", with its screenshot) and, when a running call's client handles elicitation, in the client
 *   too. Their pick is pressed through ae_dialog_respond's checks, quoting it as the user's instruction.
 *   Buttons Claude cannot press without focusing AE (on a popup AE painted itself, one whose place in its
 *   screenshot could not be read) are named, not offered.
 *
 * Popups are never suppressed (the user's rule) and never answered without the user, except that one OK.
 * Whatever happened is reported once on the agent's next tool result (`popups`), so the agent tells the
 * user what AE said ("the font Inter-Bold is missing") and offers the next step; the service log shows it
 * in the panel's Log at once.
 */

import { askByElicitation } from "./tools/ext/ask.js";
import type { AskStore } from "./asks.js";
import {
  DESTRUCTIVE_BODY_PATTERN,
  isDestructiveButton,
  normalizeOcrLabel,
  type DialogWatch,
  type EnrichedDialog,
} from "./tools/ext/dialogs.js";

export type PopupAnsweredBy = "auto" | "panel" | "client" | "agent";

export interface PopupButton {
  name: string;
  default?: boolean;
  /** Loses or replaces something (Don't Save, Replace, Delete...; or OK on a popup that talks about it). */
  destructive: boolean;
  /** Claude can press it (a real button; on a painted popup Cancel/No/Close, its default OK-like button, or any button read on its pill, which is clicked). */
  pressable: boolean;
}

export interface PopupRecord {
  id: string;
  handle: number;
  title: string;
  text: string;
  buttons: PopupButton[];
  caused_by_op: string | null;
  screenshot: string | null;
  seen_at: number;
  state: "open" | "answered" | "closed";
  answered?: { by: PopupAnsweredBy; button: string; at: number };
  /** Why a press did not happen or did not close the popup. */
  problem?: string;
  /** Where the user was asked. */
  asked_in: string[];
  /** A key is being posted to it: its window going away is that press, not the user in After Effects. */
  pressing?: boolean;
  ask_id?: string;
  /** What the agent was last told (`state` plus `problem`), so each change is reported once. */
  reported?: string;
  /** The popup as it was read when it was shown to the user (ae_dialog_respond compares with it). */
  dialog: EnrichedDialog;
  signature: string;
}

type ListResult = { ok: true; dialogs: EnrichedDialog[] } | { ok: false; error: string };
type ClientRequest = (method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<Record<string, unknown> | null>;

export interface PopupDeps {
  list: () => Promise<ListResult>;
  /** Records the popup as shown, so ae_dialog_respond's fresh read is compared with what the user saw. */
  markShown: (dialogs: EnrichedDialog[]) => void;
  respond: (args: { handle: number; button: string; reason: string; allow_destructive?: boolean; user_instruction?: string }) => Promise<Record<string, unknown>>;
  asks?: AskStore;
  /** A running tools/call whose client takes questions (elicitation/create), or null. */
  clientChannel?: () => ClientRequest | null;
  now?: () => number;
  log?: (level: string, msg: string) => void;
  /** How long a question about a popup waits for the user (default 10 minutes; the popup stays either way). */
  askWaitMs?: number;
}

const KEEP_CLOSED_MS = 30 * 60 * 1000;
/** A popup with no button read that closes within this time was a progress window ("Saving project"): never reported. */
export const TRANSIENT_MS = 2500;
/** How long a tool result waits for a one-button press still under way, so the report rides on that result. */
export const SETTLE_MS = 2500;
const TEXT_CHARS = 400;
const PROGRESS_ONLY = /^(cancel|stop|abort)$/;
const OK_LIKE = /^(ok|yes|continue)$/;
const LEAVE_ID = "leave";

function label(name: string): string {
  return normalizeOcrLabel(name ?? "").trim();
}
function plain(name: string): string {
  return label(name).toLowerCase().replace(/[^a-z ]/g, "").trim();
}
function letters(text: string): string {
  return (text ?? "").toLowerCase().replace(/[^\p{L}]/gu, "");
}

/** What tells one popup from another behind the same window: title, text (digits dropped: counters move), buttons. */
export function popupSignature(d: EnrichedDialog): string {
  return [letters(d.title), letters(d.text), d.buttons.map((b) => plain(b.name)).join("|")].join("\n");
}

/** The buttons as the user is shown them: which are destructive, which Claude can press. */
export function popupButtons(d: EnrichedDialog): PopupButton[] {
  const painted = d.unattended !== undefined;
  const pressable = new Set((d.unattended?.answerable ?? []).map(plain));
  const many = d.buttons.length > 1 || d.other_pill_unread === true;
  return d.buttons.map((b) => {
    const name = label(b.name);
    const destructive = isDestructiveButton(name) || (many && OK_LIKE.test(plain(name)) && DESTRUCTIVE_BODY_PATTERN.test(d.text));
    return {
      name,
      ...(b.default ? { default: true } : {}),
      destructive,
      pressable: painted ? pressable.has(plain(name)) : b.enabled !== false,
    };
  });
}

/** One OK-like button and nothing else: nothing to decide. */
function isInfo(d: EnrichedDialog, buttons: PopupButton[]): boolean {
  return buttons.length === 1 && d.checkboxes.length === 0 && d.other_pill_unread !== true && OK_LIKE.test(plain(buttons[0].name)) && !buttons[0].destructive;
}

/** Only Cancel / Stop / Abort: a progress window (rendering, saving, collecting), not a question. */
function isProgress(buttons: PopupButton[]): boolean {
  return buttons.length > 0 && buttons.every((b) => PROGRESS_ONLY.test(plain(b.name)));
}

/** A next step worth offering for what the popup said. */
export function followUpFor(text: string): string | undefined {
  const t = text ?? "";
  if (/font/i.test(t) && /(missing|not available|cannot access|can't access|substitut|not found|not installed)/i.test(t)) {
    return "A font problem: offer ae_fonts check_files (which font files are missing or broken) and, if the user wants, ae_fonts replace with an installed font.";
  }
  if (/(missing|offline|could not be found|cannot be found|can't be found|not found)/i.test(t) && /(file|footage|item|frame|source)/i.test(t)) {
    return "Missing files: offer ae_collect_relink to find and relink them.";
  }
  if (/(plug-?in|effect)/i.test(t) && /(missing|not installed|not available|not found)/i.test(t)) {
    return "A missing effect or plug-in: say which layers use it (ae_find_layers or ae_describe_comp) and that the user has to install it.";
  }
  return undefined;
}

export class PopupCenter {
  private readonly records = new Map<string, PopupRecord>();
  private readonly byHandle = new Map<number, string>();
  private counter = 0;
  private running: Promise<void> | null = null;
  private again = false;
  private watch: DialogWatch | null = null;
  private readonly now: () => number;
  /** One-button presses under way (the operation that raised the popup goes on as soon as the key lands). */
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: PopupDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Waits (at most `maxMs`) for one-button presses under way: the call that raised the popup returns as soon as
   * the key lands, and its result should carry the report.
   */
  async settle(maxMs = SETTLE_MS): Promise<void> {
    if (this.pending.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([...this.pending]).then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, maxMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /** Starts watching AE's windows; each change reads the popups again. */
  start(watchFactory: (onChange: () => void) => DialogWatch | null): void {
    if (this.watch) return;
    this.watch = watchFactory(() => {
      void this.refresh();
    });
    void this.refresh();
  }

  stop(): void {
    this.watch?.stop();
    this.watch = null;
  }

  /** Reads the popups again (calls made while one runs are folded into one more pass). */
  refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          await this.refreshOnce();
        } catch (err) {
          this.deps.log?.("warn", `Popup check failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async refreshOnce(): Promise<void> {
    const res = await this.deps.list();
    if (!res.ok) return;
    const present = new Set<number>();
    for (const d of res.dialogs) {
      present.add(d.handle);
      const sig = popupSignature(d);
      const known = this.byHandle.get(d.handle);
      const rec = known ? this.records.get(known) : undefined;
      if (rec && rec.signature === sig) continue;
      // Another popup behind the same window: the old one is gone.
      if (rec && rec.state === "open") this.closed(rec);
      this.added(d, sig);
    }
    for (const [id, rec] of this.records) {
      if (rec.state !== "open" || rec.pressing || present.has(rec.handle)) continue;
      // A window with no button that came and went: a progress window, not worth a word.
      if (rec.buttons.length === 0 && this.now() - rec.seen_at < TRANSIENT_MS) {
        this.records.delete(id);
        if (this.byHandle.get(rec.handle) === id) this.byHandle.delete(rec.handle);
        continue;
      }
      this.closed(rec);
    }
    this.prune();
  }

  private added(d: EnrichedDialog, signature: string): void {
    const buttons = popupButtons(d);
    // Only Cancel / Stop, or no button at all while an operation of ours runs: progress, not a question.
    if (isProgress(buttons) || (buttons.length === 0 && d.caused_by_op !== null)) {
      // Remembered so it is not looked at again, but neither asked about nor reported.
      this.byHandle.set(d.handle, `progress:${d.handle}`);
      return;
    }
    this.counter += 1;
    const rec: PopupRecord = {
      id: `popup_${this.now().toString(36)}_${this.counter}`,
      handle: d.handle,
      title: d.title,
      text: (d.text ?? "").slice(0, TEXT_CHARS),
      buttons,
      caused_by_op: d.caused_by_op,
      screenshot: d.screenshot,
      seen_at: this.now(),
      state: "open",
      asked_in: [],
      dialog: d,
      signature,
    };
    this.records.set(rec.id, rec);
    this.byHandle.set(d.handle, rec.id);
    const said = popupSaid(rec.title, rec.text);
    if (d.caused_by_op !== null && isInfo(d, buttons) && buttons[0].pressable) {
      const p = this.press(rec, buttons[0].name, "auto");
      this.pending.add(p);
      void p.finally(() => this.pending.delete(p));
      return;
    }
    if (buttons.length > 0) this.deps.log?.("info", `After Effects popup "${rec.title || "untitled"}": ${said}`);
    void this.ask(rec);
  }

  /** The popup closed without an answer of ours: the user answered it in After Effects (or AE closed it). */
  private closed(rec: PopupRecord): void {
    rec.state = "closed";
    if (rec.ask_id && this.deps.asks) this.deps.asks.answer(rec.ask_id, { dismissed: true });
  }

  /** ae_dialog_respond closed it (the agent answered): reported as such, not as closed in After Effects. */
  noteAnswered(handle: number, button: string, by: PopupAnsweredBy): void {
    const id = this.byHandle.get(handle);
    const rec = id ? this.records.get(id) : undefined;
    if (!rec || rec.state !== "open") return;
    rec.state = "answered";
    rec.answered = { by, button, at: this.now() };
    if (by === "agent") rec.reported = reportKey(rec); // the agent knows what it pressed
    if (rec.ask_id && this.deps.asks) this.deps.asks.answer(rec.ask_id, { dismissed: true });
  }

  private async press(rec: PopupRecord, button: string, by: PopupAnsweredBy, userWords?: string): Promise<void> {
    const b = rec.buttons.find((x) => x.name === button);
    // The fresh read before the key is compared with the popup as the user (or the rule) saw it.
    this.deps.markShown([rec.dialog]);
    rec.pressing = true;
    const res = (await this.deps
      .respond({
        handle: rec.handle,
        button,
        reason:
          by === "auto"
            ? "A one-button popup raised by our own operation: nothing to decide, pressed so the operation can go on; reported to the user."
            : `The user chose "${button}" when asked about this popup (${by === "panel" ? "in the Chroma panel" : "in the client"}).`,
        ...(userWords ? { user_instruction: userWords } : {}),
        ...(b?.destructive && userWords ? { allow_destructive: true } : {}),
      })
      .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        rec.pressing = false;
      })) as { ok?: boolean; closed?: boolean; pressed?: string; message?: string; error?: string };
    if (rec.state !== "open") return;
    if (res.ok === true && res.closed === true) {
      rec.state = "answered";
      rec.answered = { by, button: res.pressed ?? button, at: this.now() };
      rec.problem = undefined;
      const said = popupSaid(rec.title, rec.text);
      this.deps.log?.("ok", `After Effects popup "${rec.title || "untitled"}": pressed "${rec.answered.button}" (${by === "auto" ? "automatically: one button, our own operation" : by === "panel" ? "the user's choice in the panel" : "the user's choice"}). It said: ${said}`);
      return;
    }
    rec.problem =
      res.ok === true
        ? `"${button}" was pressed but the popup did not close.`
        : `"${button}" could not be pressed: ${oneLine(res.message ?? res.error ?? "unknown error")}`;
    this.deps.log?.("warn", `After Effects popup "${rec.title || "untitled"}": ${rec.problem}`);
    // The rule could not answer it: the user decides after all.
    if (by === "auto") void this.ask(rec);
  }

  private async ask(rec: PopupRecord): Promise<void> {
    const pressable = rec.buttons.filter((b) => b.pressable);
    if (pressable.length === 0) return; // reported; the user answers it in After Effects
    const others = rec.buttons.filter((b) => !b.pressable).map((b) => `"${b.name}"`);
    const options = [
      ...pressable.map((b, i) => ({
        id: `b${i}`,
        label: b.name,
        ...(b.destructive
          ? { description: "Loses or replaces something." }
          : b.default
          ? { description: "The popup's default button." }
          : {}),
      })),
      { id: LEAVE_ID, label: "Leave it", description: "I'll answer it in After Effects myself." },
    ];
    const said = popupSaid(rec.title, rec.text);
    const question = (said || "A popup is open in After Effects.").slice(0, 300);
    const context = [
      rec.title && said !== oneLine(rec.title) ? `"${oneLine(rec.title)}"` : "",
      others.length ? `Click ${others.join(", ")} in After Effects yourself if you want ${others.length === 1 ? "it" : "one of them"}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const waitMs = this.deps.askWaitMs ?? 10 * 60 * 1000;
    const pick = (id: string): string | null => (id === LEAVE_ID ? null : pressable[Number(id.slice(1))]?.name ?? null);

    const waits: Array<Promise<{ via: "panel" | "client"; id: string } | null>> = [];
    if (this.deps.asks) {
      try {
        const q = this.deps.asks.ask({
          question,
          kind: "choice",
          options,
          multi_select: false,
          allow_other: false,
          context,
          source: "popup",
          ...(rec.screenshot ? { image_path: rec.screenshot } : {}),
        });
        rec.ask_id = q.id;
        rec.asked_in.push("panel");
        waits.push(
          this.deps.asks.wait(q.id, waitMs).then((a) => (a && a.status === "answered" && a.choice_ids[0] ? { via: "panel" as const, id: a.choice_ids[0] } : null))
        );
      } catch {
        // The panel's question list is full; the agent is still told.
      }
    }
    const channel = this.deps.clientChannel?.() ?? null;
    if (channel) {
      rec.asked_in.push("client");
      waits.push(
        askByElicitation(channel, { question: `After Effects asks: ${question}`, options, context, allow_other: false }, waitMs)
          .then((r) => {
            const chosen = (r as { status?: string; chosen?: Array<{ id: string }> } | null)?.chosen;
            return r && (r as { status?: string }).status === "answered" && chosen?.[0] ? { via: "client" as const, id: chosen[0].id } : null;
          })
          .catch(() => null)
      );
    }
    if (waits.length === 0) return;
    const first = await firstNonNull(waits);
    if (!first || rec.state !== "open") return;
    if (first.via === "client" && rec.ask_id && this.deps.asks) this.deps.asks.answer(rec.ask_id, { dismissed: true });
    const button = pick(first.id);
    if (!button) {
      rec.problem = "The user chose to answer it in After Effects.";
      return;
    }
    const where = first.via === "panel" ? "in the Chroma panel" : "in the client";
    await this.press(rec, button, first.via, `The user chose "${button}" ${where} when asked about the After Effects popup "${rec.title || "untitled"}".`);
  }

  /** Popups still open, oldest first (for ae_status and the panel). */
  open(): PopupRecord[] {
    return [...this.records.values()].filter((r) => r.state === "open").sort((a, b) => a.seen_at - b.seen_at);
  }

  /**
   * What the agent has not been told yet, once: popups pressed for it, answered by the user, closed in After
   * Effects, or open and waiting. Null when there is nothing new.
   */
  takeReport(): Record<string, unknown> | null {
    const now = this.now();
    const fresh = [...this.records.values()]
      .filter((r) => r.reported !== reportKey(r))
      // A press under way is told once it is done.
      .filter((r) => !r.pressing)
      // A window with no button that just appeared may be a progress window: told only if it stays.
      .filter((r) => !(r.state === "open" && r.buttons.length === 0 && now - r.seen_at < TRANSIENT_MS))
      .sort((a, b) => a.seen_at - b.seen_at);
    if (fresh.length === 0) return null;
    const out: Record<string, unknown[]> = {};
    const hints = new Set<string>();
    for (const r of fresh) {
      r.reported = reportKey(r);
      const said = popupSaid(r.title, r.text);
      const hint = followUpFor(`${r.title} ${r.text}`);
      if (hint) hints.add(hint);
      const base = { title: r.title || "untitled", said, ...(r.screenshot ? { screenshot: r.screenshot } : {}) };
      if (r.state === "answered" && r.answered) {
        const key = r.answered.by === "auto" ? "pressed_for_you" : "answered_by_user";
        (out[key] ??= []).push({ ...base, pressed: r.answered.button, ...(r.answered.by === "auto" ? {} : { where: r.answered.by === "panel" ? "panel" : "client" }) });
      } else if (r.state === "closed") {
        (out.closed_in_after_effects ??= []).push(base);
      } else {
        (out.open ??= []).push({
          ...base,
          handle: r.handle,
          buttons: r.buttons.map((b) => ({ name: b.name, ...(b.default ? { default: true } : {}), ...(b.destructive ? { destructive: true } : {}), ...(b.pressable ? {} : { only_in_after_effects: true }) })),
          caused_by_us: r.caused_by_op !== null,
          ...(r.asked_in.length ? { asked_in: r.asked_in } : {}),
          ...(r.problem ? { problem: r.problem } : {}),
        });
      }
    }
    const next: string[] = ["Tell the user in a line what each After Effects popup said and what was pressed."];
    if (out.open) {
      next.push(
        out.open.some((o) => (o as { asked_in?: string[] }).asked_in)
          ? "An open popup is being asked about in the panel: wait for the user's answer there, or ask in the chat with its buttons as the options and press their pick with ae_dialog_respond (user_instruction quoting them; allow_destructive for a destructive button)."
          : "For an open popup ask the user which button (its buttons are the options), then press it with ae_dialog_respond (user_instruction quoting them; allow_destructive for a destructive button)."
      );
      const onlyInAe = out.open.some((o) => ((o as { buttons?: Array<{ only_in_after_effects?: boolean }> }).buttons ?? []).some((b) => b.only_in_after_effects));
      if (onlyInAe) next.push("Buttons marked only_in_after_effects cannot be pressed from here: the user clicks them in After Effects.");
    }
    for (const h of hints) next.push(h);
    return { ...out, next: next.join(" ") };
  }

  private prune(): void {
    const cutoff = this.now() - KEEP_CLOSED_MS;
    for (const [id, r] of this.records) {
      if (r.state !== "open" && r.seen_at < cutoff && r.reported === reportKey(r)) {
        this.records.delete(id);
        if (this.byHandle.get(r.handle) === id) this.byHandle.delete(r.handle);
      }
    }
  }
}

function reportKey(r: PopupRecord): string {
  return `${r.state}|${r.problem ?? ""}`;
}

function oneLine(s: string): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** What the popup says, without its title repeated in front (OCR reads the title bar as the first line). */
export function popupSaid(title: string, text: string): string {
  let body = oneLine(text);
  const t = oneLine(title);
  if (t) {
    while (body.toLowerCase().startsWith(t.toLowerCase())) body = body.slice(t.length).replace(/^[\s:.-]+/, "");
  }
  return body || t;
}

/** The first promise that resolves to something other than null; null when all of them do. */
function firstNonNull<T>(promises: Array<Promise<T | null>>): Promise<T | null> {
  return new Promise((resolve) => {
    let left = promises.length;
    for (const p of promises) {
      p.then((v) => {
        if (v !== null) resolve(v);
        else if (--left === 0) resolve(null);
      }).catch(() => {
        if (--left === 0) resolve(null);
      });
    }
  });
}
