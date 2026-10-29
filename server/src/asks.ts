/**
 * Questions the agent asks the user through the panel (ae_ask_user).
 *
 * The store lives in the service, in memory. The panel polls GET /ask for
 * open questions and posts the user's answer to POST /ask/answer; the tool
 * waits on the question until it is answered, dismissed, or its wait ends.
 */

export type AskKind = "choice" | "ease";

export interface AskOption {
  id: string;
  label: string;
  description?: string;
  /** cubic-bezier [x1, y1, x2, y2], drawn and previewed by the panel. */
  curve?: number[];
  /** Absolute path of a PNG or JPEG the panel shows with the option. */
  image_path?: string;
}

export interface AskQuestion {
  id: string;
  question: string;
  kind: AskKind;
  options: AskOption[];
  multi_select: boolean;
  allow_other: boolean;
  context?: string;
  asked_at: number;
}

export interface AskAnswer {
  status: "answered" | "dismissed";
  choice_ids: string[];
  other?: string;
  /** For ease questions: the curve the user settled on, edited or not. */
  curve?: number[];
  answered_at: number;
}

interface Entry {
  question: AskQuestion;
  answer?: AskAnswer;
  waiters: Array<(answer: AskAnswer) => void>;
}

// Answered questions are kept a while, so a later ae_ask_user {ask_id} can collect them.
const KEEP_ANSWERED_MS = 60 * 60 * 1000;
const MAX_OPEN = 20;

export class AskStore {
  private entries = new Map<string, Entry>();
  private counter = 0;

  constructor(private readonly now: () => number = Date.now) {}

  ask(q: Omit<AskQuestion, "id" | "asked_at">): AskQuestion {
    this.prune();
    if (this.open().length >= MAX_OPEN) {
      throw new Error(`There are already ${MAX_OPEN} unanswered questions in the panel.`);
    }
    this.counter += 1;
    const question: AskQuestion = {
      ...q,
      id: `ask_${this.now().toString(36)}_${this.counter}`,
      asked_at: this.now(),
    };
    this.entries.set(question.id, { question, waiters: [] });
    return question;
  }

  /** Unanswered questions, oldest first. */
  open(): AskQuestion[] {
    return [...this.entries.values()].filter((e) => !e.answer).map((e) => e.question);
  }

  get(id: string): { question: AskQuestion; answer?: AskAnswer } | null {
    const e = this.entries.get(id);
    return e ? { question: e.question, answer: e.answer } : null;
  }

  answer(
    id: string,
    reply: { choice_ids?: string[]; other?: string; curve?: number[]; dismissed?: boolean }
  ): { ok: true; answer: AskAnswer } | { ok: false; error: string } {
    const e = this.entries.get(id);
    if (!e) return { ok: false, error: "unknown question" };
    if (e.answer) return { ok: false, error: "already answered" };
    const q = e.question;

    let answer: AskAnswer;
    if (reply.dismissed) {
      answer = { status: "dismissed", choice_ids: [], answered_at: this.now() };
    } else {
      const known = new Set(q.options.map((o) => o.id));
      const ids = [...new Set(reply.choice_ids ?? [])];
      const unknown = ids.filter((i) => !known.has(i));
      if (unknown.length > 0) return { ok: false, error: `unknown option ${unknown.join(", ")}` };
      if (!q.multi_select && ids.length > 1) return { ok: false, error: "only one option may be chosen" };
      const other = typeof reply.other === "string" ? reply.other.trim().slice(0, 2000) : "";
      if (other && !q.allow_other) return { ok: false, error: "this question takes no free-text answer" };
      const curve = validCurve(reply.curve);
      if (ids.length === 0 && !other && !curve) return { ok: false, error: "empty answer" };
      answer = {
        status: "answered",
        choice_ids: ids,
        ...(other ? { other } : {}),
        ...(q.kind === "ease" && curve ? { curve } : {}),
        answered_at: this.now(),
      };
    }

    e.answer = answer;
    const waiters = e.waiters.splice(0);
    for (const w of waiters) w(answer);
    return { ok: true, answer };
  }

  /** Resolves with the answer, or null when `ms` passes first. */
  wait(id: string, ms: number): Promise<AskAnswer | null> {
    const e = this.entries.get(id);
    if (!e) return Promise.resolve(null);
    if (e.answer) return Promise.resolve(e.answer);
    return new Promise((resolve) => {
      const waiter = (a: AskAnswer) => {
        clearTimeout(timer);
        resolve(a);
      };
      const timer = setTimeout(() => {
        const i = e.waiters.indexOf(waiter);
        if (i >= 0) e.waiters.splice(i, 1);
        resolve(null);
      }, ms);
      e.waiters.push(waiter);
    });
  }

  private prune(): void {
    const cutoff = this.now() - KEEP_ANSWERED_MS;
    for (const [id, e] of this.entries) {
      if (e.answer && e.answer.answered_at < cutoff) this.entries.delete(id);
    }
  }
}

export function validCurve(curve: unknown): number[] | undefined {
  if (!Array.isArray(curve) || curve.length !== 4) return undefined;
  if (!curve.every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
  if (curve[0] < 0 || curve[0] > 1 || curve[2] < 0 || curve[2] > 1) return undefined;
  return curve.map((n) => Math.round(n * 1000) / 1000);
}
