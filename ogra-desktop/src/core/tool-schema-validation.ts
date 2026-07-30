import { OgraError, OgraErrorCode } from '../shared/errors';

/** Bounded JSON Schema dialect used by the T1/T2 Tool Broker boundary. */
export function validateToolArgs(schema: unknown, args: unknown): void {
  if (!schema || typeof schema !== 'object') {
    throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
      'validateToolArgs: schema must be an object');
  }
  const typedSchema = schema as Record<string, unknown>;
  if (typedSchema.type !== 'object') {
    throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
      'validateToolArgs: schema.type must be "object"');
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
      'tool arguments must be a JSON object');
  }
  validateToolValue(typedSchema, args, 'tool arguments');
}

export function validateToolOutput(schema: unknown, output: unknown): void {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
      'tool output schema must be an object');
  }
  validateToolValue(schema as Record<string, unknown>, output, 'tool output');
}

function validateToolValue(
  schema: Record<string, unknown>, value: unknown, path: string,
): void {
  const type = schema.type;
  if (typeof type !== 'string') {
    throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
      `${path}: schema type missing`);
  }
  if (schema.const !== undefined && value !== schema.const) {
    throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, `${path}: const mismatch`);
  }
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, `${path}: expected object`);
    }
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!Object.prototype.hasOwnProperty.call(object, key) || object[key] === undefined) {
        throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
          `${path}: missing required field ${key}`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(object)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
            `${path}: unknown field ${key}`);
        }
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        validateToolValue(child as Record<string, unknown>, object[key], `${path}.${key}`);
      }
    }
    return;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, `${path}: expected array`);
    }
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, `${path}: < minItems`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, `${path}: > maxItems`);
    }
    const itemSchema = schema.items as Record<string, unknown> | undefined;
    if (!itemSchema) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, `${path}: schema items missing`);
    }
    value.forEach((item, index) => validateToolValue(itemSchema, item, `${path}[${index}]`));
    return;
  }
  if (type === 'string') {
    if (typeof value !== 'string') {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, `${path}: expected string`);
    }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, `${path}: length < minLength`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, `${path}: length > maxLength`);
    }
    if (typeof schema.maxBytes === 'number'
        && Buffer.byteLength(value, 'utf8') > schema.maxBytes) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, `${path}: byte length > maxBytes`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, `${path}: not in enum`);
    }
    if (typeof schema.pattern === 'string' && !(new RegExp(schema.pattern)).test(value)) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, `${path}: pattern mismatch`);
    }
    return;
  }
  if (type === 'integer' || type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)
        || (type === 'integer' && !Number.isInteger(value))) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, `${path}: expected ${type}`);
    }
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, `${path}: < minimum`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, `${path}: > maximum`);
    }
    return;
  }
  if (type === 'boolean' && typeof value !== 'boolean') {
    throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, `${path}: expected boolean`);
  }
}
