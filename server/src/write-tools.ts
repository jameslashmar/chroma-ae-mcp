/**
 * server/src/write-tools.ts
 *
 * Which tools write to the project (or start a render, or answer for the user), for the
 * idempotency key and ae_recent_ops: a tool whose arguments take the `expect` target guard, or
 * one that takes an automatic checkpoint. Worked out from the registry once, so a new write tool
 * is included without a list to keep up to date.
 */

import { zodToJsonSchema } from "./schema.js";
import { AUTO_CHECKPOINT_TOOLS } from "./tools/ext/receipts.js";
import { ALL_TOOLS } from "./tools/registry.js";

let writeSet: Set<string> | null = null;
let mappedCount = -1;

export function writeToolNames(): Set<string> {
  // Rebuilt when the registry changes length (tests add a fake tool to ALL_TOOLS).
  if (writeSet && mappedCount === ALL_TOOLS.length) return writeSet;
  const auto = new Set<string>(AUTO_CHECKPOINT_TOOLS);
  const out = new Set<string>();
  for (const t of ALL_TOOLS) {
    const props = (zodToJsonSchema(t.schema) as { properties?: Record<string, unknown> }).properties ?? {};
    if (auto.has(t.name) || Object.prototype.hasOwnProperty.call(props, "expect")) out.add(t.name);
  }
  writeSet = out;
  mappedCount = ALL_TOOLS.length;
  return out;
}

export function isWriteTool(name: string): boolean {
  return writeToolNames().has(name);
}

export const IDEMPOTENCY_KEY_PROPERTY = {
  type: "string",
  maxLength: 128,
  description: "Optional: a new unique key per write. A resend with the same key and arguments returns the first answer instead of running again.",
};

/** A write tool's JSON schema with `idempotency_key` added (other tools' schemas unchanged). */
export function withIdempotencyKey(name: string, schema: unknown): Record<string, unknown> {
  const obj = schema as Record<string, unknown>;
  if (!isWriteTool(name) || !obj || typeof obj !== "object") return obj;
  const props = (obj.properties as Record<string, unknown> | undefined) ?? {};
  if (Object.prototype.hasOwnProperty.call(props, "idempotency_key")) return obj;
  return { ...obj, properties: { ...props, idempotency_key: IDEMPOTENCY_KEY_PROPERTY } };
}
