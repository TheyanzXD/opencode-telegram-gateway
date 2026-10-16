// Convert a zod schema to the JSON Schema subset used by OpenAI's
// `tools[].function.parameters`. Only the types we actually need:
// string, number, boolean, enum, array, object (with the above leaves).
// ponytail: when richer shapes (refs, unions, transforms) appear, swap for
// `zod-to-json-schema`.

const TN = (s) => s._def?.typeName ?? s._def?.type ?? '';

function unwrap(s) {
  // optional() / nullable() wrappers
  let t = s;
  while (t && /Optional|Nullable/.test(TN(t))) t = t._def.innerType;
  return t;
}

function leaf(s) {
  const t = unwrap(s);
  const tn = TN(t);
  switch (tn) {
    case 'ZodString': return { type: 'string', description: t._def.description };
    case 'ZodNumber': return { type: 'number', description: t._def.description };
    case 'ZodBoolean': return { type: 'boolean', description: t._def.description };
    case 'ZodEnum':    return { type: 'string', enum: [...t._def.values], description: t._def.description };
    case 'ZodArray':   return { type: 'array', items: leaf(t._def.type), description: t._def.description };
    case 'ZodObject':  return schemaToJsonSchema(t);
    default: return { type: 'string', description: 'unsupported' };
  }
}

function schemaToJsonSchema(zodSchema) {
  const t = unwrap(zodSchema);
  const tn = TN(t);
  if (tn !== 'ZodObject') {
    // accept primitives at the top level too
    return leaf(t);
  }
  const shape = t._def.shape();
  const properties = {};
  const required = [];
  for (const [k, v] of Object.entries(shape)) {
    const unwrapped = unwrap(v);
    properties[k] = leaf(unwrapped);
    if (TN(v) === 'ZodOptional') {
      // optional — describe only
    } else {
      required.push(k);
    }
  }
  const out = { type: 'object', properties };
  if (required.length) out.required = required;
  // attach description if any leaf had one — pick first non-empty
  for (const p of Object.values(properties)) {
    if (p.description) { out.description = p.description; break; }
  }
  return out;
}

export function toolToDef({ name, description, schema }) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: schemaToJsonSchema(schema),
    },
  };
}

export function toolsToDefs(tools) {
  return tools.map(toolToDef);
}