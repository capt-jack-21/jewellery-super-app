import { d } from './num';
import { fail, type FieldError } from './errors';

/**
 * Small request validator (Sales has no zod dependency: package deps are @jw/db + @jw/money only). Every rule collects
 * field errors; `done()` throws one 422 validation_failed listing them all. Unknown fields → 422 field_not_supported.
 */
export const RX = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  money: /^[0-9]{1,12}\.[0-9]{2}$/,
  weight: /^[0-9]{1,9}\.[0-9]{3}$/,
  pct: /^[0-9]{1,3}(\.[0-9]{1,3})?$/,
  dec: /^[0-9]{1,10}(\.[0-9]{1,3})?$/,
  rate: /^[0-9]{1,10}\.[0-9]{2}$/,
  taxRate: /^[0-9]{1,3}(\.[0-9]{1,2})?$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  state: /^[0-9]{2}$/,
  gstin: /^[0-9]{2}[A-Z0-9]{13}$/,
  pan: /^[A-Z]{5}[0-9]{4}[A-Z]$/,
  huid: /^[A-Za-z0-9]{6}$/,
  lang: /^[a-z]{2}(-[A-Z]{2})?$/,
};
export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const validDate = (s: string) => RX.date.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

export class V {
  readonly errors: FieldError[] = [];
  constructor(private readonly unsupported: FieldError[] = []) {}
  err(path: string, message: string, code = 'invalid'): void { this.errors.push({ path, code, message }); }
  /** Object at path with only the allowed keys; returns it (or {} when not an object). */
  obj(v: unknown, path: string, allowed: string[], required: string[] = []): Obj {
    if (!isObj(v)) { this.err(path || '$', 'must be an object'); return {}; }
    for (const k of Object.keys(v)) if (!allowed.includes(k)) this.unsupported.push({ path: path ? `${path}.${k}` : k, code: 'field_not_supported', message: 'unknown field' });
    for (const k of required) if (v[k] === undefined) this.err(path ? `${path}.${k}` : k, 'required', 'required');
    return v;
  }
  str(v: unknown, path: string, o: { min?: number; max?: number; rx?: RegExp; trim?: boolean; nullable?: boolean; optional?: boolean } = {}): string | null | undefined {
    if (v === undefined) { if (!o.optional) this.err(path, 'required', 'required'); return undefined; }
    if (v === null) { if (!o.nullable) this.err(path, 'must not be null'); return null; }
    if (typeof v !== 'string') { this.err(path, 'must be a string'); return undefined; }
    const s = o.trim ? v.trim() : v;
    if (o.min !== undefined && s.length < o.min) this.err(path, `at least ${o.min} characters`);
    if (o.max !== undefined && s.length > o.max) this.err(path, `at most ${o.max} characters`);
    if (o.rx && !o.rx.test(s)) this.err(path, 'invalid format');
    return s;
  }
  uuid(v: unknown, path: string, o: { nullable?: boolean; optional?: boolean } = {}) { return this.str(v, path, { ...o, rx: RX.uuid }); }
  /** Decimal string (never a JSON number). */
  dec(v: unknown, path: string, rx: RegExp, o: { nullable?: boolean; optional?: boolean; max?: string; positive?: boolean } = {}): string | null | undefined {
    if (typeof v === 'number') { this.err(path, 'decimal string required (not a JSON number)'); return undefined; }
    const s = this.str(v, path, { nullable: o.nullable, optional: o.optional, rx });
    if (typeof s === 'string' && rx.test(s)) {
      if (o.max !== undefined && d(s).gt(d(o.max))) this.err(path, `at most ${o.max}`);
      if (o.positive && /^[0.]+$/.test(s)) this.err(path, 'must be > 0');
    }
    return s;
  }
  date(v: unknown, path: string, o: { optional?: boolean; nullable?: boolean } = {}) {
    const s = this.str(v, path, o);
    if (typeof s === 'string' && !validDate(s)) this.err(path, 'date YYYY-MM-DD');
    return s;
  }
  int(v: unknown, path: string, o: { min?: number; max?: number; optional?: boolean } = {}): number | undefined {
    if (v === undefined) { if (!o.optional) this.err(path, 'required', 'required'); return undefined; }
    if (typeof v !== 'number' || !Number.isInteger(v)) { this.err(path, 'must be an integer'); return undefined; }
    if (o.min !== undefined && v < o.min) this.err(path, `at least ${o.min}`);
    if (o.max !== undefined && v > o.max) this.err(path, `at most ${o.max}`);
    return v;
  }
  bool(v: unknown, path: string, o: { optional?: boolean } = {}): boolean | undefined {
    if (v === undefined) { if (!o.optional) this.err(path, 'required', 'required'); return undefined; }
    if (typeof v !== 'boolean') { this.err(path, 'must be true or false'); return undefined; }
    return v;
  }
  oneOf<T extends string>(v: unknown, path: string, values: readonly T[], o: { optional?: boolean; nullable?: boolean } = {}): T | null | undefined {
    if (v === undefined) { if (!o.optional) this.err(path, 'required', 'required'); return undefined; }
    if (v === null && o.nullable) return null;
    if (!values.includes(v as T)) { this.err(path, `one of ${values.join(', ')}`); return undefined; }
    return v as T;
  }
  arr(v: unknown, path: string, o: { min?: number; max?: number; optional?: boolean } = {}): unknown[] {
    if (v === undefined) { if (!o.optional) this.err(path, 'required', 'required'); return []; }
    if (!Array.isArray(v)) { this.err(path, 'must be an array'); return []; }
    if (o.min !== undefined && v.length < o.min) this.err(path, `at least ${o.min} item(s)`);
    if (o.max !== undefined && v.length > o.max) this.err(path, `at most ${o.max} items`);
    return v;
  }
  /** Throws: unknown fields first (422 field_not_supported), then 422 validation_failed. */
  done(): void {
    if (this.unsupported.length) fail(422, 'field_not_supported', `unknown field ${this.unsupported[0].path}`, this.unsupported);
    if (this.errors.length) fail(422, 'validation_failed', `${this.errors[0].path}: ${this.errors[0].message}`, this.errors);
  }
}
