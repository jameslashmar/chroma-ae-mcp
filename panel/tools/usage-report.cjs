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
  const busy = {};
  const clients = {};
  const jsx = { count: 0, reads: 0, writes: 0, failed: 0, codeChars: 0 };
  let total = 0;
  let failed = 0;
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
      t = { calls: 0, fails: 0, kinds: {}, ms: [] };
      tools[e.tool] = t;
    }
    t.calls++;
    if (typeof e.ms === "number" && isFinite(e.ms)) t.ms.push(e.ms);
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
      if (e.ok === false) jsx.failed++;
      if (typeof e.code_chars === "number") jsx.codeChars += e.code_chars;
      const key = normalizeLabel(e.label) || "(no label)";
      bump(labels, key);
    }
    if (e.tool === "ae_search_tools" && e.ok !== false && e.hits === 0 && typeof e.query === "string") {
      bump(emptySearches, e.query.toLowerCase().trim() || "(empty)");
    }
  }

  const toolRows = [];
  Object.keys(tools).forEach(function (name) {
    const t = tools[name];
    const sorted = t.ms.slice().sort(function (a, b) {
      return a - b;
    });
    toolRows.push({
      tool: name,
      calls: t.calls,
      fails: t.fails,
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
    runJsx: {
      count: jsx.count,
      reads: jsx.reads,
      writes: jsx.writes,
      failed: jsx.failed,
      avgCodeChars: jsx.count ? Math.round(jsx.codeChars / jsx.count) : 0,
      labels: topN(labels, 20),
    },
    emptySearches: topN(emptySearches, 20),
    perClient: topN(clients, 20),
    busy: { total: busyTotal, byTool: topN(busy, 10) },
  };
}

function pct(x) {
  return Math.round(x * 100) + "%";
}

function render(s) {
  const out = [];
  out.push("# Usage report");
  out.push("");
  out.push("Period: " + s.from + " to " + s.to + " (" + s.days + " days)");
  out.push("Calls: " + s.total + ", failed: " + s.failed + (s.total ? " (" + pct(s.failed / s.total) + ")" : ""));
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
  if (s.slowest.length === 0) out.push("- none");
  s.slowest.forEach(function (r) {
    out.push("- " + r.tool + ": median " + r.medianMs + " ms, p95 " + r.p95Ms + " ms (" + r.calls + " calls)");
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
