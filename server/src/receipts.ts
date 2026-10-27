export interface ReceiptMismatch {
  path: string;
  expected: unknown;
  actual: unknown;
  message: string;
}

export interface Receipt<TBefore = unknown, TAfter = unknown> {
  before: TBefore;
  after: TAfter;
  matches: boolean;
  mismatches: ReceiptMismatch[];
}

export interface MutateEnvelope<TBefore = unknown, TAfter = unknown> {
  op_id: string;
  applied: true;
  receipt: Receipt<TBefore, TAfter>;
  [key: string]: unknown;
}

const FLOAT_EPSILON = 1e-4;

/**
 * Deeply compares an expected value against an actual value read back from AE
 * (with floating-point tolerance for numbers) and collects any mismatches.
 */
export function compareValues(
  expected: unknown,
  actual: unknown,
  currentPath = "value",
  mismatches: ReceiptMismatch[] = []
): ReceiptMismatch[] {
  if (expected === actual) {
    return mismatches;
  }

  if (typeof expected === "number" && typeof actual === "number") {
    if (Number.isNaN(expected) && Number.isNaN(actual)) {
      return mismatches;
    }
    if (Math.abs(expected - actual) <= FLOAT_EPSILON) {
      return mismatches;
    }
    mismatches.push({
      path: currentPath,
      expected,
      actual,
      message: `Expected ${currentPath} to be ${expected}, got ${actual}`,
    });
    return mismatches;
  }

  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      // Special case in AE: 2D value [x, y] vs 3D value [x, y, 0] when z is 0
      if (
        expected.length === 2 &&
        actual.length === 3 &&
        typeof actual[2] === "number" &&
        Math.abs(actual[2]) <= FLOAT_EPSILON
      ) {
        compareValues(expected[0], actual[0], `${currentPath}[0]`, mismatches);
        compareValues(expected[1], actual[1], `${currentPath}[1]`, mismatches);
        return mismatches;
      }
      mismatches.push({
        path: currentPath,
        expected,
        actual,
        message: `Expected array length ${expected.length} at ${currentPath}, got ${actual.length}`,
      });
      return mismatches;
    }
    for (let i = 0; i < expected.length; i++) {
      compareValues(
        expected[i],
        actual[i],
        `${currentPath}[${i}]`,
        mismatches
      );
    }
    return mismatches;
  }

  if (
    expected !== null &&
    actual !== null &&
    typeof expected === "object" &&
    typeof actual === "object" &&
    !Array.isArray(expected) &&
    !Array.isArray(actual)
  ) {
    const expObj = expected as Record<string, unknown>;
    const actObj = actual as Record<string, unknown>;
    for (const key of Object.keys(expObj)) {
      if (expObj[key] === undefined) continue;
      const subPath = currentPath ? `${currentPath}.${key}` : key;
      if (!(key in actObj)) {
        mismatches.push({
          path: subPath,
          expected: expObj[key],
          actual: undefined,
          message: `Missing field at ${subPath}`,
        });
      } else {
        compareValues(expObj[key], actObj[key], subPath, mismatches);
      }
    }
    return mismatches;
  }

  mismatches.push({
    path: currentPath,
    expected,
    actual,
    message: `Expected ${currentPath} to match ${JSON.stringify(
      expected
    )}, got ${JSON.stringify(actual)}`,
  });
  return mismatches;
}

/**
 * Builds a Receipt object comparing `expected` (when provided) against `after`.
 * When `expected` is omitted (e.g. for arbitrary `ae_run_jsx` mutations where only
 * before/after comp snapshots exist), checks that `after` was cleanly captured.
 */
export function buildReceipt<TBefore = unknown, TAfter = unknown>(params: {
  before: TBefore;
  after: TAfter;
  expected?: unknown;
  actualForExpected?: unknown;
  customMismatches?: ReceiptMismatch[];
}): Receipt<TBefore, TAfter> {
  const mismatches: ReceiptMismatch[] = params.customMismatches
    ? [...params.customMismatches]
    : [];

  if (params.expected !== undefined) {
    const target =
      params.actualForExpected !== undefined
        ? params.actualForExpected
        : params.after;
    compareValues(params.expected, target, "expected", mismatches);
  } else if (params.after === null || params.after === undefined) {
    mismatches.push({
      path: "after",
      expected: "non-null read-back snapshot",
      actual: params.after,
      message: "Read-back snapshot after mutation returned null or undefined",
    });
  }

  return {
    before: params.before,
    after: params.after,
    matches: mismatches.length === 0,
    mismatches,
  };
}

/**
 * Enforces SPEC output bounds:
 * - Lists cap at 500 entries with `truncated: true`.
 * - Strings cap at 20,000 characters.
 */
export const MAX_LIST_ENTRIES = 500;
export const MAX_STRING_CHARS = 20_000;

export function boundOutput<T>(value: T): T {
  return boundRecursive(value) as T;
}

function boundRecursive(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length > MAX_STRING_CHARS) {
      return (
        value.slice(0, MAX_STRING_CHARS) +
        `... [truncated ${value.length - MAX_STRING_CHARS} chars]`
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_LIST_ENTRIES) {
      return value
        .slice(0, MAX_LIST_ENTRIES)
        .map((item) => boundRecursive(item));
    }
    return value.map((item) => boundRecursive(item));
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v) && v.length > MAX_LIST_ENTRIES) {
        out[k] = v
          .slice(0, MAX_LIST_ENTRIES)
          .map((item) => boundRecursive(item));
        out.truncated = true;
        out[`${k}_total`] = v.length;
      } else {
        out[k] = boundRecursive(v);
      }
    }
    return out;
  }
  return value;
}
