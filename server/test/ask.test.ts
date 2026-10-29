import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AskStore, validCurve } from "../src/asks.js";
import type { ToolContext } from "../src/tools/common.js";
import { AeAskUserSchema, askTools, checkImagePath, PANEL_EXTENSION_ID } from "../src/tools/ext/ask.js";
import { ALL_TOOLS } from "../src/tools/registry.js";

const tool = askTools.find((t) => t.name === "ae_ask_user")!;

const EASE_OPTIONS = [
  { id: "gentle", label: "Gentle", curve: [0.25, 0.1, 0.25, 1] },
  { id: "snappy", label: "Snappy", curve: [0.2, 0, 0, 1] },
];

function choiceQuestion(store: AskStore, extra: Record<string, unknown> = {}) {
  return store.ask({
    question: "How long?",
    kind: "choice",
    options: [
      { id: "a", label: "2 s" },
      { id: "b", label: "3 s" },
    ],
    multi_select: false,
    allow_other: true,
    ...extra,
  });
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("AskStore", () => {
  it("lists open questions oldest first and hands the answer to a waiter", async () => {
    const store = new AskStore();
    const q1 = choiceQuestion(store);
    const q2 = choiceQuestion(store, { question: "Which colour?" });
    expect(store.open().map((q) => q.id)).toEqual([q1.id, q2.id]);

    const waiting = store.wait(q1.id, 5000);
    expect(store.answer(q1.id, { choice_ids: ["b"] })).toMatchObject({ ok: true });
    await expect(waiting).resolves.toMatchObject({ status: "answered", choice_ids: ["b"] });
    expect(store.open().map((q) => q.id)).toEqual([q2.id]);
    expect(store.answer(q1.id, { choice_ids: ["a"] })).toEqual({ ok: false, error: "already answered" });
  });

  it("resolves null when the wait runs out, and keeps the question open", async () => {
    const store = new AskStore();
    const q = choiceQuestion(store);
    await expect(store.wait(q.id, 10)).resolves.toBeNull();
    expect(store.open()).toHaveLength(1);
    store.answer(q.id, { other: "4 s please" });
    await expect(store.wait(q.id, 10)).resolves.toMatchObject({ status: "answered", other: "4 s please", choice_ids: [] });
  });

  it("rejects answers the question does not allow", () => {
    const store = new AskStore();
    const q = choiceQuestion(store, { allow_other: false });
    expect(store.answer(q.id, { choice_ids: ["zzz"] })).toEqual({ ok: false, error: "unknown option zzz" });
    expect(store.answer(q.id, { choice_ids: ["a", "b"] })).toEqual({ ok: false, error: "only one option may be chosen" });
    expect(store.answer(q.id, { other: "free text" })).toEqual({ ok: false, error: "this question takes no free-text answer" });
    expect(store.answer(q.id, {})).toEqual({ ok: false, error: "empty answer" });
    expect(store.answer("nope", { choice_ids: ["a"] })).toEqual({ ok: false, error: "unknown question" });
  });

  it("records a dismissal", async () => {
    const store = new AskStore();
    const q = choiceQuestion(store);
    store.answer(q.id, { dismissed: true });
    await expect(store.wait(q.id, 10)).resolves.toMatchObject({ status: "dismissed", choice_ids: [] });
  });

  it("keeps the curve only on ease questions", () => {
    const store = new AskStore();
    const ease = store.ask({ question: "Ease?", kind: "ease", options: EASE_OPTIONS, multi_select: false, allow_other: true });
    const plain = choiceQuestion(store);
    const a = store.answer(ease.id, { choice_ids: ["snappy"], curve: [0.2, 0, 0.1, 1.1049] });
    const b = store.answer(plain.id, { choice_ids: ["a"], curve: [0.2, 0, 0.1, 1.1] });
    expect(a.ok && a.answer.curve).toEqual([0.2, 0, 0.1, 1.105]);
    expect(b.ok && b.answer.curve).toBeUndefined();
  });

  it("drops answered questions after an hour", () => {
    let now = 1_000_000;
    const store = new AskStore(() => now);
    const q = choiceQuestion(store);
    store.answer(q.id, { choice_ids: ["a"] });
    now += 61 * 60 * 1000;
    choiceQuestion(store); // asking prunes
    expect(store.get(q.id)).toBeNull();
  });

  it("validates curves", () => {
    expect(validCurve([0.2, -0.5, 0.8, 1.5])).toEqual([0.2, -0.5, 0.8, 1.5]);
    expect(validCurve([1.2, 0, 0.5, 1])).toBeUndefined();
    expect(validCurve([0.2, 0, 0.5])).toBeUndefined();
    expect(validCurve("0,0,1,1")).toBeUndefined();
  });
});

describe("ae_ask_user", () => {
  function ctxWith(store?: AskStore) {
    const opened: string[] = [];
    const ctx = {
      asks: store,
      cep: { listExtensions: () => [], openExtension: (id: string) => (opened.push(id), true) },
    } as unknown as ToolContext;
    return { ctx, opened };
  }

  it("is registered", () => {
    expect(ALL_TOOLS.some((t) => t.name === "ae_ask_user")).toBe(true);
  });

  it("opens the panel, waits, and reports the chosen ease with its final curve", async () => {
    const store = new AskStore();
    const { ctx, opened } = ctxWith(store);
    const args = AeAskUserSchema.parse({ question: "Ease?", kind: "ease", options: EASE_OPTIONS, context: "Box > Position" });
    const pending = tool.handler(args, ctx);
    await new Promise((r) => setTimeout(r, 5));
    const [q] = store.open();
    expect(q).toMatchObject({ question: "Ease?", kind: "ease", context: "Box > Position", multi_select: false, allow_other: true });
    expect(opened).toEqual([PANEL_EXTENSION_ID]);

    store.answer(q.id, { choice_ids: ["snappy"], curve: [0.2, 0, 0.1, 1.1] });
    const out = await pending;
    expect(out).toMatchObject({
      status: "answered",
      ask_id: q.id,
      chosen: [{ id: "snappy", label: "Snappy" }],
      curve: [0.2, 0, 0.1, 1.1],
      edited: true,
    });
    expect(out.next).toMatch(/ae_set_keyframe_ease/);
  });

  it("says when the curve is the option's own", async () => {
    const store = new AskStore();
    const { ctx } = ctxWith(store);
    const pending = tool.handler(AeAskUserSchema.parse({ question: "Ease?", kind: "ease", options: EASE_OPTIONS }), ctx);
    await new Promise((r) => setTimeout(r, 5));
    store.answer(store.open()[0].id, { choice_ids: ["gentle"], curve: [0.25, 0.1, 0.25, 1] });
    await expect(pending).resolves.toMatchObject({ edited: false });
  });

  it("returns 'waiting' when the wait runs out, and collects the answer later by ask_id", async () => {
    const store = new AskStore();
    const { ctx } = ctxWith(store);
    const first = await tool.handler(
      AeAskUserSchema.parse({ question: "How long?", options: [{ id: "a", label: "2 s" }, { id: "b", label: "3 s" }], wait_seconds: 0 }),
      ctx
    );
    expect(first).toMatchObject({ status: "waiting" });
    store.answer(first.ask_id, { choice_ids: ["a"] });
    const later = await tool.handler(AeAskUserSchema.parse({ ask_id: first.ask_id, wait_seconds: 0 }), ctx);
    expect(later).toMatchObject({ status: "answered", chosen: [{ id: "a", label: "2 s" }] });
    await expect(tool.handler(AeAskUserSchema.parse({ ask_id: "ask_missing" }), ctx)).resolves.toMatchObject({
      ok: false,
      error: "unknown_ask_id",
    });
  });

  it("reports a dismissal", async () => {
    const store = new AskStore();
    const { ctx } = ctxWith(store);
    const pending = tool.handler(AeAskUserSchema.parse({ question: "How long?", options: [{ id: "a", label: "2 s" }, { id: "b", label: "3 s" }] }), ctx);
    await new Promise((r) => setTimeout(r, 5));
    store.answer(store.open()[0].id, { dismissed: true });
    await expect(pending).resolves.toMatchObject({ status: "dismissed" });
  });

  it("needs the panel-hosted MCP", async () => {
    const { ctx } = ctxWith(undefined);
    await expect(
      tool.handler(AeAskUserSchema.parse({ question: "Q?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }), ctx)
    ).resolves.toMatchObject({ ok: false, error: "panel_unavailable" });
  });

  it("validates the arguments", () => {
    const ok = (v: unknown) => AeAskUserSchema.safeParse(v).success;
    expect(ok({ question: "Q?" })).toBe(false); // no options
    expect(ok({ question: "Q?", options: [{ id: "a", label: "A" }] })).toBe(false); // one option
    expect(ok({ question: "Q?", kind: "ease", options: [{ id: "a", label: "A", curve: [0, 0, 1, 1] }, { id: "b", label: "B" }] })).toBe(false);
    expect(ok({ question: "Q?", options: [{ id: "a", label: "A" }, { id: "a", label: "B" }] })).toBe(false);
    expect(ok({ question: "Q?", options: [{ id: "a", label: "A", curve: [1.5, 0, 0, 1] }, { id: "b", label: "B" }] })).toBe(false);
    expect(ok({ ask_id: "ask_1" })).toBe(true);
  });

  it("checks image paths before asking", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ask-"));
    tmpDirs.push(dir);
    const png = path.join(dir, "variant.png");
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(checkImagePath(png)).toBeNull();
    expect(checkImagePath("relative.png")).toMatch(/absolute/);
    expect(checkImagePath(path.join(dir, "missing.png"))).toMatch(/does not exist/);
    expect(checkImagePath(path.join(dir, "notes.txt"))).toMatch(/PNG or JPEG/);

    const store = new AskStore();
    const { ctx } = ctxWith(store);
    const out = await tool.handler(
      AeAskUserSchema.parse({
        question: "Which look?",
        options: [{ id: "a", label: "A", image_path: path.join(dir, "missing.png") }, { id: "b", label: "B" }],
      }),
      ctx
    );
    expect(out).toMatchObject({ ok: false, error: "bad_image" });
    expect(store.open()).toHaveLength(0);
  });
});
