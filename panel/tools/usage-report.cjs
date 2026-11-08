#!/usr/bin/env node
// Usage report for the local usage log (<data dir>/usage/usage-YYYY-MM.jsonl, written by
// server/src/usage-log.ts). Plain text, markdown-friendly. No dependencies; runs on the Node
// that After Effects' CEP ships (17.7.2) and on current Node.
//
//   node panel/tools/usage-report.cjs [--days 7] [--dir <usage dir>]
//
// The log never leaves the machine; this script only reads it.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// Mirrors defaultDataDir() in server/src/quarantine.ts.
function defaultDataDir() {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "chroma-ae-mcp");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "chroma-ae-mcp");
  }
  return path.join(os.homedir(), ".local", "share", "chroma-ae-mcp");
}

function defaultUsageDir() {
  return path.join(defaultDataDir(), "usage");
}

// ae_search_tools scores come from BM25 in rankTools (server/src/toolsets.ts). A term found only in a
// tool description scores about 1 to 3.5; a hit in a tool name or hint words adds the field weight
// (5 and 3) and, for the name, 1.5 more, so real matches measured 4.9 to 12 and description-only
// matches measured 2.5 to 3.6. A search whose best hit scores below 4 found, at best, a tool that
// mentions one query word in passing, so the report lists it beside the searches with 0 hits.
const LOW_SEARCH_SCORE = 4;

function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

function localDay(d) {
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

/** Parse the text of one or more jsonl files. Returns the entries and the count of lines skipped. */
function parseLines(text) {
  const entries = [];
  let skipped = 0;
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object" && !Array.isArray(obj) && typeof obj.tool === "string") {
        entries.push(obj);
      } else {
        skipped++;
      }
    } catch (e) {
      skipped++;
    }
  }
  return { entries: entries, skipped: skipped };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Lower-case, digits and quotes stripped, spaces collapsed: "Set opacity 50 on 'Title'" -> "set opacity on title". */
function normalizeLabel(label) {
  return String(label || "")
    .toLowerCase()
    .replace(/[0-9"'`‘’“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function topN(map, n) {
  const rows = [];
  Object.keys(map).forEach(function (k) {
    rows.push([k, map[k]]);
  });
  rows.sort(function (a, b) {
    return b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  });
  return rows.slice(0, n);
}

function bump(map, key, by) {
  map[key] = (map[key] || 0) + (by === undefined ? 1 : by);
}

/**
 * Pure summary of log entries.
 * opts: { days (default 7), now (Date, default new Date()), skipped (unreadable lines already counted) }
 * Entries older than the period (by their local `day`) are left out.
 */
function summarize(entries, opts) {
  const o = opts || {};
  const days = o.days > 0 ? Math.floor(o.days) : 7;
  const now = o.now instanceof Date ? o.now : new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const fromDay = localDay(first);
  const toDay = localDay(now);

  const perDay = {};
  const tools = {};
  const labels = {};
  const emptySearches = {};
  const weakSearches = {};
  const busy = {};
  const clients = {};
  const jsx = { count: 0, reads: 0, writes: 0, failed: 0, codeChars: 0 };
  let total = 0;
  let failed = 0;
  let resultFailed = 0;
  let busyTotal = 0;
  let unreadable = o.skipped || 0;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || typeof e.tool !== "string") {
      unreadable++;
      continue;
    }
    const day = typeof e.day === "string" ? e.day : typeof e.ts === "string" ? e.ts.slice(0, 10) : "";
    if (!day || day < fromDay || day > toDay) continue;
    total++;
    bump(perDay, day);
    bump(clients, typeof e.client === "string" && e.client ? e.client : "(unknown)");
    let t = tools[e.tool];
    if (!t) {
      t = { calls: 0, fails: 0, resultFails: 0, kinds: {}, ms: [], chars: [] };
      tools[e.tool] = t;
    }
    t.calls++;
    if (typeof e.ms === "number" && isFinite(e.ms)) {
      // A call that waited on purpose (wait_seconds) is not slow: count only the time past the wait.
      const waited = typeof e.waited_ms === "number" && isFinite(e.waited_ms) && e.waited_ms > 0 ? e.waited_ms : 0;
      t.ms.push(Math.max(0, e.ms - waited));
    }
    if (typeof e.result_chars === "number" && isFinite(e.result_chars) && e.result_chars >= 0) t.chars.push(e.result_chars);
    if (e.ok === true && e.result_ok === false) {
      // The tool returned { ok: false } without an MCP error: still a failure for this report.
      failed++;
      resultFailed++;
      t.fails++;
      t.resultFails++;
      const rk = typeof e.result_kind === "string" && e.result_kind ? e.result_kind : "unspecified";
      bump(t.kinds, "result:" + rk);
    }
    if (e.ok === false) {
      failed++;
      t.fails++;
      const kind = typeof e.error_kind === "string" && e.error_kind ? e.error_kind : "error";
      bump(t.kinds, kind);
      if (kind === "queued" || kind === "busy") {
        busyTotal++;
        bump(busy, e.tool);
      }
    }
    if (e.tool === "ae_run_jsx") {
      jsx.count++;
      if (e.mutates === true) jsx.writes++;
      else jsx.reads++;
      if (e.ok === false || e.result_ok === false) jsx.failed++;
      if (typeof e.code_chars === "number") jsx.codeChars += e.code_chars;
      const key = normalizeLabel(e.label) || "(no label)";
      bump(labels, key);
    }
    if (e.tool === "ae_search_tools" && e.ok !== false) {
      const what =
        typeof e.query === "string" && e.query.trim()
          ? e.query.toLowerCase().trim()
          : typeof e.group === "string" && e.group
            ? "group:" + e.group
            : "(empty)";
      if (e.hits === 0) {
        bump(emptySearches, what);
      } else if (typeof e.top_score === "number" && e.top_score < LOW_SEARCH_SCORE) {
        bump(weakSearches, what + " (best: " + (typeof e.top === "string" ? e.top : "?") + ", score " + e.top_score + ")");
      }
    }
  }

  const toolRows = [];
  Object.keys(tools).forEach(function (name) {
    const t = tools[name];
    const sorted = t.ms.slice().sort(function (a, b) {
      return a - b;
    });
    const sortedChars = t.chars.slice().sort(function (a, b) {
      return a - b;
    });
    toolRows.push({
      tool: name,
      medianChars: percentile(sortedChars, 50),
      maxChars: sortedChars.length ? sortedChars[sortedChars.length - 1] : 0,
      sized: sortedChars.length,
      calls: t.calls,
      fails: t.fails,
      resultFails: t.resultFails,
      failRate: t.calls ? t.fails / t.calls : 0,
      kinds: topN(t.kinds, 5),
      medianMs: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      timed: sorted.length,
    });
  });
  toolRows.sort(function (a, b) {
    return b.calls - a.calls || (a.tool < b.tool ? -1 : 1);
  });

  const dayRows = [];
  const dayKeys = Object.keys(perDay).sort();
  for (let j = 0; j < dayKeys.length; j++) dayRows.push([dayKeys[j], perDay[dayKeys[j]]]);

  return {
    from: fromDay,
    to: toDay,
    days: days,
    total: total,
    failed: failed,
    resultFailed: resultFailed,
    unreadable: unreadable,
    perDay: dayRows,
    topTools: toolRows.slice(0, 15),
    failing: toolRows
      .filter(function (r) {
        return r.fails > 0;
      })
      .sort(function (a, b) {
        return b.fails - a.fails || b.failRate - a.failRate;
      })
      .slice(0, 15),
    slowest: toolRows
      .filter(function (r) {
        return r.timed >= 5;
      })
      .sort(function (a, b) {
        return b.p95Ms - a.p95Ms;
      })
      .slice(0, 10),
    largest: toolRows
      .filter(function (r) {
        return r.sized >= 3;
      })
      .sort(function (a, b) {
        return b.medianChars - a.medianChars || b.maxChars - a.maxChars || (a.tool < b.tool ? -1 : 1);
      })
      .slice(0, 10),
    runJsx: {
      count: jsx.count,
      reads: jsx.reads,
      writes: jsx.writes,
      failed: jsx.failed,
      avgCodeChars: jsx.count ? Math.round(jsx.codeChars / jsx.count) : 0,
      labels: topN(labels, 20),
    },
    emptySearches: topN(emptySearches, 20),
    weakSearches: topN(weakSearches, 20),
    lowSearchScore: LOW_SEARCH_SCORE,
    perClient: topN(clients, 20),
    busy: { total: busyTotal, byTool: topN(busy, 10) },
  };
}

function pct(x) {
  return Math.round(x * 100) + "%";
}

function render(s) {
  const out = [];
  out.push("Private: this report contains the user's own project wording (ae_run_jsx labels and search queries). It is not for pasting publicly.");
  out.push("");
  out.push("# Usage report");
  out.push("");
  out.push("Period: " + s.from + " to " + s.to + " (" + s.days + " days)");
  out.push("Calls: " + s.total + ", failed: " + s.failed + (s.total ? " (" + pct(s.failed / s.total) + ")" : ""));
  if (s.resultFailed) out.push("Failed includes " + s.resultFailed + " call(s) that returned ok: false without an MCP error.");
  if (s.unreadable) out.push("Unreadable lines skipped: " + s.unreadable);
  if (s.total === 0) {
    out.push("");
    out.push("No calls in this period.");
    return out.join("\n") + "\n";
  }

  out.push("");
  out.push("## Calls per day");
  s.perDay.forEach(function (r) {
    out.push("- " + r[0] + ": " + r[1]);
  });

  out.push("");
  out.push("## Calls per client");
  s.perClient.forEach(function (r) {
    out.push("- " + r[0] + ": " + r[1]);
  });

  out.push("");
  out.push("## Top tools by calls");
  s.topTools.forEach(function (r) {
    out.push("- " + r.tool + ": " + r.calls);
  });

  out.push("");
  out.push("## Tools that fail");
  out.push("A failure is an MCP error, or a result with ok: false (kinds shown as result:<code>).");
  if (s.failing.length === 0) out.push("- none");
  s.failing.forEach(function (r) {
    const kinds = r.kinds
      .map(function (k) {
        return k[0] + " " + k[1];
      })
      .join(", ");
    out.push("- " + r.tool + ": " + r.fails + " of " + r.calls + " (" + pct(r.failRate) + ") - " + kinds);
  });

  out.push("");
  out.push("## Slowest tools (5 or more calls)");
  out.push("Time spent waiting on purpose (wait_seconds, logged as waited_ms) is subtracted: ms - waited_ms.");
  if (s.slowest.length === 0) out.push("- none");
  s.slowest.forEach(function (r) {
    out.push("- " + r.tool + ": median " + r.medianMs + " ms, p95 " + r.p95Ms + " ms (" + r.calls + " calls)");
  });

  out.push("");
  out.push("## Largest results by tool (3 or more calls with a recorded size)");
  out.push("Characters of text returned to the client; the biggest outputs are the ones to slim next.");
  if (s.largest.length === 0) out.push("- none");
  s.largest.forEach(function (r) {
    out.push("- " + r.tool + ": median " + r.medianChars + " chars, max " + r.maxChars + " chars (" + r.sized + " calls)");
  });

  out.push("");
  out.push("## ae_run_jsx (what was done by hand because no tool fitted)");
  out.push(
    "Calls: " + s.runJsx.count + ", reads: " + s.runJsx.reads + ", writes: " + s.runJsx.writes + ", failed: " + s.runJsx.failed
  );
  if (s.runJsx.count) out.push("Average code size: " + s.runJsx.avgCodeChars + " characters");
  s.runJsx.labels.forEach(function (r) {
    out.push("- " + r[1] + " x " + r[0]);
  });

  out.push("");
  out.push("## ae_search_tools queries that found nothing");
  if (s.emptySearches.length === 0) out.push("- none");
  s.emptySearches.forEach(function (r) {
    out.push("- " + r[1] + " x " + r[0]);
  });

  out.push("");
  out.push("## ae_search_tools queries with only a weak match (best score below " + s.lowSearchScore + ")");
  if (s.weakSearches.length === 0) out.push("- none");
  s.weakSearches.forEach(function (r) {
    out.push("- " + r[1] + " x " + r[0]);
  });

  out.push("");
  out.push("## Refused while AE was busy (queued/busy)");
  out.push("Total: " + s.busy.total);
  s.busy.byTool.forEach(function (r) {
    out.push("- " + r[0] + ": " + r[1]);
  });

  return out.join("\n") + "\n";
}

/** Read every usage-YYYY-MM.jsonl in a directory. Never throws. */
function readDir(dir) {
  const entries = [];
  let skipped = 0;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return { entries: entries, skipped: skipped, missing: true };
  }
  names.sort();
  for (let i = 0; i < names.length; i++) {
    if (!/^usage-\d{4}-\d{2}\.jsonl$/.test(names[i])) continue;
    try {
      const parsed = parseLines(fs.readFileSync(path.join(dir, names[i]), "utf8"));
      for (let j = 0; j < parsed.entries.length; j++) entries.push(parsed.entries[j]);
      skipped += parsed.skipped;
    } catch (e) {
      skipped++;
    }
  }
  return { entries: entries, skipped: skipped, missing: false };
}

function parseArgs(argv) {
  const opts = { days: 7, dir: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days" && i + 1 < argv.length) {
      const n = parseInt(argv[++i], 10);
      if (n > 0) opts.days = n;
    } else if (argv[i] === "--dir" && i + 1 < argv.length) {
      opts.dir = argv[++i];
    }
  }
  return opts;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.dir || defaultUsageDir();
  const read = readDir(dir);
  if (read.missing) {
    process.stdout.write("No usage log found in " + dir + "\n");
    return;
  }
  process.stdout.write(render(summarize(read.entries, { days: args.days, skipped: read.skipped })));
}

module.exports = { summarize: summarize, render: render, parseLines: parseLines, normalizeLabel: normalizeLabel, readDir: readDir };

if (require.main === module) main();
