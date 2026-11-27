# Task bench

`qa/bench/` checks whether Claude can finish everyday After Effects work with this MCP. The smoke test (`qa/smoke-mcp.mjs`) checks each tool on its own; the bench gives Claude a task and checks the result.

`tasks.mjs` holds fifteen requests, written the way a user would type them:

- a title card, a fade, a scale pop and a slide-in;
- a staggered fade, a drop shadow and a colour change;
- a precomp, a null controller and a feathered mask;
- a trim, a continuous rotation and captions from an SRT file;
- tracking a moving square, and rendering a PNG sequence.

For each task, `run-bench.mjs` does the following:

1. Opens a fresh project, runs the task's setup and saves it.
2. Starts Claude Code headless (`claude -p`) with only this MCP, plus `Read` so Claude can look at frames.
3. Reads the result back from After Effects to check it.

The checks look at the outcome, not at how Claude got there. A fade done with keys or with an expression passes the same way. A colour is checked on the rendered pixel.

```
node qa/bench/run-bench.mjs [--tasks T01,T05] [--toolset core|full|default] [--model sonnet] [--out <dir>]
```

Needs:

- After Effects with the panel service running;
- the token;
- the `claude` CLI, logged in (`CLAUDE_BIN` if it is not on PATH);
- ffmpeg for T14 (`FFMPEG`).

`--toolset default` sends no header, the way the README's `claude mcp add` command connects.

Each task is a real Claude session and costs real usage, about $0.1-0.5 each with the core toolset. A run writes `results.json`, `summary.md` and each task's transcript under `qa/out/bench/<time>/`.

`RESULTS.md` keeps the runs worth comparing.
