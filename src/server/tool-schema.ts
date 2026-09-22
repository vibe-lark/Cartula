import { z } from 'zod';

const cache = new WeakMap<z.ZodType, Map<string, z.ZodType>>();

/**
 * Keywords some model tool converters reject outright, dropping the whole tool
 * instead of the field. Observed 2026-09-17: a Doubao client dropped create_map /
 * patch_map / submit_changes. Among the model-visible tools those three were
 * the only ones whose wire schema carried `pattern` — submit_changes had no
 * union at all, so oneOf / anyOf / const cannot be the common factor — and the
 * id pattern writes its control-character range with JavaScript unicode
 * escapes, which RE2 (a Go-side converter) does not compile. The host never
 * said which keyword it tripped on, so everything a strict converter is known
 * to refuse goes in one pass rather than betting on that guess. The wire
 * schema is a model-facing contract, not the validation boundary (the core
 * schemas still enforce every constraint when the call lands), so it is
 * flattened to the lowest common denominator here.
 */
const DROP_KEYS = new Set([
  '$schema', '$id', '$ref', '$defs', 'definitions',
  'pattern', 'propertyNames', 'exclusiveMinimum', 'exclusiveMaximum', 'format',
]);

function isObjectSchema(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (!isObjectSchema(a) || !isObjectSchema(b)) return false;
  const ka = Object.keys(a); const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(key => deepEqual(a[key], b[key]));
}

/**
 * Merge N schemas for one field into a single portable schema.
 *
 * Object branches merge into one object — union of properties, `required`
 * reduced to what every branch required. A `null` branch (nullable field) is
 * dropped: the field is already optional, and a type array round-trips through
 * some converters back into an anyOf. const/enum branches of one type merge
 * into one enum. Same-typed non-object branches keep their shared bounds and
 * merge their `items`. Anything else goes fully loose.
 */
function mergeBranches(raw: unknown[]): Record<string, unknown> {
  const branches = raw
    .filter(isObjectSchema)
    .map(branch => {
      if ('const' in branch) {
        const { const: value, ...rest } = branch;
        return { ...rest, enum: [value] };
      }
      return branch;
    })
    .filter(branch => branch.type !== 'null');
  if (branches.length === 0) return {};
  if (branches.length === 1) return branches[0];
  if (branches.every(branch => deepEqual(branch, branches[0]))) return branches[0];
  if (branches.every(branch => Array.isArray(branch.enum))) {
    const values = [...new Set(branches.flatMap(branch => branch.enum as unknown[]))];
    const types = new Set(branches.map(branch => branch.type).filter(Boolean));
    return types.size === 1 ? { type: [...types][0], enum: values } : { enum: values };
  }
  if (branches.every(branch => branch.type === 'object' || branch.properties)) {
    const props = new Map<string, unknown[]>();
    for (const branch of branches) {
      for (const [key, value] of Object.entries((branch.properties as Record<string, unknown>) ?? {})) {
        const list = props.get(key) ?? [];
        list.push(value);
        props.set(key, list);
      }
    }
    const requiredSets = branches.map(branch => new Set(Array.isArray(branch.required) ? branch.required as string[] : []));
    const properties = Object.fromEntries([...props].map(([key, schemas]) => [key, schemas.length === 1 ? schemas[0] : mergeBranches(schemas)]));
    const required = [...props.keys()].filter(key => requiredSets.every(set => set.has(key)));
    const merged: Record<string, unknown> = { type: 'object', properties };
    if (required.length) merged.required = required;
    return merged;
  }
  const types = new Set(branches.map(branch => branch.type).filter(Boolean));
  if (types.size === 1) {
    const merged: Record<string, unknown> = { type: [...types][0] };
    const items = branches.map(branch => branch.items).filter(item => item !== undefined);
    if (items.length === branches.length) merged.items = mergeBranches(items);
    const enums = branches.filter(branch => Array.isArray(branch.enum));
    if (enums.length === branches.length) merged.enum = [...new Set(enums.flatMap(branch => branch.enum as unknown[]))];
    for (const key of ['minimum', 'minLength', 'minItems'] as const) {
      const vals = branches.map(branch => branch[key]).filter((v): v is number => typeof v === 'number');
      if (vals.length) merged[key] = Math.min(...vals);
    }
    for (const key of ['maximum', 'maxLength', 'maxItems'] as const) {
      const vals = branches.map(branch => branch[key]).filter((v): v is number => typeof v === 'number');
      if (vals.length) merged[key] = Math.max(...vals);
    }
    const description = branches.map(branch => branch.description).find((v): v is string => typeof v === 'string');
    if (description) merged.description = description;
    return merged;
  }
  return {};
}

/** Recursively rewrite a JSON Schema into one every known host converter accepts. */
function portable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(portable);
  if (!isObjectSchema(value)) return value;
  let object: Record<string, unknown> = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !DROP_KEYS.has(key))
      .map(([key, child]) => [key, portable(child)]),
  );
  // A union on the wire is a tool some hosts refuse. Merge it away.
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (!Array.isArray(object[key])) continue;
    const merged = mergeBranches(object[key] as unknown[]);
    delete object[key];
    object = { ...object, ...merged };
  }
  if ('const' in object) {
    const v = object.const;
    delete object.const;
    object.enum = [v];
  }
  // An empty schema means "anything"; saying so explicitly is what strict
  // converters reject.
  if (object.additionalProperties === true) delete object.additionalProperties;
  if (isObjectSchema(object.additionalProperties) && Object.keys(object.additionalProperties).length === 0) delete object.additionalProperties;
  if (isObjectSchema(object.items) && Object.keys(object.items).length === 0) delete object.items;
  // Some model tool converters reject JSON Schema tuples (items: [...] or
  // prefixItems). Advertise homogeneous number arrays and keep exact coordinate
  // and domain validation at the core boundary. Derived from the core schema so
  // additions cannot silently disappear from the tool contract.
  if (object.prefixItems) { delete object.prefixItems; object.items = { type: 'number' }; }
  if (Array.isArray(object.items)) object.items = { type: 'number' };
  // Objects on the wire carry `additionalProperties: {}` (the JSON Schema
  // default) once they have been through a round trip, and at least one host
  // converter drops tools carrying it. Say `false` — the OpenAI-strict-compatible
  // form — for every object that names its properties. The core schemas remain
  // the validation boundary, so this only changes what the wire advertises.
  if (isObjectSchema(object.properties) && object.additionalProperties === undefined) object.additionalProperties = false;
  return object;
}

/**
 * A single-value enum round-trips through `z.fromJSONSchema` back into a
 * `ZodLiteral`, which the SDK serialises as `const` — the keyword we just
 * scrubbed. Replace those literal nodes with real `z.enum` schemas (identical
 * parsing behaviour, portable wire form), mutating the container's child
 * references so the container's own semantics are untouched.
 */
function literalToEnum(schema: z.ZodType): z.ZodType | undefined {
  const def = (schema as { def?: unknown }).def;
  if (!isObjectSchema(def) || def.type !== 'literal' || !Array.isArray(def.values)) return undefined;
  if (def.values.length !== 1 || typeof def.values[0] !== 'string') return undefined;
  return z.enum([def.values[0]]);
}

function deConst(schema: z.ZodType): void {
  const def = (schema as { def?: unknown }).def;
  if (!isObjectSchema(def)) return;
  if (isObjectSchema(def.shape)) {
    for (const [key, child] of Object.entries(def.shape)) {
      const replacement = literalToEnum(child as z.ZodType);
      if (replacement) def.shape[key] = replacement;
      else deConst(child as z.ZodType);
    }
  }
  for (const key of ['element', 'innerType'] as const) {
    const child = def[key] as z.ZodType | undefined;
    if (!child) continue;
    const replacement = literalToEnum(child);
    if (replacement) def[key] = replacement;
    else deConst(child);
  }
  if (Array.isArray(def.options)) for (const child of def.options) deConst(child as z.ZodType);
}

/**
 * Replace named fields with a loose `{}` schema, wherever they appear.
 *
 * Some fields are polymorphic nested objects (a patch's shape depends on the
 * op, a layer's on its kind) that a host converter may refuse even after the
 * union is merged. Their structure already lives in the tool description and
 * the server instructions, and the core validates every call strictly, so the
 * wire schema can stay silent about them.
 */
function loosen(schema: z.ZodType, fields: Set<string>): void {
  const def = (schema as { def?: unknown }).def;
  if (!isObjectSchema(def)) return;
  if (isObjectSchema(def.shape)) {
    for (const [key, child] of Object.entries(def.shape)) {
      if (fields.has(key)) {
        // Keep the field's optionality: a required field stays required, an
        // optional one stays optional.
        const optional = (child as { def?: { type?: string } }).def?.type === 'optional';
        def.shape[key] = optional ? z.unknown().optional() : z.unknown();
      } else {
        loosen(child as z.ZodType, fields);
      }
    }
  }
  if (def.element) loosen(def.element as z.ZodType, fields);
  if (def.innerType) loosen(def.innerType as z.ZodType, fields);
  if (Array.isArray(def.options)) for (const child of def.options) loosen(child as z.ZodType, fields);
}

export function toolSchema<T extends z.ZodType>(schema: T, opts: { looseFields?: string[] } = {}): T {
  // The cache key must include looseFields: the same core schema is shared by
  // several tools, and a caller that loosens a different set of fields must
  // not silently receive another caller's cached conversion.
  const cacheKey = [...(opts.looseFields ?? [])].sort().join(',');
  let byKey = cache.get(schema);
  if (!byKey) { byKey = new Map(); cache.set(schema, byKey); }
  const cached = byKey.get(cacheKey); if (cached) return cached as T;
  const converted = z.fromJSONSchema(portable(z.toJSONSchema(schema, { io: 'input' })) as Parameters<typeof z.fromJSONSchema>[0]);
  deConst(converted);
  if (opts.looseFields?.length) loosen(converted, new Set(opts.looseFields));
  byKey.set(cacheKey, converted);
  return converted as T;
}
