export const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: 'string' };
const strings = { type: 'array', items: string };
export const planSchema = object({ goal: string, jobs: strings, questions: strings, approvalActions: strings });
export const buildSchema = object({ summary: string, files: { type: 'array', items: object({ path: string, content: string }) } });
export const reviewSchema = object({ verdict: { type: 'string', enum: ['pass', 'changes_requested', 'blocked'] }, summary: string, issues: strings });

// Check again locally: an AI response or a successful CLI exit is not validation.
export function validate(value, schema, at = 'response') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${at}: expected object`);
    for (const key of schema.required) if (!(key in value)) throw Error(`${at}: missing ${key}`);
    for (const key of Object.keys(value)) {
      if (!(key in schema.properties)) throw Error(`${at}: unexpected ${key}`);
      validate(value[key], schema.properties[key], `${at}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > 40) throw Error(`${at}: invalid array`);
    value.forEach((item, i) => validate(item, schema.items, `${at}[${i}]`));
  } else if (typeof value !== schema.type) throw Error(`${at}: expected ${schema.type}`);
  if (schema.enum && !schema.enum.includes(value)) throw Error(`${at}: invalid value`);
  return value;
}
