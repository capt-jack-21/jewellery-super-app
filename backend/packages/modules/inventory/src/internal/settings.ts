import { type InventoryActor, need } from './actor';
import { fail, invalid } from './errors';
import { one, audit, iso } from './db';
import { ADJUSTMENT_NO_FORMAT, DEFAULT_TAG_FORMAT, TRANSFER_NO_FORMAT, type TagFormat, renderTagNo, validateTagFormat, validateDocNoFormat } from './numbering';

export interface InventorySettings {
  tag_format: TagFormat; adjustment_approver: 'owner_or_manager' | 'owner_only'; photos_enabled: boolean; ageing_enabled: boolean;
  ageing_bucket_days: number[]; transfer_no_format: string; adjustment_no_format: string;
  source: 'default' | 'shop'; version: number; updated_at: string | null; updated_by: string | null;
}
interface Row {
  tag_prefix: string; tag_separator: '' | '-' | '/'; tag_branch_segment: boolean; tag_item_segment: boolean; tag_segment_order: 'branch_item' | 'item_branch';
  tag_start_no: string; tag_digits: number; adjustment_approver: 'owner_or_manager' | 'owner_only'; photos_enabled: boolean; ageing_enabled: boolean;
  ageing_bucket_days: number[]; transfer_no_format: string; adjustment_no_format: string; version: number; updated_at: string | null; updated_by: string | null;
}
const COLS = `tag_prefix, tag_separator, tag_branch_segment, tag_item_segment, tag_segment_order, tag_start_no::text, tag_digits, adjustment_approver,
  photos_enabled, ageing_enabled, ageing_bucket_days, transfer_no_format, adjustment_no_format, version, ${iso('updated_at')}, updated_by`;
const view = (r: Row | undefined): InventorySettings => r ? {
  tag_format: { prefix: r.tag_prefix, separator: r.tag_separator, branch_segment: r.tag_branch_segment, item_segment: r.tag_item_segment,
    segment_order: r.tag_segment_order, start_no: Number(r.tag_start_no), digits: r.tag_digits },
  adjustment_approver: r.adjustment_approver, photos_enabled: r.photos_enabled, ageing_enabled: r.ageing_enabled,
  ageing_bucket_days: r.ageing_bucket_days, transfer_no_format: r.transfer_no_format, adjustment_no_format: r.adjustment_no_format,
  source: 'shop', version: r.version, updated_at: r.updated_at, updated_by: r.updated_by,
} : {
  tag_format: { ...DEFAULT_TAG_FORMAT }, adjustment_approver: 'owner_or_manager', photos_enabled: false, ageing_enabled: false,
  ageing_bucket_days: [30, 90, 180, 365], transfer_no_format: TRANSFER_NO_FORMAT, adjustment_no_format: ADJUSTMENT_NO_FORMAT,
  source: 'default', version: 0, updated_at: null, updated_by: null,
};

/** Settings without a permission check (internal use by the other services). */
export async function loadSettings(lock = false): Promise<InventorySettings> {
  return view(await one<Row>(`SELECT ${COLS} FROM inventory.shop_setting ${lock ? 'FOR UPDATE' : ''}`));
}
export async function getSettings(a: InventoryActor): Promise<InventorySettings> {
  need(a, 'inventory.stock.view');
  return loadSettings();
}
export interface SettingsPatch {
  tag_format?: Partial<TagFormat>; adjustment_approver?: 'owner_or_manager' | 'owner_only'; photos_enabled?: boolean;
  ageing_enabled?: boolean; ageing_bucket_days?: number[]; transfer_no_format?: string; adjustment_no_format?: string;
}
/** PATCH (owner: inventory.settings.edit). ifVersion is required once a row exists (412 version_mismatch / 428). */
export async function patchSettings(a: InventoryActor, p: SettingsPatch, ifVersion: number | null): Promise<InventorySettings> {
  need(a, 'inventory.settings.edit');
  if (!Object.keys(p).length) invalid('', 'empty patch');
  const cur = await loadSettings(true);
  if (cur.source === 'shop') {
    if (ifVersion === null) fail(428, 'precondition_required', 'Send If-Match with the settings version');
    if (ifVersion !== cur.version) fail(412, 'version_mismatch', 'settings were changed by someone else');
  }
  const f: TagFormat = { ...cur.tag_format, ...(p.tag_format ?? {}) } as TagFormat;
  const errs = validateTagFormat(f);
  if (errs.length) fail(422, 'validation_failed', 'tag_format', errs.map((e) => ({ ...e, code: 'invalid' })));
  if (p.adjustment_approver && !['owner_or_manager', 'owner_only'].includes(p.adjustment_approver)) invalid('adjustment_approver', 'owner_or_manager | owner_only');
  let buckets = cur.ageing_bucket_days;
  if (p.ageing_bucket_days) {
    const b = [...new Set(p.ageing_bucket_days)].sort((x, y) => x - y);
    if (!b.length || b.length > 8 || b.some((d) => !Number.isInteger(d) || d < 1 || d > 3650)) invalid('ageing_bucket_days', '1-8 whole days, 1-3650');
    buckets = b;
  }
  const fmtErrs = [...validateDocNoFormat('transfer_no_format', p.transfer_no_format), ...validateDocNoFormat('adjustment_no_format', p.adjustment_no_format)];
  if (fmtErrs.length) fail(422, 'validation_failed', 'number format', fmtErrs.map((e) => ({ ...e, code: 'invalid_format' })));
  const vals = [f.prefix, f.separator, f.branch_segment, f.item_segment, f.segment_order, f.start_no, f.digits,
    p.adjustment_approver ?? cur.adjustment_approver, p.photos_enabled ?? cur.photos_enabled, p.ageing_enabled ?? cur.ageing_enabled, buckets, a.userId,
    p.transfer_no_format ?? cur.transfer_no_format, p.adjustment_no_format ?? cur.adjustment_no_format];
  const r = cur.source === 'default'
    ? await one<Row>(`INSERT INTO inventory.shop_setting(tenant_id, tag_prefix, tag_separator, tag_branch_segment, tag_item_segment, tag_segment_order,
        tag_start_no, tag_digits, adjustment_approver, photos_enabled, ageing_enabled, ageing_bucket_days, updated_by,
        transfer_no_format, adjustment_no_format)
        VALUES (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::int[], $12, $13, $14) RETURNING ${COLS}`, vals)
    : await one<Row>(`UPDATE inventory.shop_setting SET tag_prefix=$1, tag_separator=$2, tag_branch_segment=$3, tag_item_segment=$4, tag_segment_order=$5,
        tag_start_no=$6, tag_digits=$7, adjustment_approver=$8, photos_enabled=$9, ageing_enabled=$10, ageing_bucket_days=$11::int[], updated_by=$12,
        transfer_no_format=$13, adjustment_no_format=$14, updated_at=now() WHERE tenant_id = platform.current_tenant() RETURNING ${COLS}`, vals);
  await audit('inventory.settings.updated', 'inventory.shop_setting', null, { fields: Object.keys(p) });
  return view(r);
}
/** POST /settings/tag-format/preview: renders samples without consuming numbers. */
export async function previewTagFormat(a: InventoryActor, input: { tag_format?: Partial<TagFormat>; branch_id?: string; item_id?: string; count?: number }) {
  need(a, 'inventory.stock.view');
  const f: TagFormat = { ...(await loadSettings()).tag_format, ...(input.tag_format ?? {}) } as TagFormat;
  const errors = validateTagFormat(f).map((e) => ({ ...e, code: 'invalid' }));
  if (errors.length) return { valid: false, samples: [], errors };
  const b = input.branch_id ? await one<{ code: string }>(`SELECT code FROM platform.branch WHERE id = $1`, [input.branch_id]) : undefined;
  const i = input.item_id ? await one<{ code: string }>(`SELECT code FROM masters.item WHERE id = $1`, [input.item_id]) : undefined;
  const ctx = { branchCode: b?.code ?? 'BR', itemCode: i?.code ?? 'ITEM' };
  const n = Math.min(Math.max(input.count ?? 3, 1), 5);
  const samples = Array.from({ length: n }, (_, k) => renderTagNo(f, ctx, f.start_no + k));
  const tooLong = samples.some((s) => s.length > 30);
  return { valid: !tooLong, samples, errors: tooLong ? [{ path: 'tag_format', code: 'too_long', message: 'tag number longer than 30' }] : [] };
}
