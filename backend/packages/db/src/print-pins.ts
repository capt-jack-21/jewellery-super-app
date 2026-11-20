/**
 * B-2 (0.9.6): the release-renderable print templates. The 0.9.x frontend renders ONLY these exact 998 platform pins
 * (bundled-pins.json); it does not resolve by body_key. The server backstop therefore uses exact (template_id, version, doc_type)
 * pin membership: template create/activate and print-time checks share this list, and contracts/openapi.yaml publishes
 * the same body_key values (ReleaseRenderableBodyKey) for the FE. Keep in sync with migration 998 (an integration test checks the DB rows).
 * doc_type is the branding.print_template doc_type (sales payment_receipt prints use 'receipt').
 */
export interface ReleasePrintPin { doc_type: 'invoice' | 'estimate' | 'credit_note' | 'receipt'; template_id: string; version: number; engine: 'handlebars'; body_key: string }
export const RELEASE_PRINT_PINS: readonly ReleasePrintPin[] = Object.freeze([
  { doc_type: 'invoice', template_id: '01a1c455-29fa-769b-84f9-377a9bcdab46', version: 1, engine: 'handlebars', body_key: 'tpl/platform/invoice.hbs' },
  { doc_type: 'estimate', template_id: '01a1c455-29fa-7963-88e9-d3cf6e2a8240', version: 1, engine: 'handlebars', body_key: 'tpl/platform/estimate.hbs' },
  { doc_type: 'credit_note', template_id: '01a1c455-29fa-7856-b4ed-a3710fd91ec1', version: 1, engine: 'handlebars', body_key: 'tpl/platform/credit_note.hbs' },
  { doc_type: 'receipt', template_id: '01a1c455-29fa-7811-b4b1-95efbd5b9ea5', version: 1, engine: 'handlebars', body_key: 'tpl/platform/receipt.hbs' },
] as const);
export const RELEASE_RENDERABLE_BODY_KEYS: readonly string[] = Object.freeze(RELEASE_PRINT_PINS.map((p) => p.body_key));
/** True only for an exact release pin: same template id, same version, same template doc_type. */
export function isReleaseRenderablePin(docType: string, templateId: string | null | undefined, version: number | null | undefined): boolean {
  return RELEASE_PRINT_PINS.some((p) => p.doc_type === docType && p.template_id === templateId && p.version === version);
}
/** The platform default pin a non-renderable first print may be re-pinned to (recovery), or undefined for non-Sales doc types. */
export const releasePinFor = (docType: string): ReleasePrintPin | undefined => RELEASE_PRINT_PINS.find((p) => p.doc_type === docType);
/**
 * 0.9.6 tag_label no-regression: Inventory labels (POST /v1/inventory/labels) are drawn by the client from TagLabelBatch; the
 * template only supplies config.barcode_format (code128 | qr). No platform tag_label template exists (998 seeds none), so QR labels
 * need a shop's own tag_label template. These doc types are EXEMPT from the release-pin check on create, activate and resolve,
 * exactly as before B-2 (b13a296), and their rows report renderable = true.
 */
export const RENDERABLE_CHECK_EXEMPT_DOC_TYPES: readonly string[] = Object.freeze(['tag_label']);
export const isRenderableCheckExempt = (docType: string): boolean => RENDERABLE_CHECK_EXEMPT_DOC_TYPES.includes(docType);
