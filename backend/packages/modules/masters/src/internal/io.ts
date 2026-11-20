import { Body, Controller, Get, Inject, OnModuleInit, Param, ParseUUIDPipe, Query, Post, Res } from '@nestjs/common';
import { currentTx } from '@jw/db';
import { Ctx, type JwRequest, Problem, type RowErr, STORAGE, type StorageService, objectKey, parse, registerImportKind, sha256, writeTable, fail } from '@jw/mod-platform';
import { z } from 'zod';
import { type Row, type Spec, type WriteCtx, checkRefs, insert, need } from './crud';
import { MetalInput, PurityInput } from './masters.controller';
import * as S from './specs';

/**
 * M17 (981): CSV/XLSX import + export for every master kind. Imports reuse P21's dry-run → commit flow (platform ImportController);
 * masters registers one importer per kind. Columns reference other masters by CODE (export ⇄ import round-trips).
 */
const metalSpec: Spec = { name: 'metals', table: 'masters.metal', area: 'metals', create: MetalInput, patch: MetalInput, search: [], sort: 'code',
  cols: 'id, code, name, default_hsn, version, is_active', fields: { code: 'text', name: 'text', default_hsn: 'text' } };
const puritySpec: Spec = { name: 'purities', table: 'masters.purity', area: 'metals', create: PurityInput, patch: PurityInput, search: [], sort: 'code',
  cols: 'id, metal_id, code, version, is_active', fields: { metal_id: 'uuid', code: 'text', fineness: 'numeric', huid_required: 'bool', header_visible: 'bool' },
  refs: { metal_id: { table: 'masters.metal' } } };

type Lookup = { sql: string };
/** active rows only, keyed by upper(code) (or a composite key) — an inactive master is "not found" for imports */
const LK: Record<string, Lookup> = {
  metal: { sql: `SELECT upper(code) AS k, id FROM masters.metal WHERE is_active` },
  purity: { sql: `SELECT upper(m.code) || ':' || upper(p.code) AS k, p.id FROM masters.purity p JOIN masters.metal m ON m.id = p.metal_id WHERE p.is_active` },
  item: { sql: `SELECT upper(code) AS k, id FROM masters.item WHERE is_active` },
  sub_item: { sql: `SELECT upper(i.code) || ':' || upper(s.code) AS k, s.id FROM masters.sub_item s JOIN masters.item i ON i.id = s.item_id WHERE s.is_active` },
  design: { sql: `SELECT upper(code) AS k, id FROM masters.design WHERE is_active` },
  vendor: { sql: `SELECT upper(code) AS k, id FROM masters.vendor WHERE is_active` },
  branch: { sql: `SELECT upper(code) AS k, id FROM platform.branch WHERE is_active` },
  floor: { sql: `SELECT upper(b.code) || ':' || upper(f.code) AS k, f.id FROM masters.floor f JOIN platform.branch b ON b.id = f.branch_id WHERE f.is_active AND f.code IS NOT NULL` },
  counter: { sql: `SELECT upper(b.code) || ':' || upper(c.code) AS k, c.id FROM masters.counter c JOIN platform.branch b ON b.id = c.branch_id WHERE c.is_active` },
  std: { sql: `SELECT kind || ':' || upper(code) AS k, id FROM masters.stone_standard WHERE is_active` },
};
type Ref = (column: string, lookup: string, key: string | undefined) => string | undefined;
interface IoDef {
  spec: Spec; template: string[]; required: string[];
  toBody(r: Record<string, string>, ref: Ref): Row;
  /** existing natural key, for already_exists at dry run */
  dupSql?: string; dupKey?(b: Row, r: Record<string, string>): string;
  exportSql: string;
  /** export filters jsonb accepted (validated) — only include_inactive for now */
}
const v = (s: string | undefined) => { const t = (s ?? '').trim(); return t === '' ? undefined : t; };
const bool = (s: string | undefined) => (v(s) === undefined ? undefined : /^(1|y|yes|true)$/i.test(v(s)!));
const int = (s: string | undefined) => (v(s) === undefined ? undefined : /^-?\d+$/.test(v(s)!) ? Number(v(s)) : v(s));
const list = (s: string | undefined) => (v(s) === undefined ? undefined : v(s)!.split('|').map((x) => x.trim()).filter(Boolean));
const U = (s: string | undefined) => v(s)?.toUpperCase();
const clean = (o: Row): Row => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined));
const ACT = (alias = '') => `(${alias}is_active OR $1)`;

export const IO: Record<string, IoDef> = {
  metals: { spec: metalSpec, template: ['code', 'name', 'default_hsn'], required: ['code', 'name', 'default_hsn'],
    toBody: (r) => clean({ code: U(r.code), name: v(r.name), default_hsn: v(r.default_hsn) }),
    dupSql: `SELECT upper(code) AS k FROM masters.metal`, dupKey: (b) => String(b.code),
    exportSql: `SELECT code, name, default_hsn FROM masters.metal WHERE ${ACT()} ORDER BY code` },
  purities: { spec: puritySpec, template: ['metal_code', 'code', 'fineness', 'huid_required', 'header_visible'], required: ['metal_code', 'code', 'fineness'],
    toBody: (r, ref) => clean({ metal_id: ref('metal_code', 'metal', U(r.metal_code)), code: U(r.code), fineness: v(r.fineness),
      huid_required: bool(r.huid_required), header_visible: bool(r.header_visible) }),
    dupSql: `SELECT metal_id || ':' || upper(code) AS k FROM masters.purity`, dupKey: (b) => `${String(b.metal_id)}:${String(b.code)}`,
    exportSql: `SELECT m.code AS metal_code, p.code, p.fineness::text, p.huid_required::text, p.header_visible::text FROM masters.purity p
      JOIN masters.metal m ON m.id = p.metal_id WHERE ${ACT('p.')} ORDER BY m.code, p.code` },
  items: { spec: S.items, template: ['code', 'short_code', 'name', 'metal_code', 'purity_code', 'hsn', 'stock_type', 'mc_type', 'mc_value', 'min_mc', 'wastage_type',
      'wastage_value', 'huid_charge', 'allow_zero_weight'], required: ['code', 'name', 'metal_code', 'purity_code', 'hsn', 'stock_type'],
    toBody: (r, ref) => clean({ code: v(r.code), short_code: v(r.short_code), name: v(r.name), metal_id: ref('metal_code', 'metal', U(r.metal_code)),
      purity_id: ref('purity_code', 'purity', `${U(r.metal_code)}:${U(r.purity_code)}`), hsn: v(r.hsn), stock_type: v(r.stock_type), mc_type: v(r.mc_type),
      mc_value: v(r.mc_value), min_mc: v(r.min_mc), wastage_type: v(r.wastage_type), wastage_value: v(r.wastage_value), huid_charge: v(r.huid_charge),
      allow_zero_weight: bool(r.allow_zero_weight) }),
    dupSql: `SELECT upper(code) AS k FROM masters.item`, dupKey: (b) => String(b.code).toUpperCase(),
    exportSql: `SELECT i.code, i.short_code, i.name, m.code AS metal_code, p.code AS purity_code, i.hsn, i.stock_type, i.mc_type, i.mc_value::text, i.min_mc::text,
      i.wastage_type, i.wastage_value::text, i.huid_charge::text, i.allow_zero_weight::text FROM masters.item i JOIN masters.metal m ON m.id = i.metal_id
      JOIN masters.purity p ON p.id = i.purity_id WHERE ${ACT('i.')} ORDER BY i.code` },
  sub_items: { spec: S.subItems, template: ['item_code', 'code', 'name', 'hsn', 'measurement', 'mc_type', 'mc_value', 'wastage_value', 'huid_charge'],
    required: ['item_code', 'code', 'name'],
    toBody: (r, ref) => clean({ item_id: ref('item_code', 'item', U(r.item_code)), code: v(r.code), name: v(r.name), hsn: v(r.hsn), measurement: v(r.measurement),
      mc_type: v(r.mc_type), mc_value: v(r.mc_value), wastage_value: v(r.wastage_value), huid_charge: v(r.huid_charge) }),
    dupSql: `SELECT item_id || ':' || upper(code) AS k FROM masters.sub_item`, dupKey: (b) => `${String(b.item_id)}:${String(b.code).toUpperCase()}`,
    exportSql: `SELECT i.code AS item_code, s.code, s.name, s.hsn, s.measurement, s.mc_type, s.mc_value::text, s.wastage_value::text, s.huid_charge::text
      FROM masters.sub_item s JOIN masters.item i ON i.id = s.item_id WHERE ${ACT('s.')} ORDER BY i.code, s.code` },
  designs: { spec: S.designs, template: ['code', 'name', 'item_code', 'sub_item_code', 'purity_code', 'designer_code', 'description', 'approx_gross_wt', 'approx_net_wt',
      'approx_stone_wt', 'size', 'tags'], required: ['code', 'name', 'item_code'],
    toBody: (r, ref) => clean({ code: v(r.code), name: v(r.name), item_id: ref('item_code', 'item', U(r.item_code)),
      sub_item_id: v(r.sub_item_code) ? ref('sub_item_code', 'sub_item', `${U(r.item_code)}:${U(r.sub_item_code)}`) : undefined,
      purity_id: v(r.purity_code) ? ref('purity_code', 'purity_by_item', `${U(r.item_code)}:${U(r.purity_code)}`) : undefined,
      designer_id: v(r.designer_code) ? ref('designer_code', 'vendor', U(r.designer_code)) : undefined, description: v(r.description),
      approx_gross_wt: v(r.approx_gross_wt), approx_net_wt: v(r.approx_net_wt), approx_stone_wt: v(r.approx_stone_wt), size: v(r.size), tags: list(r.tags) }),
    dupSql: `SELECT upper(code) AS k FROM masters.design`, dupKey: (b) => String(b.code).toUpperCase(),
    exportSql: `SELECT d.code, d.name, i.code AS item_code, s.code AS sub_item_code, p.code AS purity_code, vd.code AS designer_code, d.description,
      d.approx_gross_wt::text, d.approx_net_wt::text, d.approx_stone_wt::text, d.size, array_to_string(d.tags, '|') AS tags FROM masters.design d
      JOIN masters.item i ON i.id = d.item_id LEFT JOIN masters.sub_item s ON s.id = d.sub_item_id LEFT JOIN masters.purity p ON p.id = d.purity_id
      LEFT JOIN masters.vendor vd ON vd.id = d.designer_id WHERE ${ACT('d.')} ORDER BY d.code` },
  stones: { spec: S.stoneStandards, template: ['kind', 'code', 'name', 'cent_from', 'cent_to'], required: ['kind', 'code', 'name'],
    toBody: (r) => clean({ kind: v(r.kind)?.toLowerCase(), code: v(r.code), name: v(r.name), cent_from: v(r.cent_from), cent_to: v(r.cent_to) }),
    dupSql: `SELECT kind || ':' || upper(code) AS k FROM masters.stone_standard`, dupKey: (b) => `${String(b.kind)}:${String(b.code).toUpperCase()}`,
    exportSql: `SELECT kind, code, name, cent_from::text, cent_to::text FROM masters.stone_standard WHERE ${ACT()} ORDER BY kind, code` },
  stone_rates: { spec: S.stoneRates, template: ['stone_code', 'cent_group_code', 'shape_code', 'clarity_code', 'colour_code', 'cut_code', 'vendor_code', 'rate_unit',
      'purchase_rate', 'sale_rate', 'effective_from', 'effective_to'], required: ['sale_rate', 'effective_from'],
    toBody: (r, ref) => {
      const s = (col: string, kind: string) => (v(r[col]) ? ref(col, 'std', `${kind}:${U(r[col])}`) : undefined);
      return clean({ stone_id: s('stone_code', 'stone'), cent_group_id: s('cent_group_code', 'cent_group'), shape_id: s('shape_code', 'shape'),
        clarity_id: s('clarity_code', 'clarity'), colour_id: s('colour_code', 'colour'), cut_id: s('cut_code', 'cut'),
        vendor_id: v(r.vendor_code) ? ref('vendor_code', 'vendor', U(r.vendor_code)) : undefined, rate_unit: v(r.rate_unit), purchase_rate: v(r.purchase_rate),
        sale_rate: v(r.sale_rate), effective_from: v(r.effective_from), effective_to: v(r.effective_to) });
    },
    exportSql: `SELECT (SELECT code FROM masters.stone_standard WHERE id = r.stone_id) AS stone_code, (SELECT code FROM masters.stone_standard WHERE id = r.cent_group_id) AS cent_group_code,
      (SELECT code FROM masters.stone_standard WHERE id = r.shape_id) AS shape_code, (SELECT code FROM masters.stone_standard WHERE id = r.clarity_id) AS clarity_code,
      (SELECT code FROM masters.stone_standard WHERE id = r.colour_id) AS colour_code, (SELECT code FROM masters.stone_standard WHERE id = r.cut_id) AS cut_code,
      (SELECT code FROM masters.vendor WHERE id = r.vendor_id) AS vendor_code, r.rate_unit, r.purchase_rate_per_ct::text, r.sale_rate_per_ct::text,
      r.effective_from::text, r.effective_to::text FROM masters.diamond_rate r WHERE ${ACT('r.')} ORDER BY r.effective_from, r.id` },
  making_wastage_rules: { spec: S.vaRules, template: ['scope', 'tier', 'metal_code', 'purity_code', 'item_code', 'design_code', 'vendor_code', 'weight_from', 'weight_to',
      'touch', 'mc_per_gram', 'mc_percent', 'flat_mc', 'fixed_rate', 'wastage_pct', 'flat_wastage', 'effective_from', 'effective_to', 'priority'], required: ['scope'],
    toBody: (r, ref) => clean({ scope: v(r.scope), tier: v(r.tier), metal_id: v(r.metal_code) ? ref('metal_code', 'metal', U(r.metal_code)) : undefined,
      purity_id: v(r.purity_code) ? ref('purity_code', 'purity', `${U(r.metal_code)}:${U(r.purity_code)}`) : undefined,
      item_id: v(r.item_code) ? ref('item_code', 'item', U(r.item_code)) : undefined, design_id: v(r.design_code) ? ref('design_code', 'design', U(r.design_code)) : undefined,
      vendor_id: v(r.vendor_code) ? ref('vendor_code', 'vendor', U(r.vendor_code)) : undefined, weight_from: v(r.weight_from), weight_to: v(r.weight_to), touch: v(r.touch),
      mc_per_gram: v(r.mc_per_gram), mc_percent: v(r.mc_percent), flat_mc: v(r.flat_mc), fixed_rate: v(r.fixed_rate), wastage_pct: v(r.wastage_pct),
      flat_wastage: v(r.flat_wastage), effective_from: v(r.effective_from), effective_to: v(r.effective_to), priority: int(r.priority) }),
    exportSql: `SELECT x.scope, x.tier, m.code AS metal_code, p.code AS purity_code, i.code AS item_code, d.code AS design_code, vd.code AS vendor_code, x.weight_from::text,
      x.weight_to::text, x.touch::text, x.mc_per_gram::text, x.mc_percent::text, x.flat_mc::text, x.fixed_rate::text, x.wastage_pct::text, x.flat_wastage::text,
      x.effective_from::text, x.effective_to::text, x.priority::text FROM masters.value_addition_rule x LEFT JOIN masters.metal m ON m.id = x.metal_id
      LEFT JOIN masters.purity p ON p.id = x.purity_id LEFT JOIN masters.item i ON i.id = x.item_id LEFT JOIN masters.design d ON d.id = x.design_id
      LEFT JOIN masters.vendor vd ON vd.id = x.vendor_id WHERE ${ACT('x.')} ORDER BY x.priority DESC, x.id` },
  vendors: { spec: S.vendors, template: ['code', 'name', 'kinds', 'gstin', 'state_code', 'pan'], required: ['code', 'name'],
    toBody: (r) => clean({ code: v(r.code), name: v(r.name), kinds: list(r.kinds) ?? [], gstin: U(r.gstin), state_code: v(r.state_code), pan: U(r.pan) }),
    dupSql: `SELECT upper(code) AS k FROM masters.vendor`, dupKey: (b) => String(b.code).toUpperCase(),
    // PAN is never exported (last4 only lives in the API)
    exportSql: `SELECT code, name, array_to_string(kinds, '|') AS kinds, gstin, state_code, NULL AS pan FROM masters.vendor WHERE ${ACT()} ORDER BY code` },
  staff: { spec: S.staff, template: ['code', 'name', 'phone', 'branch_code', 'joined_on', 'left_on', 'is_salesperson'], required: ['code', 'name', 'branch_code'],
    toBody: (r, ref) => clean({ code: v(r.code), name: v(r.name), phone: v(r.phone), branch_id: ref('branch_code', 'branch', U(r.branch_code)), joined_on: v(r.joined_on),
      left_on: v(r.left_on), is_salesperson: bool(r.is_salesperson) }),
    dupSql: `SELECT upper(code) AS k FROM hr.staff`, dupKey: (b) => String(b.code).toUpperCase(),
    exportSql: `SELECT s.code, s.name, s.phone, b.code AS branch_code, s.joined_on::text, s.left_on::text, s.is_salesperson::text FROM hr.staff s
      JOIN platform.branch b ON b.id = s.branch_id WHERE ${ACT('s.')} ORDER BY s.code` },
  floors: { spec: S.floors, template: ['branch_code', 'code', 'name'], required: ['branch_code', 'name'],
    toBody: (r, ref) => clean({ branch_id: ref('branch_code', 'branch', U(r.branch_code)), code: v(r.code), name: v(r.name) }),
    dupSql: `SELECT branch_id || ':' || upper(coalesce(code, name)) AS k FROM masters.floor`,
    dupKey: (b) => `${String(b.branch_id)}:${String(b.code ?? b.name).toUpperCase()}`,
    exportSql: `SELECT b.code AS branch_code, f.code, f.name FROM masters.floor f JOIN platform.branch b ON b.id = f.branch_id
      WHERE ${ACT('f.')} ORDER BY b.code, coalesce(f.code, f.name)` },
  counters: { spec: S.counters, template: ['branch_code', 'floor_code', 'code', 'name'], required: ['branch_code', 'code', 'name'],
    toBody: (r, ref) => clean({ branch_id: ref('branch_code', 'branch', U(r.branch_code)),
      floor_id: v(r.floor_code) ? ref('floor_code', 'floor', `${U(r.branch_code)}:${U(r.floor_code)}`) : undefined, code: v(r.code), name: v(r.name) }),
    dupSql: `SELECT branch_id || ':' || upper(code) AS k FROM masters.counter`, dupKey: (b) => `${String(b.branch_id)}:${String(b.code).toUpperCase()}`,
    exportSql: `SELECT b.code AS branch_code, f.code AS floor_code, c.code, c.name FROM masters.counter c JOIN platform.branch b ON b.id = c.branch_id
      LEFT JOIN masters.floor f ON f.id = c.floor_id WHERE ${ACT('c.')} ORDER BY b.code, c.code` },
  trays: { spec: S.trays, template: ['branch_code', 'counter_code', 'code', 'name', 'item_code', 'sub_item_code', 'tare_weight'], required: ['branch_code', 'counter_code', 'code'],
    toBody: (r, ref) => clean({ counter_id: ref('counter_code', 'counter', `${U(r.branch_code)}:${U(r.counter_code)}`), code: v(r.code), name: v(r.name),
      sub_item_id: v(r.sub_item_code) ? ref('sub_item_code', 'sub_item', `${U(r.item_code)}:${U(r.sub_item_code)}`) : undefined, tare_weight: v(r.tare_weight) }),
    dupSql: `SELECT upper(code) AS k FROM masters.box`, dupKey: (b) => String(b.code).toUpperCase(),
    exportSql: `SELECT b.code AS branch_code, c.code AS counter_code, x.code, x.name, i.code AS item_code, s.code AS sub_item_code, x.tare_weight::text FROM masters.box x
      JOIN masters.counter c ON c.id = x.counter_id JOIN platform.branch b ON b.id = c.branch_id LEFT JOIN masters.sub_item s ON s.id = x.sub_item_id
      LEFT JOIN masters.item i ON i.id = s.item_id WHERE ${ACT('x.')} ORDER BY x.code` },
  hsn_codes: { spec: S.hsnCodes, template: ['code_type', 'code', 'description', 'uqc'], required: ['code_type', 'code', 'description'],
    toBody: (r) => clean({ code_type: U(r.code_type), code: v(r.code), description: v(r.description), uqc: U(r.uqc) }),
    dupSql: `SELECT code_type || ':' || code AS k FROM masters.hsn_code`, dupKey: (b) => `${String(b.code_type)}:${String(b.code)}`,
    exportSql: `SELECT code_type, code, description, uqc FROM masters.hsn_code WHERE ${ACT()} ORDER BY code_type, code` },
  payment_modes: { spec: S.paymentModes, template: ['code', 'name', 'kind', 'requires_reference', 'requires_card_machine', 'sort_order'], required: ['code', 'name', 'kind'],
    toBody: (r) => clean({ code: U(r.code), name: v(r.name), kind: v(r.kind), requires_reference: bool(r.requires_reference),
      requires_card_machine: bool(r.requires_card_machine), sort_order: int(r.sort_order) }),
    dupSql: `SELECT upper(code) AS k FROM masters.payment_mode`, dupKey: (b) => String(b.code),
    exportSql: `SELECT code, name, kind, requires_reference::text, requires_card_machine::text, sort_order::text FROM masters.payment_mode WHERE ${ACT()} ORDER BY sort_order, code` },
  card_machines: { spec: S.cardMachines, template: ['branch_code', 'code', 'provider', 'terminal_id', 'merchant_id', 'supports', 'mdr_pct'],
    required: ['branch_code', 'code', 'provider', 'terminal_id'],
    toBody: (r, ref) => clean({ branch_id: ref('branch_code', 'branch', U(r.branch_code)), code: v(r.code), provider: v(r.provider), terminal_id: v(r.terminal_id),
      merchant_id: v(r.merchant_id), supports: list(r.supports), mdr_pct: v(r.mdr_pct) }),
    dupSql: `SELECT upper(code) AS k FROM masters.card_machine`, dupKey: (b) => String(b.code).toUpperCase(),
    exportSql: `SELECT b.code AS branch_code, m.code, m.provider, m.terminal_id, m.merchant_id, array_to_string(m.supports, '|') AS supports, m.mdr_pct::text
      FROM masters.card_machine m JOIN platform.branch b ON b.id = m.branch_id WHERE ${ACT('m.')} ORDER BY m.code` },
};
// purity scoped by an item's metal (designs.purity_code)
LK.purity_by_item = { sql: `SELECT upper(i.code) || ':' || upper(p.code) AS k, p.id FROM masters.purity p JOIN masters.item i ON i.metal_id = p.metal_id WHERE p.is_active` };

/** customers keep the P21 importer; export only (legacy template columns; PAN never exported). */
const CUSTOMER_EXPORT = { area: 'customers', template: ['name', 'phone', 'email', 'gstin', 'pan', 'state_code', 'dob', 'anniversary', 'address_line1', 'city', 'pincode'],
  sql: `SELECT name, phone, email, gstin, NULL AS pan, state_code, dob::text, anniversary::text, address->>'line1', address->>'city', address->>'pincode'
    FROM masters.customer WHERE ${ACT()} ORDER BY name, id` };

const ctxOf = async (): Promise<WriteCtx> => {
  const r = (await currentTx().query<{ u: string; t: string }>(`SELECT platform.current_user_id()::text AS u, platform.current_tenant()::text AS t`)).rows[0];
  return { auth: { userId: r.u, tenantId: r.t, permissions: new Set<string>() } as unknown as WriteCtx['auth'] };
};

async function validateKind(def: IoDef, rows: Record<string, string>[]): Promise<{ ok: Row[]; errors: RowErr[] }> {
  const c = currentTx();
  const maps = new Map<string, Map<string, string>>();
  const lookup = async (name: string) => {
    if (!maps.has(name)) maps.set(name, new Map((await c.query<{ k: string; id: string }>(LK[name].sql)).rows.map((x) => [x.k, x.id])));
    return maps.get(name)!;
  };
  for (const n of Object.keys(LK)) await lookup(n);
  const existing = def.dupSql ? new Set((await c.query<{ k: string }>(def.dupSql)).rows.map((x) => x.k.toUpperCase())) : new Set<string>();
  const ctx = await ctxOf();
  const ok: Row[] = []; const errors: RowErr[] = []; const seen = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; const row = i + 2; const before = errors.length;
    const e = (column: string | undefined, code: string, message: string) => errors.push({ row, column, code, message, raw: r });
    for (const k of def.required) if (!v(r[k])) e(k, 'required', 'required');
    if (errors.length > before) continue;
    const ref: Ref = (column, name, key) => {
      const id = key ? maps.get(name)!.get(key) : undefined;
      if (!id) e(column, 'not_found', 'unknown or inactive code');
      return id;
    };
    const raw = def.toBody(r, ref);
    if (errors.length > before) continue;
    const p = def.spec.create.safeParse(raw);
    if (!p.success) { for (const iss of p.error.issues) e(iss.path.join('.') || undefined, 'invalid_format', iss.message); continue; }
    const b = p.data as Row;
    if (def.dupKey) {
      const k = def.dupKey(b, r).toUpperCase();
      if (seen.has(k)) { e(def.template[0], 'duplicate_in_file', `duplicate of row ${seen.get(k)}`); continue; }
      seen.set(k, row);
      if (existing.has(k)) { e(def.template[0], 'already_exists', 'already exists'); continue; }
    }
    try {
      const db = def.spec.toDb ? def.spec.toDb(b, ctx) : b;
      await checkRefs(def.spec, db, Object.keys(db));
      if (def.spec.validate) await def.spec.validate(db, ctx);
    } catch (x) {
      if (!(x instanceof Problem)) throw x;
      const res = x.getResponse() as { code: string; detail?: string; errors?: { path: string; message: string }[] };
      e(res.errors?.[0]?.path, res.code, res.detail ?? res.code); continue;
    }
    ok.push(b);
  }
  return { ok, errors };
}

export function registerMasterImports(): void {
  for (const [kind, def] of Object.entries(IO)) {
    const area = typeof def.spec.area === 'string' ? def.spec.area : 'customers';
    registerImportKind(kind, { template: def.template, required: def.required, perm: `masters.${area}.manage`,
      validate: (rows) => validateKind(def, rows),
      async commit(ok) {
        const ctx = await ctxOf();
        for (const b of ok as Row[]) await insert(def.spec, b, ctx);
      } });
  }
}

// ---------- exports (981 platform.export_job; synchronous, ≤ 50k rows) ----------
export const EXPORT_KINDS = [...Object.keys(IO), 'customers'];
const ExportBody = z.object({ kind: z.string(), format: z.enum(['csv', 'xlsx']).default('xlsx'), filters: z.object({ include_inactive: z.boolean() }).partial().strict().default({}) }).strict();
const JOB = `id, kind, format, filters, status, file_id, row_count, error, created_by, created_at, started_at, finished_at, version`;
const MAX_EXPORT = 20_000;

@Controller('v1/exports')
export class ExportsController implements OnModuleInit {
  constructor(@Inject(STORAGE) private readonly storage: StorageService) {}
  onModuleInit(): void { registerMasterImports(); }

  @Get()
  async list(@Ctx() req: JwRequest, @Query('limit') limitQ?: string, @Query('cursor') cursor?: string) {
    need(req.auth, 'platform.export.run');
    const limit = limitQ === undefined ? 50 : Number(limitQ);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail(422, 'validation_failed', 'limit: 1-200');
    let after: [string, string] | null = null;
    if (cursor) {
      try { after = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [string, string]; } catch { fail(422, 'invalid_cursor'); }
      if (!Array.isArray(after) || after.length !== 2) fail(422, 'invalid_cursor');
    }
    const rows = (await currentTx().query<Row>(`SELECT ${JOB}, created_at::text AS _k FROM platform.export_job
      WHERE ($1::text IS NULL OR (created_at, id) < ($1::timestamptz, $2::uuid)) ORDER BY created_at DESC, id DESC LIMIT $3`,
      [after?.[0] ?? null, after?.[1] ?? null, limit + 1])).rows;
    const more = rows.length > limit; const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map(({ _k, ...r }) => r),
      next_cursor: more && last ? Buffer.from(JSON.stringify([last._k, last.id])).toString('base64url') : null };
  }

  @Get(':id')
  async get(@Ctx() req: JwRequest, @Param('id', ParseUUIDPipe) id: string) {
    need(req.auth, 'platform.export.run');
    return (await currentTx().query(`SELECT ${JOB} FROM platform.export_job WHERE id = $1`, [id])).rows[0] ?? fail(404, 'not_found');
  }

  /** Runs inline and returns the completed job; download via GET /v1/files/{file_id}/url (area exports). */
  @Post()
  async create(@Ctx() req: JwRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: { status(n: number): unknown }) {
    const auth = need(req.auth, 'platform.export.run');
    const b = parse(ExportBody, body);
    if (!EXPORT_KINDS.includes(b.kind)) fail(422, 'unsupported_export_kind', `exportable: ${EXPORT_KINDS.join(', ')}`);
    const io = IO[b.kind];
    const area = io ? (typeof io.spec.area === 'string' ? io.spec.area : 'customers') : CUSTOMER_EXPORT.area;
    need(auth, `masters.${area}.view`);
    const c = currentTx();
    const started = new Date().toISOString();
    const res = await c.query({ text: io ? io.exportSql : CUSTOMER_EXPORT.sql, values: [b.filters.include_inactive === true], rowMode: 'array' });
    if (res.rows.length > MAX_EXPORT) fail(422, 'too_many_rows', `max ${MAX_EXPORT} rows per export`);
    const header = io ? io.template : CUSTOMER_EXPORT.template;
    const { buf, contentType } = await writeTable(b.format, header, (res.rows as unknown[][]).map((r) => r.map((x) => (x === null || x === undefined ? null : String(x)))));
    const key = objectKey(auth.tenantId, 'exports');
    await this.storage.put(key, buf, contentType);
    try {
      const f = (await c.query<{ id: string }>(`INSERT INTO platform.file(tenant_id, area, object_key, original_name, content_type, size_bytes, sha256, created_by)
        VALUES (platform.current_tenant(), 'exports', $1, $2, $3, $4, $5, $6) RETURNING id`,
        [key, `${b.kind}-${started.slice(0, 10)}.${b.format}`, contentType, buf.length, sha256(buf), auth.userId])).rows[0];
      const job = (await c.query(`INSERT INTO platform.export_job(tenant_id, kind, format, filters, status, file_id, row_count, created_by, started_at, finished_at)
        VALUES (platform.current_tenant(), $1, $2, $3::jsonb, 'completed', $4, $5, $6, $7, now()) RETURNING ${JOB}`,
        [b.kind, b.format, JSON.stringify(b.filters), f.id, res.rows.length, auth.userId, started])).rows[0];
      reply.status(201);
      return job;
    } catch (e) {
      await this.storage.delete(key).catch(() => undefined);
      throw e;
    }
  }
}
