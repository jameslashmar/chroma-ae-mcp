// qa/assert.js — Assertion helpers for AE QA scenarios (markers, layers, items, pixels, timing).
// Plain Node 20 ESM, zero external dependencies.

import { isDeepStrictEqual } from "node:util";

export class QaAssertionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "QaAssertionError";
    this.actual = details.actual;
    this.expected = details.expected;
  }
}

function formatVal(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Creates a per-scenario assertion context `t` that tracks executed checks
 * and throws QaAssertionError on failure.
 */
export function createAssertContext(options = {}) {
  const defaultFps = Number(options.fps) > 0 ? Number(options.fps) : 25;
  const checks = [];

  function record(passed, message, actual, expected) {
    checks.push({ passed, message, actual, expected });
    if (!passed) {
      throw new QaAssertionError(message, { actual, expected });
    }
  }

  function ok(value, msg = "Expected value to be truthy") {
    record(Boolean(value), `${msg} (got ${formatVal(value)})`, value, true);
  }

  function equal(actual, expected, msg = "Expected values to be equal") {
    const passed = Object.is(actual, expected) || actual === expected;
    record(
      passed,
      `${msg}: expected ${formatVal(expected)}, got ${formatVal(actual)}`,
      actual,
      expected
    );
  }

  function notEqual(actual, unexpected, msg = "Expected values to differ") {
    const passed = !Object.is(actual, unexpected) && actual !== unexpected;
    record(
      passed,
      `${msg}: did not expect ${formatVal(unexpected)}`,
      actual,
      unexpected
    );
  }

  function deepEqual(
    actual,
    expected,
    msg = "Expected values to be deeply equal"
  ) {
    const passed = isDeepStrictEqual(actual, expected);
    record(
      passed,
      `${msg}: expected ${formatVal(expected)}, got ${formatVal(actual)}`,
      actual,
      expected
    );
  }

  function match(actual, pattern, msg = "Expected string to match pattern") {
    const str = String(actual ?? "");
    const passed =
      pattern instanceof RegExp
        ? pattern.test(str)
        : str.includes(String(pattern));
    record(
      passed,
      `${msg}: expected ${formatVal(str)} to match ${String(pattern)}`,
      str,
      String(pattern)
    );
  }

  function approx(
    actual,
    expected,
    tolerance = 0.002,
    msg = "Expected number within tolerance"
  ) {
    const diff = Math.abs(Number(actual) - Number(expected));
    const passed = Number.isFinite(diff) && diff <= tolerance;
    record(
      passed,
      `${msg}: expected ${expected} ± ${tolerance}, got ${actual} (diff=${diff})`,
      actual,
      expected
    );
  }

  /**
   * Timing assertion with frame or second tolerance.
   * `tolOrOpts` may be a number (seconds) or `{ frames, fps }`.
   * Defaults to half a frame at the scenario's comp frame rate.
   */
  function timeClose(
    actualSec,
    expectedSec,
    tolOrOpts,
    msg = "Expected timestamp within tolerance"
  ) {
    let toleranceSec;
    if (typeof tolOrOpts === "number") {
      toleranceSec = tolOrOpts;
    } else if (tolOrOpts && typeof tolOrOpts === "object") {
      const fps = Number(tolOrOpts.fps) > 0 ? Number(tolOrOpts.fps) : defaultFps;
      const frames =
        typeof tolOrOpts.frames === "number" ? tolOrOpts.frames : 0.5;
      toleranceSec = frames / fps;
    } else {
      toleranceSec = 0.5 / defaultFps;
    }
    approx(actualSec, expectedSec, toleranceSec, msg);
  }

  /**
   * Asserts marker count and optionally checks individual markers.
   */
  function markerCount(markers, expectedCount, msg = "Marker count mismatch") {
    if (!Array.isArray(markers)) {
      record(false, `${msg}: markers is not an array`, markers, expectedCount);
      return;
    }
    equal(markers.length, expectedCount, msg);
  }

  /**
   * Asserts properties on a marker object (`comment`, `label`, `time`, `duration`,
   * `voxmarkVoice`, `voxmarkText`).
   */
  function markerMatches(marker, expected, opts = {}) {
    ok(marker && typeof marker === "object", "Expected marker object");
    if (expected.comment !== undefined) {
      equal(marker.comment, expected.comment, "marker.comment");
    }
    if (expected.label !== undefined) {
      equal(marker.label, expected.label, "marker.label");
    }
    if (expected.time !== undefined) {
      timeClose(
        marker.time,
        expected.time,
        opts.timeTolerance ?? 0.002,
        "marker.time"
      );
    }
    if (expected.duration !== undefined) {
      timeClose(
        marker.duration,
        expected.duration,
        opts.durationTolerance ?? 0.002,
        "marker.duration"
      );
    }
    if (expected.voxmarkVoice !== undefined) {
      const actualVoice =
        marker.voxmarkVoice ?? marker.params?.voxmarkVoice ?? marker.voice ?? "";
      equal(actualVoice, expected.voxmarkVoice, "marker.voxmarkVoice");
    }
    if (expected.voxmarkText !== undefined) {
      const actualText =
        marker.voxmarkText ??
        marker.params?.voxmarkText ??
        marker.fullText ??
        "";
      equal(actualText, expected.voxmarkText, "marker.voxmarkText");
    }
  }

  function layerOrder(
    layers,
    expectedNames,
    msg = "Expected layer order to match"
  ) {
    const actualNames = Array.isArray(layers)
      ? layers.map((l) => (typeof l === "string" ? l : l.name))
      : [];
    deepEqual(actualNames, expectedNames, msg);
  }

  function itemsContain(
    items,
    expectedNames,
    msg = "Expected project items to contain names"
  ) {
    const actualNames = new Set(
      Array.isArray(items)
        ? items.map((it) => (typeof it === "string" ? it : it.name))
        : []
    );
    for (const name of expectedNames) {
      ok(actualNames.has(name), `${msg}: missing "${name}"`);
    }
  }

  function pixelClose(
    actualRgb,
    expectedRgb,
    tolerance = 4,
    msg = "Expected pixel colour within tolerance"
  ) {
    ok(
      Array.isArray(actualRgb) && actualRgb.length >= 3,
      `${msg}: actual pixel must be [r,g,b]`
    );
    for (let i = 0; i < 3; i++) {
      approx(
        actualRgb[i],
        expectedRgb[i],
        tolerance,
        `${msg} (channel ${i})`
      );
    }
  }

  return {
    checks,
    ok,
    truthy: ok,
    equal,
    notEqual,
    deepEqual,
    match,
    approx,
    timeClose,
    markerCount,
    markerMatches,
    layerOrder,
    itemsContain,
    pixelClose,
  };
}
