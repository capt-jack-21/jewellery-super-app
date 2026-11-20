import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Contract validator for integration responses (0.8.8).
 *
 * contracts/openapi.yaml → JSON via the repo's own Redocly CLI (`redocly bundle --ext json`, the tool `pnpm lint:openapi` already uses;
 * internal $refs are kept) → Ajv 2020-12 (OpenAPI 3.1 = JSON Schema 2020-12) + ajv-formats.
 *
 * No new dependency: Ajv is not a direct devDependency of this repo, so it is loaded from the copy the API already ships with, resolved
 * hop by hop through declared dependencies: apps/api → @nestjs/platform-fastify → fastify → @fastify/ajv-compiler → ajv / ajv-formats
 * (locked in pnpm-lock.yaml: ajv 8.20.0, ajv-formats 2.1.1). If ajv ever becomes a root devDependency, replace `fromApi` with a plain import.
 */
const ROOT = resolve(__dirname, '../..');
function fromApi(): NodeRequire {
  let r = createRequire(join(ROOT, 'apps/api/package.json'));
  for (const hop of ['@nestjs/platform-fastify', 'fastify', '@fastify/ajv-compiler']) r = createRequire(r.resolve(`${hop}/package.json`));
  return r;
}
const req = fromApi();
const Ajv2020 = (req('ajv/dist/2020') as { default: new (o: object) => AjvLike }).default;
const addFormats = (req('ajv-formats') as { default: (a: AjvLike) => void }).default;
export const AJV_VERSION = (req('ajv/package.json') as { version: string }).version;
export const AJV_FORMATS_VERSION = (req('ajv-formats/package.json') as { version: string }).version;

interface AjvErr { instancePath: string; schemaPath: string; keyword: string; params: Record<string, unknown>; message?: string }
interface Validate { (d: unknown): boolean; errors?: AjvErr[] | null }
interface AjvLike { addSchema(s: object, key?: string): AjvLike; getSchema(ref: string): Validate | undefined; addFormat(name: string, f: object): AjvLike; compile(s: object): Validate }
type Json = Record<string, any>;

function loadContract(): Json {
  const dir = mkdtempSync(join(tmpdir(), 'jw-oas-'));
  try {
    const out = join(dir, 'openapi.json');
    execFileSync(join(ROOT, 'node_modules/.bin/redocly'), ['bundle', join(ROOT, 'contracts/openapi.yaml'), '--ext', 'json', '-o', out],
      { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, REDOCLY_TELEMETRY: 'off', REDOCLY_SUPPRESS_UPDATE_NOTICE: 'true' } });
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export const oas = loadContract();
const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false, logger: false });
addFormats(ajv);
/**
 * 0.9.0: strict RFC 3339 `date-time`. ajv-formats 2.1.1 also accepts a space instead of "T" and a bare "+00" offset, so Postgres
 * timestamptz::text ("2026-11-09 18:46:01.792494+05:30") passed the contract; RFC 3339 §5.6 / OpenAPI `format: date-time` needs
 * "YYYY-MM-DDThh:mm:ss[.frac](Z|±hh:mm)". Overrides the ajv-formats check for every response validated here.
 */
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;
export function isRfc3339DateTime(s: unknown): boolean {
  if (typeof s !== 'string') return false;
  const m = RFC3339.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number);
  const dim = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (!dim || d < 1 || d > dim || h > 23 || mi > 59 || se > 60) return false;
  if (m[9] !== undefined && (Number(m[9]) > 23 || Number(m[10]) > 59)) return false;
  return !Number.isNaN(Date.parse(s));
}
ajv.addFormat('date-time', { type: 'string', validate: isRfc3339DateTime });
/** Compiles the contract schema at a JSON pointer ("#/components/schemas/Invoice") and validates `data` against it (0.9.0). */
export function validateAt(ptr: string, data: unknown): { ok: boolean; errors: string[] } {
  const v = ajv.getSchema(`oas${ptr}`);
  if (!v) return { ok: false, errors: [`schema ${ptr} did not compile`] };
  const ok = v(data);
  return { ok, errors: (v.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message} ${JSON.stringify(e.params)}`) };
}
/** Resolves a JSON pointer in the bundled contract (follows nothing). */
export const pointer = (ptr: string): any => at(ptr);
export { deref };
/** True when `value` passes the contract validator's `format` check (used to prove the strict date-time is in force). */
export function formatOk(format: string, value: unknown): boolean { return ajv.compile({ type: 'string', format })(value); }
ajv.addSchema({ ...oas, $id: 'oas' });

const esc = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');
const at = (ptr: string): any => ptr.replace(/^#\//, '').split('/').reduce((o: any, k) => o?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], oas);
const deref = (o: any): any => (o && typeof o.$ref === 'string' ? deref(at(o.$ref)) : o);

export interface Res { statusCode: number; headers: Record<string, unknown>; body: string; json(): any }
export interface Violation { op: string; status: number; errors: string[] }
export interface Extra { op: string; status: number; path: string }

/** Every operation under a path prefix: "METHOD /path". */
export function operations(prefix: string): string[] {
  const out: string[] = [];
  for (const [p, item] of Object.entries<Json>(oas.paths)) if (p.startsWith(prefix))
    for (const m of ['get', 'post', 'put', 'patch', 'delete']) if (item[m]) out.push(`${m.toUpperCase()} ${p}`);
  return out.sort();
}

/** Undocumented properties: walks data against the schema (through $ref / allOf / oneOf / anyOf / items / properties). */
function extras(schema: any, data: unknown, path: string, out: string[], depth = 0): void {
  schema = deref(schema);
  if (!schema || typeof schema !== 'object' || depth > 40 || data === null || typeof data !== 'object') return;
  if (Array.isArray(data)) {
    const it = deref(schema.items) ?? [...(schema.oneOf ?? []), ...(schema.anyOf ?? []), ...(schema.allOf ?? [])].map(deref).find((s: any) => s?.items)?.items;
    if (it) data.forEach((d, k) => extras(it, d, `${path}[${k}]`, out, depth + 1));
    return;
  }
  const parts = [schema, ...(schema.allOf ?? []).map(deref)];
  const alts0 = [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])].map(deref).filter((s: any) => s && (s.properties || s.allOf || s.additionalProperties || s.$ref));
  // oneOf of object shapes (e.g. SalesPrintDocument.document = Invoice | CreditNote | Estimate): walk only the alternatives whose required keys
  // are all present, so one shape's properties are not judged against another's
  const reqOf = (s: any): string[] => [...(s.required ?? []), ...(s.allOf ?? []).map(deref).flatMap((a: any) => a?.required ?? [])];
  const fit = alts0.filter((s: any) => reqOf(s).every((k) => k in (data as Json)));
  const alts = fit.length ? fit : alts0;
  const props: Record<string, any> = {};
  let open = false; let addl: any;
  const collect = (s: any) => {
    s = deref(s); if (!s) return;
    for (const a of (s.allOf ?? []).map(deref)) if (a !== s) collect(a);
    Object.assign(props, s.properties ?? {});
    if (s.additionalProperties && typeof s.additionalProperties === 'object') addl = s.additionalProperties;
    if (s.additionalProperties === true || s.patternProperties) open = true;
  };
  parts.forEach(collect);
  alts.forEach(collect);
  const hasShape = Object.keys(props).length > 0;
  for (const [k, v] of Object.entries(data as Json)) {
    if (k in props) extras(props[k], v, `${path}.${k}`, out, depth + 1);
    else if (addl) extras(addl, v, `${path}.${k}`, out, depth + 1);
    else if (hasShape && !open) out.push(`${path}.${k}`);
  }
}

/** Every string under a key named `at` or ending in `_at` (timestamps by naming convention) that is not RFC 3339 → its path (0.9.0). */
function badTimestamps(data: unknown, path: string, out: string[], depth = 0): void {
  if (depth > 40 || data === null || typeof data !== 'object') return;
  if (Array.isArray(data)) { data.forEach((d, k) => badTimestamps(d, `${path}[${k}]`, out, depth + 1)); return; }
  for (const [k, v] of Object.entries(data as Json)) {
    if ((k === 'at' || k.endsWith('_at')) && typeof v === 'string' && !isRfc3339DateTime(v)) out.push(`${path}.${k}=${v}`);
    else badTimestamps(v, `${path}.${k}`, out, depth + 1);
  }
}

export class ContractRecorder {
  /** 0.9.0: "<op> <status> <path>=<value>" for timestamp-named fields that are not RFC 3339, whatever the schema documents. */
  readonly timestamps: string[] = [];
  readonly hit = new Map<string, Set<number>>();
  readonly violations: Violation[] = [];
  readonly extras: Extra[] = [];
  /**
   * Validates one response against the contract operation (method + templated path). A status code the operation does not document is a
   * violation; a body is validated against the documented media type (application/json or application/problem+json).
   */
  check(method: string, template: string, r: Res): Res {
    const op = `${method.toUpperCase()} ${template}`;
    const o = oas.paths?.[template]?.[method.toLowerCase()];
    const fail = (errors: string[]) => { this.violations.push({ op, status: r.statusCode, errors }); };
    if (!o) { fail(['operation not in the contract']); return r; }
    (this.hit.get(op) ?? this.hit.set(op, new Set()).get(op)!).add(r.statusCode);
    const resp = deref(o.responses?.[String(r.statusCode)] ?? o.responses?.[`${String(r.statusCode)[0]}XX`] ?? o.responses?.default);
    if (!resp) { fail([`status ${r.statusCode} not documented (body: ${r.body.slice(0, 200)})`]); return r; }
    const content = resp.content as Json | undefined;
    if (!content) { if (r.body.length) fail([`documented without a body, got: ${r.body.slice(0, 120)}`]); return r; }
    const ct = String(r.headers['content-type'] ?? '').split(';')[0].trim();
    const media = content[ct] ? ct : Object.keys(content).find((k) => k.endsWith('json'));
    if (!media || !content[media]?.schema) return r;
    if (media !== ct) fail([`content-type ${ct || '(none)'}; contract says ${Object.keys(content).join(', ')}`]);
    const code = Object.keys(o.responses).includes(String(r.statusCode)) ? String(r.statusCode) : (o.responses[`${String(r.statusCode)[0]}XX`] ? `${String(r.statusCode)[0]}XX` : 'default');
    const respRef = o.responses[code].$ref as string | undefined;
    const ptr = respRef ? `${respRef}/content/${esc(media)}/schema` : `#/paths/${esc(template)}/${method.toLowerCase()}/responses/${code}/content/${esc(media)}/schema`;
    const v = ajv.getSchema(`oas${ptr}`);
    if (!v) { fail([`schema ${ptr} did not compile`]); return r; }
    let body: unknown;
    try { body = r.json(); } catch { fail(['body is not JSON']); return r; }
    if (!v(body)) {
      const errs = (v.errors ?? []).filter((e) => !['oneOf', 'anyOf', 'if'].includes(e.keyword) || (v.errors ?? []).length === 1)
        .map((e) => `${e.instancePath || '(root)'} ${e.message}${e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : ''} [${e.schemaPath}]`);
      fail([...new Set(errs)].slice(0, 25));
    }
    const ts: string[] = [];
    badTimestamps(body, '$', ts);
    for (const p of ts) this.timestamps.push(`${op} ${r.statusCode} ${p}`);
    const ex: string[] = [];
    extras(at(ptr), body, '$', ex);
    for (const p of new Set(ex.map((x) => x.replace(/\[\d+\]/g, '[]')))) this.extras.push({ op, status: r.statusCode, path: p });
    return r;
  }
  /** "METHOD /path" for contract operations with no 2xx response seen. */
  uncovered(prefix: string): string[] {
    return operations(prefix).filter((op) => ![...(this.hit.get(op) ?? [])].some((s) => s >= 200 && s < 300));
  }
  report(): string {
    const ex = [...new Map(this.extras.map((e) => [`${e.op} ${e.path}`, e])).values()];
    return JSON.stringify({ violations: this.violations, undocumented: ex.map((e) => `${e.op} ${e.status} ${e.path}`), timestamps: this.timestamps }, null, 1);
  }
}
