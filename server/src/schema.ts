import { z } from "zod";

/**
 * Converts a Zod schema into a JSON Schema object suitable for MCP `ListTools`.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
} {
  let current: z.ZodTypeAny = schema;
  while (
    current instanceof z.ZodEffects ||
    current instanceof z.ZodDefault ||
    current instanceof z.ZodOptional
  ) {
    if (current instanceof z.ZodEffects) {
      current = current._def.schema;
    } else if (current instanceof z.ZodDefault) {
      current = current._def.innerType;
    } else if (current instanceof z.ZodOptional) {
      current = current._def.innerType;
    }
  }

  if (!(current instanceof z.ZodObject)) {
    return { type: "object", properties: {} };
  }

  const shape = current.shape as Record<string, z.ZodTypeAny>;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, fieldSchema] of Object.entries(shape)) {
    const { propSchema, isOptional } = convertFieldSchema(fieldSchema);
    properties[key] = propSchema;
    if (!isOptional) {
      required.push(key);
    }
  }

  const out: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  } = {
    type: "object",
    properties,
  };
  if (required.length > 0) {
    out.required = required;
  }
  return out;
}

export function convertFieldSchema(schema: z.ZodTypeAny): {
  propSchema: Record<string, unknown>;
  isOptional: boolean;
} {
  let isOptional = false;
  let current: z.ZodTypeAny = schema;
  let description: string | undefined = current.description;

  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodDefault ||
    current instanceof z.ZodEffects
  ) {
    if (!description && current.description) {
      description = current.description;
    }
    if (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
      isOptional = true;
      current = current._def.innerType;
    } else if (current instanceof z.ZodEffects) {
      current = current._def.schema;
    }
  }

  if (!description && current.description) {
    description = current.description;
  }

  let propSchema: Record<string, unknown> = {};

  if (current instanceof z.ZodString) {
    propSchema = { type: "string" };
  } else if (current instanceof z.ZodNumber) {
    propSchema = { type: "number" };
  } else if (current instanceof z.ZodBoolean) {
    propSchema = { type: "boolean" };
  } else if (current instanceof z.ZodEnum) {
    propSchema = { type: "string", enum: current._def.values };
  } else if (current instanceof z.ZodArray) {
    const elem = convertFieldSchema(current._def.type);
    propSchema = { type: "array", items: elem.propSchema };
  } else if (current instanceof z.ZodObject) {
    propSchema = zodToJsonSchema(current);
  } else {
    propSchema = {};
  }

  if (description) {
    propSchema.description = description;
  }

  return { propSchema, isOptional };
}
