import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AerenderJobRegistry,
  cancelAerenderJob,
  launchAerenderJob,
  listEnginesAsync,
  type AerenderEngineInfo,
  type AerenderEngineList,
  type AerenderGateOptions,
  type LaunchAerenderParams,
  type SpawnLike,
} from "../src/tools/ext/aerender.js";

const PROJECT = "C:/Proj/Demo.aep";
const COOL = 20_000;
const LIMIT = 45_000;
const GAP = 10_000;
const DEAD = 300_000;
const SLOW = 60_000;

interface FakeChild extends EventEmitter {
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  unref: () => void;
}

function rig(over: { max_running?: number; engine_wait_ms?: number; engine_cache_ms?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aer-gate-"));
  let now = 1_000_000;
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  let timerSeq = 0;
  const engines: AerenderEngineInfo[] = [];
  /** CPU the fake engines burn, in ms per second of the fake clock (default 0: idle). */
  const rates = new Map<number, number>();
  const acct = new Map<number, { cpu: number; at: number }>();
  /** Adds the CPU the engine burnt since the last look at its current rate (a cumulative counter, as the real one is). */
  const integrate = (p: number) => {
    const a = acct.get(p) ?? { cpu: 0, at: now };
    a.cpu += ((rates.get(p) ?? 0) * (now - a.at)) / 1000;
    a.at = now;
    acct.set(p, a);
    return a.cpu;
  };
  const setRate = (p: number, perSecond: number) => {
    integrate(p);
    rates.set(p, perSecond);
  };
  const unkillable = new Set<number>();
  /** How the fake process list answers: sync, async, never, or "could not tell" (null). */
  const q = { fail: false, calls: 0, mode: "sync" as "sync" | "async" | "hang", delay_ms: 0 };
  const killed: number[] = [];
  const children: FakeChild[] = [];
  let pid = 5000;
  const spawn: SpawnLike = (() => {
    const c = new EventEmitter() as FakeChild;
    c.pid = ++pid;
    c.kill = vi.fn();
    c.unref = () => {};
    children.push(c);
    return c;
  }) as unknown as SpawnLike;
  const gateOpts: Partial<AerenderGateOptions> = {
    cool_down_ms: COOL,
    startup_limit_ms: LIMIT,
    sample_gap_ms: GAP,
    slow_check_ms: SLOW,
    dead_engine_ms: DEAD,
    poll_ms: 1000,
    engine_cache_ms: 0,
    ...over,
    now: () => now,
    set_timer: (fn, ms) => {
      const t = { id: ++timerSeq, at: now + ms, fn };
      timers.push(t);
      return t.id;
    },
    clear_timer: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    list_engines: () => {
      q.calls++;
      if (q.mode === "hang") return new Promise<AerenderEngineList>(() => {});
      const read = (): AerenderEngineList => (q.fail ? null : engines.map((e) => ({ ...e, cpu_ms: integrate(e.pid) })));
      if (q.mode === "async" && q.delay_ms > 0) {
        // Like the real PowerShell query: the answer comes later, on the fake clock.
        return new Promise<AerenderEngineList>((resolve) => {
          const t = { id: ++timerSeq, at: now + q.delay_ms, fn: () => resolve(read()) };
          timers.push(t);
        });
      }
      return q.mode === "async" ? Promise.resolve(read()) : read();
    },
    engines_known: true,
    kill_pid: (p) => {
      killed.push(p);
      if (unkillable.has(p)) return;
      const i = engines.findIndex((e) => e.pid === p);
      if (i >= 0) engines.splice(i, 1);
    },
  };
  const jobsFile = path.join(dir, "renders", "jobs.json");
  const registry = new AerenderJobRegistry(jobsFile, gateOpts);
  /** Moves the fake clock forward, running every timer that comes due on the way. */
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = timers[0];
      if (!next || next.at > target) break;
      timers.shift();
      now = Math.max(now, next.at);
      next.fn();
    }
    now = target;
  };
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  /** The same, letting promises settle after every timer (for an async process list). */
  const advanceAsync = async (ms: number) => {
    const target = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = timers[0];
      if (!next || next.at > target) break;
      timers.shift();
      now = Math.max(now, next.at);
      next.fn();
      await flush();
    }
    now = target;
    await flush();
  };
  const launch = (comp = "Main", extra: Partial<LaunchAerenderParams> = {}, reg: AerenderJobRegistry = registry) =>
    launchAerenderJob({
      registry: reg,
      spawn,
      aerender_path: "aerender.exe",
      project_path: PROJECT,
      comp_name: comp,
      output_path: path.join(dir, "out", `${comp}.mov`),
      ...extra,
    });
  const logOf = (jobId: string) => registry.get(jobId)!.log_path;
  const say = (jobId: string, text: string) => fs.appendFileSync(logOf(jobId), `${text}\n`);
  const exit = (c: FakeChild, code = 0) => c.emit("exit", code, null);
  const engineOf = (c: FakeChild, enginePid: number): AerenderEngineInfo => ({
    pid: enginePid,
    ppid: c.pid,
    command: `d -noui -m -s gAECommandLineRenderer.Render("'-port'","'[::1]:5'","'-project'","'C:\\\\Proj\\\\Demo.aep'")`,
  });
  /** A second registry on the same jobs file with the same gate options: a server restart or service reload. */
  const reload = () => new AerenderJobRegistry(jobsFile, gateOpts);
  return { dir, registry, children, engines, setRate, unkillable, q, killed, advance, advanceAsync, flush, launch, logOf, say, exit, engineOf, timers, reload };
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});
function make(over?: Parameters<typeof rig>[0]) {
  const r = rig(over);
  dirs.push(r.dir);
  return r;
}

describe("aerender start gate", () => {
  it("starts at once when nothing runs, with no cool-down owed and no engine alive", () => {
    const r = make();
    const rec = r.launch();
    expect(rec.state).toBe("running");
    expect(rec.phase).toBe("spawned");
    expect(rec.pid).toBe(r.children[0].pid);
    expect(r.children).toHaveLength(1);
    expect(rec.start_attempts).toBe(1);
    // Nothing could own an engine yet: the process list was not even asked.
    expect(r.q.calls).toBe(0);
  });

  it("holds a second job until the first has ended plus the cool-down, and does so with timers only", () => {
    const r = make();
    const a = r.launch("A");
    const b = r.launch("B");
    // Queued, not refused: state stays running so readers keep waiting; nothing was spawned.
    expect(b.state).toBe("running");
    expect(b.phase).toBe("queued");
    expect(b.pid).toBeNull();
    expect(b.queued_reason).toContain(a.job_id);
    expect(r.children).toHaveLength(1);
    expect(fs.readFileSync(b.log_path, "utf8")).toContain("AERENDER QUEUED");

    // A runs for a long time: B still waits.
    r.say(a.job_id, "PROGRESS: Launching After Effects...");
    r.say(a.job_id, "PROGRESS: 11/5/2026 4:43:20 AM: Starting composition");
    r.advance(120_000);
    expect(r.children).toHaveLength(1);
    expect(r.registry.get(b.job_id)!.phase).toBe("queued");

    // A ends. B waits for the cool-down from that moment.
    r.exit(r.children[0], 0);
    expect(r.registry.get(a.job_id)!.state).toBe("succeeded");
    r.advance(COOL - 2000);
    expect(r.children).toHaveLength(1);
    expect(r.registry.get(b.job_id)!.queued_reason).toContain("cool-down");
    r.advance(3000);
    expect(r.children).toHaveLength(2);
    const started = r.registry.get(b.job_id)!;
    expect(started.phase).toBe("spawned");
    expect(started.pid).toBe(r.children[1].pid);
    expect(r.registry.getProcess(b.job_id)).toBe(r.children[1]);
  });

  it("starts a job at once after the cool-down, without a timer round trip", () => {
    const r = make();
    const a = r.launch("A");
    r.exit(r.children[0], 0);
    expect(r.registry.get(a.job_id)!.state).toBe("succeeded");
    r.advance(COOL + 1);
    const b = r.launch("B");
    expect(b.phase).toBe("spawned");
    expect(r.children).toHaveLength(2);
  });

  it("starts queued jobs one at a time, in order", () => {
    const r = make();
    r.launch("A");
    const b = r.launch("B");
    const c = r.launch("C");
    r.exit(r.children[0], 0);
    r.advance(COOL + 1000);
    expect(r.children).toHaveLength(2);
    expect(r.registry.get(b.job_id)!.phase).toBe("spawned");
    expect(r.registry.get(c.job_id)!.phase).toBe("queued");
    r.exit(r.children[1], 0);
    r.advance(COOL + 1000);
    expect(r.children).toHaveLength(3);
    expect(r.registry.get(c.job_id)!.phase).toBe("spawned");
  });

  it("keeps a job queued while an AfterFX.com engine of an earlier job is alive, and ignores engines that are not from a job of this registry", () => {
    const r = make();
    const a = r.launch("A");
    const first = r.children[0];
    r.exit(first, 0);
    r.engines.push(r.engineOf(first, 7001));
    r.engines.push({ pid: 7002, ppid: 99999, command: "d -noui -m -s other.aep" });
    const b = r.launch("B");
    expect(b.phase).toBe("queued");
    r.advance(COOL + 5000);
    expect(r.children).toHaveLength(1);
    expect(r.registry.get(b.job_id)!.queued_reason).toContain("pid 7001");
    expect(r.registry.get(b.job_id)!.queued_reason).toContain(a.job_id);
    // The engine ends; the foreign engine is still there and does not matter.
    r.engines.splice(0, 1);
    r.advance(2000);
    expect(r.children).toHaveLength(2);
    expect(r.registry.get(b.job_id)!.phase).toBe("spawned");
    expect(r.killed).toEqual([]);
  });

  it("fails a queued job that waited too long for an earlier engine, names it and does not touch it", () => {
    const r = make({ engine_wait_ms: 60_000 });
    r.launch("A");
    const first = r.children[0];
    r.exit(first, 0);
    r.engines.push(r.engineOf(first, 7001));
    const b = r.launch("B");
    r.advance(90_000);
    const rec = r.registry.get(b.job_id)!;
    expect(rec.state).toBe("failed");
    expect(rec.error).toContain("pid 7001");
    expect(rec.error).toContain("not touched");
    expect(r.killed).toEqual([]);
    expect(r.children).toHaveLength(1);
  });

  it("cancelling a queued job removes it, and it never starts", () => {
    const r = make();
    r.launch("A");
    const b = r.launch("B");
    const res = cancelAerenderJob(r.registry, r.registry.get(b.job_id)!);
    expect(res.state).toBe("failed");
    expect(res.cancelled).toBe(true);
    r.exit(r.children[0], 0);
    r.advance(COOL + 5000);
    expect(r.children).toHaveLength(1);
  });

  it("a restart marks a job that was still queued as failed instead of leaving it running", () => {
    const r = make();
    r.launch("A");
    const b = r.launch("B");
    const reloaded = new AerenderJobRegistry(r.registry.path);
    expect(reloaded.get(b.job_id)!.state).toBe("failed");
    expect(reloaded.get(b.job_id)!.error).toContain("queued");
  });
});

describe("aerender gate: how long a queued job waits for an engine", () => {
  it("counts the engine wait from when the engine began blocking, not from when the job was queued", () => {
    const r = make(); // engine_wait_ms 120 s
    const a = r.launch("A");
    const first = r.children[0];
    r.say(a.job_id, "PROGRESS: 11/5/2026 4:43:20 AM: Starting composition");
    r.engines.push(r.engineOf(first, 7001));
    const b = r.launch("B");
    const c = r.launch("C");
    // A renders for 10 minutes; B and C have been queued the whole time.
    r.advance(600_000);
    r.exit(first, 0);
    // Its engine takes 21 s to shut down.
    r.advance(COOL + 1000);
    expect(r.registry.get(b.job_id)!.state).toBe("running");
    expect(r.registry.get(c.job_id)!.state).toBe("running");
    r.engines.splice(0, 1);
    r.advance(2000);
    expect(r.registry.get(b.job_id)!.phase).toBe("spawned");
    expect(r.children).toHaveLength(2);
    expect(r.registry.get(b.job_id)!.error).toBeUndefined();
  });

  it("fails the head after its own 120 s of waiting for an engine and gives the next job its own full wait", () => {
    const r = make();
    const a = r.launch("A");
    const first = r.children[0];
    r.say(a.job_id, "PROGRESS: 11/5/2026 4:43:20 AM: Starting composition");
    r.engines.push(r.engineOf(first, 7001));
    const b = r.launch("B");
    const c = r.launch("C");
    r.advance(600_000);
    r.exit(first, 0);
    r.advance(COOL + 100_000);
    expect(r.registry.get(b.job_id)!.state).toBe("running"); // ~120 s not yet reached
    r.advance(30_000);
    const rb = r.registry.get(b.job_id)!;
    expect(rb.state).toBe("failed");
    expect(rb.error).toMatch(/pid 7001/);
    // The number in the message is the wait, not the 10 minutes in the queue.
    const secs = Number(/(\d+) s after this job began to wait/.exec(rb.error ?? "")?.[1]);
    expect(secs).toBeGreaterThan(118);
    expect(secs).toBeLessThan(140);
    // C became the head only now and gets its own wait.
    expect(r.registry.get(c.job_id)!.state).toBe("running");
    expect(r.registry.get(c.job_id)!.phase).toBe("queued");
    r.advance(130_000);
    expect(r.registry.get(c.job_id)!.state).toBe("failed");
    expect(r.killed).toEqual([]);
  });

  it("does not fail a job for the engine of a job that is still running (no handle after a restart), and says so", () => {
    const r = make();
    const a = r.launch("A");
    const old = r.children[0];
    r.say(a.job_id, "PROGRESS: 11/5/2026 4:43:20 AM: Starting composition");
    r.setRate(7001, 300);
    // A server restart or service reload: a new registry reads A as still running, without a process handle.
    const again = r.reload();
    expect(again.get(a.job_id)!.state).toBe("running");
    r.engines.push(r.engineOf(old, 7001));
    const b = r.launch("B", {}, again);
    expect(b.phase).toBe("queued");
    r.advance(300_000); // well past engine_wait_ms
    const rb = again.get(b.job_id)!;
    expect(rb.state).toBe("running");
    expect(rb.queued_reason).toContain("still running");
    expect(r.killed).toEqual([]);
    // The render ends and the engine goes: B starts.
    r.engines.splice(0, 1);
    r.advance(3000);
    expect(again.get(b.job_id)!.phase).toBe("spawned");
  });

  it("words the failure for an engine of this job's own earlier attempt as such", () => {
    const r = make();
    const a = r.launch();
    const child = r.children[0];
    r.engines.push(r.engineOf(child, 7001));
    r.unkillable.add(7001); // the stop does not get rid of it
    r.advance(LIMIT + GAP + 1);
    expect(r.killed).toContain(7001);
    r.advance(COOL + 200_000);
    const rec = r.registry.get(a.job_id)!;
    expect(rec.state).toBe("failed");
    expect(rec.error).toContain("earlier attempt of this job");
    expect(rec.error).not.toContain("not this job's");
  });

  it("keeps a job queued, and starts it after the wait, when the process list cannot be read", () => {
    const r = make();
    r.launch("A");
    r.exit(r.children[0], 0);
    r.q.fail = true; // "could not tell"
    const b = r.launch("B");
    expect(b.phase).toBe("queued");
    r.advance(COOL + 60_000);
    expect(r.children).toHaveLength(1);
    expect(r.registry.get(b.job_id)!.queued_reason).toContain("could not read the process list");
    r.advance(100_000);
    expect(r.children).toHaveLength(2);
    expect(fs.readFileSync(b.log_path, "utf8")).toContain("could not be read");
  });
});

describe("aerender startup watchdog", () => {
  it("leaves a healthy job alone", () => {
    const r = make();
    const a = r.launch();
    const child = r.children[0];
    r.engines.push(r.engineOf(child, 7001));
    r.say(a.job_id, "aerender version 26.2.1x2");
    r.say(a.job_id, "PROGRESS: Launching After Effects...");
    r.say(a.job_id, "PROGRESS:  11/5/2026 4:43:20 AM: Starting composition");
    r.advance(LIMIT * 4);
    expect(child.kill).not.toHaveBeenCalled();
    expect(r.killed).toEqual([]);
    expect(r.registry.get(a.job_id)!.state).toBe("running");
    expect(r.registry.get(a.job_id)!.start_attempts).toBe(1);
    r.exit(child, 0);
    expect(r.registry.get(a.job_id)!.state).toBe("succeeded");
  });

  it("stops a start with no PROGRESS line and an idle engine (its own engine only), then starts it again, and fails it after the third attempt", () => {
    const r = make();
    const a = r.launch();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const child = r.children[attempt - 1];
      expect(child).toBeDefined();
      r.say(a.job_id, "aerender version 26.2.1x2");
      r.engines.push(r.engineOf(child, 7000 + attempt));
      // The user's own engine (another parent) and the user's AfterFX.exe stay.
      r.engines.push({ pid: 8000 + attempt, ppid: 123, command: "d -noui other" });
      r.advance(LIMIT + GAP + 1);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(r.killed).toContain(7000 + attempt);
      expect(r.killed).not.toContain(8000 + attempt);
      if (attempt < 3) {
        const mid = r.registry.get(a.job_id)!;
        expect(mid.state).toBe("running");
        expect(mid.phase).toBe("queued");
        expect(mid.pid).toBeNull();
        expect(mid.start_attempts).toBe(attempt);
        // Not started again before the cool-down.
        r.advance(COOL - 5000);
        expect(r.children).toHaveLength(attempt);
        r.advance(6000);
        expect(r.children).toHaveLength(attempt + 1);
        expect(r.registry.get(a.job_id)!.phase).toBe("spawned");
        expect(r.registry.get(a.job_id)!.start_attempts).toBe(attempt + 1);
      }
    }
    const done = r.registry.get(a.job_id)!;
    expect(done.state).toBe("failed");
    expect(done.start_attempts).toBe(3);
    expect(done.error).toContain("never started rendering");
    expect(done.error).toContain("3 attempts");
    expect(r.killed.every((p) => p >= 7001 && p <= 7003)).toBe(true);
    expect(r.children).toHaveLength(3);
    // The late exit events of the stopped attempts do not rewrite the failed job.
    r.exit(r.children[0], 1);
    expect(r.registry.get(a.job_id)!.error).toContain("never started rendering");
  });

  it("a retry that then shows progress is left alone and succeeds", () => {
    const r = make();
    const a = r.launch();
    r.say(a.job_id, "aerender version 26.2.1x2");
    r.advance(LIMIT + GAP + 1);
    r.advance(COOL + 1000);
    expect(r.children).toHaveLength(2);
    // The first attempt's lines are in the log too; only the second attempt's count.
    r.say(a.job_id, "PROGRESS: Launching After Effects...");
    r.say(a.job_id, "PROGRESS:  11/5/2026 4:43:20 AM: Starting composition");
    r.advance(LIMIT * 3);
    expect(r.children[1].kill).not.toHaveBeenCalled();
    r.exit(r.children[1], 0);
    expect(r.registry.get(a.job_id)!.state).toBe("succeeded");
    expect(r.registry.get(a.job_id)!.start_attempts).toBe(2);
  });

  it("a launch line alone counts as hung once the engine is gone", () => {
    const r = make();
    const b = r.launch();
    r.say(b.job_id, "PROGRESS: Launching After Effects...");
    r.advance(LIMIT + GAP + 1);
    expect(r.children[0].kill).toHaveBeenCalledTimes(1);
    expect(r.killed).toEqual([]);
  });

  it("never stops a job whose own engine is working, however long it takes (launch line, no progress for 20 minutes)", () => {
    const r = make();
    const a = r.launch();
    const child = r.children[0];
    r.say(a.job_id, "PROGRESS: Launching After Effects...");
    r.engines.push(r.engineOf(child, 7001));
    r.setRate(7001, 400); // 40 % of a core: a project still opening
    r.advance(20 * 60_000);
    expect(child.kill).not.toHaveBeenCalled();
    expect(r.killed).toEqual([]);
    expect(r.registry.get(a.job_id)!.start_attempts).toBe(1);
    // Same with no launch line at all.
    const r2 = make();
    const b = r2.launch();
    r2.engines.push(r2.engineOf(r2.children[0], 7002));
    r2.setRate(7002, 400);
    r2.advance(20 * 60_000);
    expect(r2.children[0].kill).not.toHaveBeenCalled();
    expect(r2.registry.get(b.job_id)!.state).toBe("running");
  });

  it("stops an engine that has gone idle after it was working, after two samples", () => {
    const r = make();
    const a = r.launch();
    const child = r.children[0];
    r.say(a.job_id, "PROGRESS: Launching After Effects...");
    r.engines.push(r.engineOf(child, 7001));
    r.setRate(7001, 400);
    r.advance(5 * 60_000);
    expect(child.kill).not.toHaveBeenCalled();
    r.setRate(7001, 0); // the CPU time stops growing; the engine stays
    // set the baseline: rate change takes effect from the next sample
    r.advance(10 * 60_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(r.killed).toContain(7001);
  });

  it("keeps waiting when the process list cannot be read (could not tell is not hung)", () => {
    const r = make();
    const a = r.launch();
    const child = r.children[0];
    r.engines.push(r.engineOf(child, 7001));
    r.q.fail = true;
    r.advance(10 * 60_000);
    expect(child.kill).not.toHaveBeenCalled();
    expect(r.killed).toEqual([]);
    expect(r.registry.get(a.job_id)!.state).toBe("running");
    // Readable again, and the engine really is idle: now it is stopped.
    r.q.fail = false;
    r.advance(LIMIT + 2 * GAP);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(r.killed).toContain(7001);
  });

  it("finds its own engine by parent pid alone, so a non-ASCII project path in a garbled command line does not hide it", () => {
    const r = make();
    r.launch("Main", { project_path: "C:/proje/şığ.aep" });
    const child = r.children[0];
    // The process list printed the path through a legacy code page.
    r.engines.push({ pid: 7001, ppid: child.pid, command: 'd -noui -m -s gAECommandLineRenderer.Render("\'-project\'","\'C:\\\\proje\\\\s?g.aep\'")' });
    r.advance(LIMIT + GAP + 1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(r.killed).toEqual([7001]);
    // And a working engine with the same garbled line is recognised as the job's and left alone.
    const r2 = make();
    r2.launch("Main", { project_path: "C:/proje/şığ.aep" });
    const c2 = r2.children[0];
    r2.engines.push({ pid: 7002, ppid: c2.pid, command: "d -noui s?g.aep" });
    r2.setRate(7002, 500);
    r2.advance(20 * 60_000);
    expect(c2.kill).not.toHaveBeenCalled();
  });

  it("does not arm the log-based watchdog for log_level errors: a healthy job without PROGRESS lines is not killed", () => {
    const r = make();
    const a = r.launch("Main", { log_level: "errors" });
    const child = r.children[0];
    r.engines.push(r.engineOf(child, 7001)); // present and idle for the moment: -v ERRORS prints nothing to judge by
    r.advance(10 * 60_000);
    expect(child.kill).not.toHaveBeenCalled();
    expect(r.killed).toEqual([]);
    expect(r.registry.get(a.job_id)!.state).toBe("running");
    expect(r.registry.get(a.job_id)!.start_attempts).toBe(1);
    r.exit(child, 0);
    expect(r.registry.get(a.job_id)!.state).toBe("succeeded");
  });

  it("cancelling a running job also stops its watchdog", () => {
    const r = make();
    const a = r.launch();
    cancelAerenderJob(r.registry, r.registry.get(a.job_id)!);
    expect(r.children[0].kill).toHaveBeenCalledTimes(1);
    r.advance(LIMIT * 5);
    expect(r.children[0].kill).toHaveBeenCalledTimes(1);
    expect(r.registry.get(a.job_id)!.cancelled).toBe(true);
    expect(r.killed).toEqual([]);
  });

  it("cancelling a running job also ends its own AfterFX.com engine, and no other", () => {
    const r = make();
    const a = r.launch();
    const child = r.children[0];
    r.engines.push(r.engineOf(child, 7001));
    r.engines.push({ pid: 7002, ppid: 4242, command: "d -noui other" });
    cancelAerenderJob(r.registry, r.registry.get(a.job_id)!);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(r.killed).toEqual([7001]);
    expect(fs.readFileSync(r.registry.get(a.job_id)!.log_path, "utf8")).toContain("ended its AfterFX.com engine pid 7001");
    // A job that comes next is not held back by a leftover engine.
    const b = r.launch("B");
    r.advance(COOL + 1000);
    expect(r.registry.get(b.job_id)!.phase).toBe("spawned");
  });
});

describe("aerender slow check after the start", () => {
  it("fails a job whose engine died after progress and whose aerender neither exits nor logs, and frees the slot", () => {
    const r = make();
    const a = r.launch("A");
    const b = r.launch("B");
    const child = r.children[0];
    r.say(a.job_id, "PROGRESS: Launching After Effects...");
    r.say(a.job_id, "PROGRESS:  11/5/2026 4:43:20 AM: Starting composition");
    r.engines.push(r.engineOf(child, 7001));
    r.advance(60 * 60_000); // an hour of rendering with a live engine: untouched
    expect(r.registry.get(a.job_id)!.state).toBe("running");
    expect(child.kill).not.toHaveBeenCalled();
    r.engines.splice(0, 1); // the engine dies; aerender hangs
    r.advance(DEAD - 2 * SLOW);
    expect(r.registry.get(a.job_id)!.state).toBe("running");
    r.advance(3 * SLOW);
    const rec = r.registry.get(a.job_id)!;
    expect(rec.state).toBe("failed");
    expect(rec.error).toContain("engine has been gone");
    expect(child.kill).toHaveBeenCalledTimes(1);
    // The queued job gets the slot (after the cool-down).
    r.advance(COOL + 2000);
    expect(r.children).toHaveLength(2);
    expect(r.registry.get(b.job_id)!.phase).toBe("spawned");
  });

  it("does not fail a job whose engine is gone but whose log keeps growing, or whose engine is alive and idle", () => {
    const r = make();
    const a = r.launch("A");
    const child = r.children[0];
    r.say(a.job_id, "PROGRESS:  11/5/2026 4:43:20 AM: Starting composition");
    // No engine in the list, but aerender keeps writing.
    for (let i = 0; i < 15; i++) {
      r.say(a.job_id, `PROGRESS:  frame ${i}`);
      r.advance(SLOW);
    }
    expect(r.registry.get(a.job_id)!.state).toBe("running");
    // An engine that is alive (even idle) is never a dead engine.
    r.engines.push(r.engineOf(child, 7001));
    r.advance(3 * DEAD);
    expect(r.registry.get(a.job_id)!.state).toBe("running");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("applies to a log_level errors job too (its log never grows, so only a dead engine counts)", () => {
    const r = make();
    const a = r.launch("A", { log_level: "errors" });
    const child = r.children[0];
    r.engines.push(r.engineOf(child, 7001));
    r.advance(30 * 60_000);
    expect(r.registry.get(a.job_id)!.state).toBe("running");
    r.engines.splice(0, 1);
    r.advance(DEAD + 3 * SLOW);
    expect(r.registry.get(a.job_id)!.state).toBe("failed");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});

describe("aerender gate: process list queries", () => {
  it("is cached: a queued job polling every second does not query the process list every second", () => {
    const r = make({ engine_cache_ms: 5000 });
    r.launch("A");
    const first = r.children[0];
    r.exit(first, 0);
    r.engines.push(r.engineOf(first, 7001));
    r.launch("B");
    r.q.calls = 0;
    r.advance(60_000);
    // One query per cache period (plus the very first), not one per 1 s poll.
    expect(r.q.calls).toBeGreaterThan(0);
    expect(r.q.calls).toBeLessThanOrEqual(15);
  });

  it("works with an asynchronous process list and never waits for it in the poll", async () => {
    const r = make();
    r.q.mode = "async";
    r.launch("A");
    const first = r.children[0];
    r.exit(first, 0);
    r.engines.push(r.engineOf(first, 7001));
    const b = r.launch("B");
    expect(b.phase).toBe("queued");
    await r.advanceAsync(COOL + 5000);
    expect(r.children).toHaveLength(1);
    expect(r.registry.get(b.job_id)!.queued_reason).toContain("pid 7001");
    r.engines.splice(0, 1);
    await r.advanceAsync(3000);
    expect(r.children).toHaveLength(2);
  });

  it("a process list that never answers holds a job in the queue but does not stop the timers or throw", async () => {
    const r = make();
    r.launch("A");
    r.exit(r.children[0], 0);
    r.q.mode = "hang";
    const b = r.launch("B");
    await r.advanceAsync(COOL + 60_000);
    expect(r.children).toHaveLength(1);
    expect(r.registry.get(b.job_id)!.state).toBe("running");
    expect(r.registry.get(b.job_id)!.queued_reason).toContain("checking");
  });

  it("listEnginesAsync asks without blocking, reads CPU time, forces UTF-8 and answers null when it cannot tell", async () => {
    const calls: string[][] = [];
    const run = async (file: string, args: string[]): Promise<string> => {
      calls.push([file, ...args]);
      if (file === "tasklist") return '"AfterFX.com","7001","Console","1","100,000 K"\r\n';
      return ["7001", "5000", "30000000", 'd -noui "C:\\proje\\şığ.aep"'].join("\t") + "\r\n";
    };
    const list = await listEnginesAsync(run, "win32");
    expect(list).toEqual([{ pid: 7001, ppid: 5000, cpu_ms: 3000, command: 'd -noui "C:\\proje\\şığ.aep"' }]);
    const script = calls[1][calls[1].length - 1];
    expect(script).toContain("OutputEncoding");
    expect(script).toContain("UTF8");
    expect(script).toContain("KernelModeTime");
    // None running: an empty list, and the slow query is skipped.
    expect(await listEnginesAsync(async () => "INFO: No tasks are running which match the specified criteria.\r\n", "win32")).toEqual([]);
    // A failed or timed-out query is "could not tell", not "no engine".
    expect(await listEnginesAsync(async () => { throw new Error("timed out"); }, "win32")).toBeNull();
    expect(await listEnginesAsync(run, "linux")).toBeNull();
  });
});

describe("aerender gate: the 120 s limits with the production (asynchronous, cached) process list", () => {
  // Default engine_cache_ms (5000) and a list that answers 400 ms after it is asked, as the real one does.
  const asyncRig = () => {
    const r = make({ engine_cache_ms: 5000 });
    r.q.mode = "async";
    r.q.delay_ms = 400;
    return r;
  };

  it("fails a job behind a leftover engine about 120 s after it began to wait, and keeps the real reason in between", async () => {
    const r = asyncRig();
    r.launch("A");
    const first = r.children[0];
    r.exit(first, 0);
    r.engines.push(r.engineOf(first, 7001));
    const b = r.launch("B");
    await r.advanceAsync(COOL + 10_000);
    expect(r.registry.get(b.job_id)!.queued_reason).toContain("pid 7001");
    // Past several cache refreshes the reason stays the real one, never "checking".
    for (let i = 0; i < 90; i++) {
      await r.advanceAsync(1000);
      expect(r.registry.get(b.job_id)!.queued_reason).toContain("pid 7001");
    }
    expect(r.registry.get(b.job_id)!.state).toBe("running");
    await r.advanceAsync(60_000);
    const rec = r.registry.get(b.job_id)!;
    expect(rec.state).toBe("failed");
    expect(rec.error).toContain("pid 7001");
    expect(r.children).toHaveLength(1);
    expect(r.killed).toEqual([]);
  });

  it("starts a job after the wait when the process list stays unreadable", async () => {
    const r = asyncRig();
    r.launch("A");
    r.exit(r.children[0], 0);
    r.q.fail = true; // "could not tell"
    const b = r.launch("B");
    await r.advanceAsync(COOL + 100_000);
    expect(r.children).toHaveLength(1);
    expect(r.registry.get(b.job_id)!.queued_reason).toContain("could not read the process list");
    await r.advanceAsync(60_000);
    expect(r.children).toHaveLength(2);
    expect(fs.readFileSync(b.log_path, "utf8")).toContain("could not be read");
  });

  it("fails a job whose own stopped attempt left an engine behind, about 120 s after the watchdog stopped it", async () => {
    const r = asyncRig();
    const a = r.launch();
    r.engines.push(r.engineOf(r.children[0], 7001));
    r.unkillable.add(7001); // the stop does not get rid of it
    await r.advanceAsync(LIMIT + GAP + 5000);
    expect(r.killed).toContain(7001);
    await r.advanceAsync(COOL + 60_000);
    expect(r.registry.get(a.job_id)!.state).toBe("running");
    await r.advanceAsync(200_000);
    const rec = r.registry.get(a.job_id)!;
    expect(rec.state).toBe("failed");
    expect(rec.error).toContain("earlier attempt of this job");
    expect(r.children).toHaveLength(1);
  });

  it("gives a job its own full wait once the running owner it waited for is cancelled", async () => {
    const r = asyncRig();
    const a = r.launch("A");
    const old = r.children[0];
    r.say(a.job_id, "PROGRESS: 11/5/2026 4:43:20 AM: Starting composition");
    r.setRate(7001, 300);
    r.unkillable.add(7001);
    // A server restart: the new registry reads A as running, without a process handle.
    const again = r.reload();
    r.engines.push(r.engineOf(old, 7001));
    const b = r.launch("B", {}, again);
    await r.advanceAsync(300_000); // far past the 120 s: it is a running job's engine
    expect(again.get(b.job_id)!.state).toBe("running");
    expect(again.get(b.job_id)!.queued_reason).toContain("still running");
    // The owner is cancelled; its engine lingers.
    cancelAerenderJob(again, again.get(a.job_id)!, () => {});
    await r.advanceAsync(10_000);
    expect(again.get(b.job_id)!.state).toBe("running");
    await r.advanceAsync(90_000);
    expect(again.get(b.job_id)!.state).toBe("running"); // ~100 s into its own wait
    await r.advanceAsync(60_000);
    const rec = again.get(b.job_id)!;
    expect(rec.state).toBe("failed");
    // The number in the message is its own wait, not the 300 s the owner was rendering.
    const secs = Number(/(\d+) s after this job began to wait/.exec(rec.error ?? "")?.[1]);
    expect(secs).toBeGreaterThan(118);
    expect(secs).toBeLessThan(140);
  });
});
