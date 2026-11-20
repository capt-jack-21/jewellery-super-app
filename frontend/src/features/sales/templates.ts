import type { SalesPrintDocument } from '@/lib/api/backend/model';
import { ApiError } from '@/lib/api/fetcher';
import definitions from './bundled-v1.json';
import seededPins from './bundled-pins.json';

export type BundledKind = SalesPrintDocument['doc_type'] | 'receipt';
export interface SeededTemplatePin { id: string; body_key: string; version: number; doc_type: BundledKind }
export interface BundledTemplate {
  body_key: string; template_version: number; doc_type: BundledKind;
  renderer: 'sales-gst-v1' | 'receipt-v1'; layout: 'standard' | 'compact'; heading_text: string; footer_text: string;
}
export interface SalesTemplateAsset extends Omit<BundledTemplate, 'doc_type' | 'renderer'> {
  template_id: string; doc_type: SalesPrintDocument['doc_type']; renderer: 'sales-gst-v1' | 'receipt-v1';
}
/** Append new versions; never edit/remove bundled-v1 or its frozen dependency hashes. No network or engine interpreter. */
export const BUNDLED_TEMPLATES: readonly BundledTemplate[] = Object.freeze(definitions.map((d) => Object.freeze(d as BundledTemplate)));
/** Exact deterministic IDs must come from verified seeds, NEVER random test/demo UUIDs or active-template discovery. */
export const SEEDED_TEMPLATE_PINS: readonly SeededTemplatePin[] = Object.freeze(seededPins.map((p) => Object.freeze(p as SeededTemplatePin)));
export const validTemplatePin = (d: Pick<SalesPrintDocument, 'template_id' | 'template_version'>) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(d.template_id ?? '') && Number.isInteger(d.template_version) && d.template_version > 0;
export function bundledTemplate(key: string, version: number, kind: BundledKind, paper: string, locale: string): BundledTemplate {
  const row = BUNDLED_TEMPLATES.find((r) => r.body_key === key && r.template_version === version && r.doc_type === kind);
  if (!row || !['A4', 'A5', 'thermal_80mm'].includes(paper) || !['en-IN', 'ta-IN'].includes(locale)) throw new ApiError(422, 'pinned_print_template_unavailable', 'The exact bundled print template is unavailable');
  return row;
}
export const matchesTemplateAsset = (d: SalesPrintDocument, a?: SalesTemplateAsset | null) => {
  if (!a || !validTemplatePin(d) || a.template_id !== d.template_id || a.template_version !== d.template_version || a.doc_type !== d.doc_type) return false;
  try { const row = bundledTemplate(a.body_key, a.template_version, a.doc_type === 'payment_receipt' ? 'receipt' : a.doc_type, d.paper, d.locale); return (['renderer', 'layout', 'heading_text', 'footer_text'] as const).every((k) => a[k] === row[k]); } catch { return false; }
};
/** 0.9.4 carries only template_id/version, NOT body_key. Resolve solely via verified immutable seed bindings. */
export function resolveBundledPin(d: { template_id: string; template_version: number; doc_type: BundledKind; paper: string; locale: string }, pins = SEEDED_TEMPLATE_PINS) {
  if (!validTemplatePin(d)) throw new ApiError(422, 'pinned_print_template_unavailable', 'Invalid print pin');
  const rows = pins.filter((p) => p.id === d.template_id && p.version === d.template_version && p.doc_type === d.doc_type);
  const pin = rows.length === 1 ? rows[0] : undefined;
  if (!pin) throw new ApiError(422, 'pinned_print_template_unavailable', 'The print template ID has no verified seeded body-key mapping');
  return Object.freeze({ ...bundledTemplate(pin.body_key, d.template_version, d.doc_type, d.paper, d.locale), template_id: d.template_id });
}
export async function resolveSalesTemplate(d: SalesPrintDocument, pins = SEEDED_TEMPLATE_PINS): Promise<SalesTemplateAsset> {
  const row = resolveBundledPin(d.doc_type === 'payment_receipt' ? { ...d, doc_type: 'receipt' } : d, pins);
  if (d.doc_type === 'payment_receipt' && row.renderer === 'receipt-v1' && row.doc_type === 'receipt') return { ...row, renderer: 'receipt-v1', doc_type: 'payment_receipt' };
  if (row.renderer !== 'sales-gst-v1' || row.doc_type === 'receipt') throw new ApiError(422, 'pinned_print_template_unavailable', 'Wrong document renderer');
  return { ...row, renderer: row.renderer, doc_type: row.doc_type };
}
