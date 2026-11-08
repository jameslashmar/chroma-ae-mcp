import { z } from "zod";
import { zodToJsonSchema } from "./schema.js";
import {
  CORE_TOOL_NAMES,
  META_TOOL_NAMES,
  TOOL_GROUPS,
  closestToolNames,
  firstSentences,
  groupCounts,
  groupOf,
  rankTools,
  stripSafety,
  trimSchema,
  type ListedTool,
} from "./toolsets.js";
import { callTool, findTool, type CallOptions, type ToolCallResult } from "./tool-call.js";
import { AGENT_SAFETY_GUIDANCE, formatToolError, formatToolResponse, type ToolContext } from "./tools/common.js";
import { ALL_TOOLS } from "./tools/registry.js";
import { recordUsage } from "./usage-log.js";

/**
 * The three meta-tools of the core toolset. ae_search_tools and ae_get_tool_schema run in Node
 * and never touch After Effects (no bridge, no queue), so they answer while AE is busy, blocked by
 * a modal or rendering. ae_invoke_tool hands the call to the real tool, which goes to AE like any
 * other call and is refused while AE renders. They are not in ALL_TOOLS. tools/call accepts them
 * in either toolset; tools/list shows them only in the core one.
 */

export const SEARCH_OUTPUT_MAX = 20_000;
/** ae_get_tool_schema stops adding tools once the total passes this; the rest are listed in `omitted`. */
export const SCHEMA_OUTPUT_SOFT_MAX = 40_000;
export const NAME_MAX = 80;
const CORE_SET = new Set<string>(CORE_TOOL_NAMES);

const ToolName = z.string().min(1).max(NAME_MAX);

const SearchArgs = z
  .object({
    query: z.string().max(500).optional(),
    pattern: z.string().max(200).optional(),
    group: z.string().max(60).optional(),
    limit: z.number().int().min(1).max(20).optional(),
    offset: z.number().int().min(0).max(1000).optional(),
    detail: z.enum(["summary", "schema"]).optional(),
  })
  .strict();

const SchemaArgs = z
  .object({
    name: ToolName.optional(),
    names: z.array(ToolName).min(1).max(5).optional(),
  })
  .strict();

const InvokeArgs = z
  .object({
    name: ToolName,
    arguments: z.record(z.unknown()).optional(),
  })
  .strict();

interface MetaTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  schema: z.ZodTypeAny;
  /** Said when a field is not in the schema (strict): where it probably belongs. */
  unknownFieldHint: string;
  /** Whether the call writes its own `tool ... ok` log line (ae_invoke_tool does not: the inner call logs). */
  logsItself: boolean;
  run: (args: any, ctx: ToolContext, opts: CallOptions, usage: { query?: string; hits?: number }) => Promise<ToolCallResult>;
}

function sizeOf(value: unknown): number {
  return JSON.stringify(value, null, 2).length;
}

/** One line of plain text: no control characters or line breaks, so nothing can forge a log line. */
export function oneLine(text: string, max: number): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim().slice(0, max);
}

/** `^` anchors the start, `$` the end; everything else is literal. Case-insensitive. Never a RegExp. */
export function nameMatcher(pattern: string): (name: string) => boolean {
  let p = pattern.toLowerCase();
  const start = p.startsWith("^");
  if (start) p = p.slice(1);
  const end = p.endsWith("$");
  if (end) p = p.slice(0, -1);
  return (name: string) => {
    const n = name.toLowerCase();
    if (start && end) return n === p;
    if (start) return n.startsWith(p);
    if (end) return n.endsWith(p);
    return n.includes(p);
  };
}

// ---------- ae_search_tools ----------

async function runSearch(args: z.infer<typeof SearchArgs>, usage: { query?: string; hits?: number }): Promise<ToolCallResult> {
  const detail = args.detail ?? "summary";
  const limit = args.limit ?? 8;
  const offset = args.offset ?? 0;
  const query = (args.query ?? "").trim();
  const pattern = (args.pattern ?? "").trim();
  const group = (args.group ?? "").trim();

  if (!query && !pattern && !group) {
    return formatToolResponse({
      total_tools: ALL_TOOLS.length,
      listed_directly: CORE_TOOL_NAMES.length,
      groups: groupCounts(),
      next: "Call again with `query` (keywords), `pattern` (a name fragment, ^ and $ anchor it) and/or `group`. Then ae_get_tool_schema { name }, then ae_invoke_tool { name, arguments }.",
    });
  }

  if (group && !Object.prototype.hasOwnProperty.call(TOOL_GROUPS, group)) {
    return formatToolError(new Error(`Unknown group "${oneLine(group, 60)}". Groups: ${Object.keys(TOOL_GROUPS).join(", ")}.`));
  }

  const matches = pattern ? nameMatcher(pattern) : null;
  const candidates = ALL_TOOLS.filter((t) => (!group || groupOf(t.name) === group) && (!matches || matches(t.name)));
  let ordered: Array<{ name: string; tool: (typeof ALL_TOOLS)[number]; score?: number }>;
  if (query) {
    const allowed = new Set(candidates.map((t) => t.name));
    ordered = rankTools(query, allowed).map((r) => ({ name: r.tool.name, tool: r.tool, score: Math.round(r.score * 100) / 100 }));
  } else {
    ordered = candidates.map((t) => ({ name: t.name, tool: t }));
  }
  const total = ordered.length;
  usage.query = query || pattern || group;
  usage.hits = total;

  const page: Array<Record<string, unknown>> = [];
  for (const o of ordered.slice(offset, offset + limit)) {
    const entry: Record<string, unknown> = {
      name: o.name,
      group: groupOf(o.name) ?? null,
      call: CORE_SET.has(o.name) ? "direct" : "ae_invoke_tool",
      summary: firstSentences(stripSafety(o.tool.description), 220),
    };
    if (o.score !== undefined) entry.score = o.score;
    if (detail === "schema") entry.inputSchema = trimSchema(zodToJsonSchema(o.tool.schema), o.tool.name);
    page.push(entry);
  }

  // Every field is in the object before the size check, so the cap holds for the whole reply.
  const build = (n: number, withSchema = true): Record<string, unknown> => {
    const rows = page.slice(0, n).map((e) => {
      if (withSchema || !("inputSchema" in e)) return e;
      const { inputSchema: _dropped, ...rest } = e;
      return rest;
    });
    const result: Record<string, unknown> = { total_matches: total, offset, returned: n, matches: rows };
    if (!withSchema) {
      result.schema_omitted = "A single schema does not fit in this reply; get it with ae_get_tool_schema { name }.";
    }
    const cutBySize = n < page.length;
    if (cutBySize) result.truncated = true;
    if (offset + n < total) {
      result.next_offset = offset + n;
      result.more = cutBySize
        ? `The reply was cut at ${SEARCH_OUTPUT_MAX} characters (detail "schema" is large); call again with offset ${offset + n}, or use detail "summary".`
        : `${total - offset - n} more match(es): call again with offset ${offset + n}, or narrow the search (group, pattern).`;
    }
    if (n === 0) {
      result.hint = total === 0
        ? "No match. Try other words, a `pattern` such as ^ae_track, or an empty call to list the groups."
        : `Nothing at offset ${offset}; there are ${total} matches.`;
    } else {
      result.next = "Read ae_get_tool_schema { name } before the first use. Call tools marked direct by name; call the others with ae_invoke_tool { name, arguments }.";
    }
    return result;
  };
  let n = page.length;
  let result = build(n);
  while (n > 1 && sizeOf(result) > SEARCH_OUTPUT_MAX) {
    n--;
    result = build(n);
  }
  // Even one schema can be too big once printed: send the summary and point at ae_get_tool_schema.
  if (sizeOf(result) > SEARCH_OUTPUT_MAX) result = build(n, false);
  return formatToolResponse(result);
}

// ---------- ae_get_tool_schema ----------

async function runGetSchema(args: z.infer<typeof SchemaArgs>): Promise<ToolCallResult> {
  const wanted: string[] = [];
  if (args.name) wanted.push(args.name);
  if (args.names) for (const n of args.names) if (!wanted.includes(n)) wanted.push(n);
  if (wanted.length === 0) return formatToolError(new Error("Give `name` or `names` (up to 5)."));
  if (wanted.length > 5) return formatToolError(new Error("At most 5 names per call."));

  const tools: Array<Record<string, unknown>> = [];
  const notFound: Array<{ name: string; closest: string[] }> = [];
  const omitted: string[] = [];
  let total = 0;
  for (const name of wanted) {
    const t = findTool(name);
    if (!t) {
      notFound.push({ name: oneLine(name, NAME_MAX), closest: closestToolNames(name) });
      continue;
    }
    if (total > SCHEMA_OUTPUT_SOFT_MAX) {
      omitted.push(t.name);
      continue;
    }
    const entry = {
      name: t.name,
      group: groupOf(t.name) ?? null,
      call: CORE_SET.has(t.name) ? "direct" : "ae_invoke_tool",
      // Verbatim, including the safety text for tools that carry it.
      description: t.description,
      inputSchema: zodToJsonSchema(t.schema),
    };
    total += JSON.stringify(entry).length;
    tools.push(entry);
  }
  if (tools.length === 0) {
    return formatToolError(
      new Error(
        `Unknown tool: ${notFound.map((n) => n.name).join(", ")}. Closest: ${notFound.map((n) => n.closest.join(", ")).join(" | ")}. Use ae_search_tools to find a tool.`
      )
    );
  }
  const result: Record<string, unknown> = { tools };
  if (notFound.length) result.not_found = notFound;
  if (omitted.length) {
    result.omitted = omitted;
    result.omitted_note = `The reply passed ${SCHEMA_OUTPUT_SOFT_MAX} characters, so these were left out. Ask for them again, a few at a time.`;
  }
  return formatToolResponse(result);
}

// ---------- ae_invoke_tool ----------

async function runInvoke(args: z.infer<typeof InvokeArgs>, ctx: ToolContext, opts: CallOptions): Promise<ToolCallResult> {
  const name = oneLine(args.name, NAME_MAX);
  const base = { toolset: opts.toolset, client: opts.client, via: "ae_invoke_tool" as const };
  if ((META_TOOL_NAMES as readonly string[]).includes(args.name)) {
    const why = `ae_invoke_tool cannot call ${name}: it is a meta-tool. Call ${name} directly.`;
    ctx.log?.("err", `tool ae_invoke_tool failed (0ms): ${why}`);
    recordUsage(ctx, { tool: "ae_invoke_tool", ms: 0, ok: false, errorKind: "error", error: why, ...base });
    return formatToolError(new Error(why));
  }
  if (!findTool(args.name)) {
    const why = `Unknown tool: ${name}. Closest names: ${closestToolNames(args.name).join(", ")}. Use ae_search_tools to find a tool.`;
    ctx.log?.("err", `tool ae_invoke_tool failed (0ms): ${why}`);
    recordUsage(ctx, { tool: name, ms: 0, ok: false, errorKind: "unknown_tool", error: why, ...base });
    return formatToolError(new Error(why));
  }
  // Exactly the tools/call path, under the inner tool's own name; the usage log records the real tool once (via ae_invoke_tool).
  return callTool(args.name, args.arguments, ctx, { toolset: opts.toolset, client: opts.client, via: "ae_invoke_tool" });
}

// ---------- definitions ----------

const SEARCH_DESCRIPTION =
  `Find tools: ${ALL_TOOLS.length} After Effects tools exist but only ${CORE_TOOL_NAMES.length} are listed, so search the rest here. ` +
  "Give `query` (keywords, e.g. 'remove object from shot', 'captions', 'track'), `pattern` (a name fragment, not a regex: ^ anchors the start and $ the end, e.g. ^ae_track) and/or `group`; an empty call lists the groups; `offset` pages. " +
  "Then ae_get_tool_schema { name } for the full schema and ae_invoke_tool { name, arguments } to call it. Never touches After Effects.";

const GET_SCHEMA_DESCRIPTION =
  "Full description and full input schema of up to 5 tools, by `name` or `names`, including the safety text that guarded write tools carry. " +
  "Read it before the first call of a tool you have not used. Never touches After Effects.";

const INVOKE_DESCRIPTION =
  "Call any After Effects tool by name with its arguments: same validation, guard, receipt and errors as calling it directly (it goes to After Effects like any call, and is refused while AE renders). " +
  "Put the tool's arguments under `arguments`. Use it for tools that are not in the list (find them with ae_search_tools). It cannot call the meta-tools. Safety: " +
  AGENT_SAFETY_GUIDANCE;

const nameProp = { type: "string", minLength: 1, maxLength: NAME_MAX };

export const META_TOOLS: MetaTool[] = [
  {
    name: "ae_search_tools",
    description: SEARCH_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords over tool name, description and parameter names." },
        pattern: { type: "string", description: "Name fragment; ^ anchors the start, $ the end (e.g. ^ae_track). Not a regex." },
        group: { type: "string", description: "Only this group (an empty call lists them)." },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Matches to return (default 8)." },
        offset: { type: "integer", minimum: 0, maximum: 1000, description: "Matches to skip, to page (default 0)." },
        detail: { type: "string", enum: ["summary", "schema"], description: "schema adds each tool's (trimmed) input schema." },
      },
      additionalProperties: false,
    },
    schema: SearchArgs,
    unknownFieldHint: "Allowed fields: query, pattern, group, limit, offset, detail.",
    logsItself: true,
    run: (a, _ctx, _o, u) => runSearch(a, u),
  },
  {
    name: "ae_get_tool_schema",
    description: GET_SCHEMA_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        name: { ...nameProp, description: "A tool name." },
        names: { type: "array", items: nameProp, minItems: 1, maxItems: 5, description: "Up to 5 tool names." },
      },
      additionalProperties: false,
    },
    schema: SchemaArgs,
    unknownFieldHint: "Allowed fields: name, names.",
    logsItself: true,
    run: (a) => runGetSchema(a),
  },
  {
    name: "ae_invoke_tool",
    description: INVOKE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        name: { ...nameProp, description: "The tool to call." },
        arguments: { type: "object", description: "The tool's arguments, as its schema says." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    schema: InvokeArgs,
    unknownFieldHint: "Put the tool's arguments under `arguments`: { name, arguments: { ... } }. Fields beside `name` are not passed on.",
    logsItself: false,
    run: (a, ctx, o) => runInvoke(a, ctx, o),
  },
];

const META_BY_NAME = new Map(META_TOOLS.map((m) => [m.name, m] as const));

export function isMetaTool(name: string): boolean {
  return META_BY_NAME.has(name);
}

export function metaToolList(): ListedTool[] {
  return META_TOOLS.map((m) => ({ name: m.name, description: m.description, inputSchema: m.inputSchema }));
}

export async function callMetaTool(
  name: string,
  rawArgs: Record<string, unknown> | undefined,
  ctx: ToolContext,
  opts: CallOptions = {}
): Promise<ToolCallResult> {
  const meta = META_BY_NAME.get(name);
  if (!meta) return formatToolError(new Error(`Unknown tool: ${oneLine(name, NAME_MAX)}`));
  const started = Date.now();
  const parsed = meta.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const unknown = parsed.error.issues.some((i: z.ZodIssue) => i.code === "unrecognized_keys");
    const why = (
      `Invalid arguments for ${meta.name}: ${parsed.error.issues
        .map((i: z.ZodIssue) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}` + (unknown ? ` ${meta.unknownFieldHint}` : "")
    ).slice(0, 600);
    ctx.log?.("err", `tool ${meta.name} failed (${Date.now() - started}ms): ${oneLine(why, 200)}`);
    recordUsage(ctx, { tool: meta.name, ms: 0, ok: false, errorKind: "invalid_args", error: why, toolset: opts.toolset, client: opts.client, via: meta.name === "ae_invoke_tool" ? "ae_invoke_tool" : "direct" });
    return formatToolError(new Error(why));
  }
  const usage: { query?: string; hits?: number } = {};
  try {
    const result = await meta.run(parsed.data, ctx, opts, usage);
    if (meta.logsItself) {
      const failed = "isError" in result && result.isError === true;
      ctx.log?.(
        failed ? "err" : "ok",
        failed
          ? `tool ${meta.name} failed (${Date.now() - started}ms): ${oneLine((result.content[0] as { text?: string })?.text ?? "", 120)}`
          : `tool ${meta.name} ok (${Date.now() - started}ms)`
      );
      // ae_invoke_tool is recorded by callTool under the real tool's name, never here.
      recordUsage(ctx, {
        tool: meta.name,
        ms: Date.now() - started,
        ok: !failed,
        ...(failed ? { errorKind: "error", error: oneLine((result.content[0] as { text?: string })?.text ?? "", 160) } : {}),
        toolset: opts.toolset,
        client: opts.client,
        via: "direct",
        ...usage,
      });
    }
    return result;
  } catch (err) {
    const why = oneLine(err instanceof Error ? err.message : String(err), 200);
    ctx.log?.("err", `tool ${meta.name} failed (${Date.now() - started}ms): ${why}`);
    if (meta.logsItself) {
      recordUsage(ctx, { tool: meta.name, ms: Date.now() - started, ok: false, errorKind: "error", error: why, toolset: opts.toolset, client: opts.client, via: "direct", ...usage });
    }
    return formatToolError(err);
  }
}
