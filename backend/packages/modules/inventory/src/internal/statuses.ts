import { fail } from './errors';

/** inventory.tag.status after the updated 987, exactly. */
export const TAG_STATUSES = ['in_stock', 'reserved', 'sold', 'on_approval', 'repair', 'melting', 'in_transit',
  'returned_to_vendor', 'melted', 'written_off'] as const;
export type TagStatus = (typeof TAG_STATUSES)[number];
export const TERMINAL: ReadonlySet<TagStatus> = new Set<TagStatus>(['sold', 'melted', 'returned_to_vendor', 'written_off']);
export const isInStock = (s: TagStatus): boolean => !TERMINAL.has(s);
/** Pieces that may be moved, transferred, adjusted or tagged into a check. */
export const MOVABLE: ReadonlySet<TagStatus> = new Set<TagStatus>(['in_stock', 'reserved']);

/** How a status change is made. 'manual' = POST /tags/{id}/status; the rest are service calls of their owning flow. */
export type Via = 'manual' | 'sale' | 'sales_return' | 'approval_out' | 'approval_in' | 'vendor_return' | 'melt_send'
  | 'melt' | 'transfer_dispatch' | 'transfer_receive' | 'transfer_return' | 'full_write_off' | 'order_reserve' | 'order_release';

const T: Record<Via, [TagStatus[], TagStatus][]> = {
  manual: [[['in_stock'], 'reserved'], [['in_stock'], 'repair'], [['in_stock'], 'melting'], [['reserved', 'repair', 'melting'], 'in_stock']],
  sale: [[['in_stock', 'reserved'], 'sold']],
  sales_return: [[['sold'], 'in_stock']],
  approval_out: [[['in_stock', 'reserved'], 'on_approval']],
  approval_in: [[['on_approval'], 'in_stock']],
  vendor_return: [[['in_stock'], 'returned_to_vendor']],
  melt_send: [[['in_stock'], 'melting']],
  melt: [[['melting'], 'melted']],
  transfer_dispatch: [[['in_stock'], 'in_transit']],
  transfer_receive: [[['in_transit'], 'in_stock']],
  transfer_return: [[['in_transit'], 'in_stock']],
  full_write_off: [[['in_stock', 'reserved', 'repair', 'melting', 'on_approval'], 'written_off']],
  order_reserve: [[['in_stock'], 'reserved']],
  order_release: [[['reserved'], 'in_stock']],
};
const LABEL: Record<TagStatus, string> = {
  in_stock: 'Available', reserved: 'Reserved', sold: 'Sold', on_approval: 'On approval', repair: 'In repair', melting: 'Sent for melting',
  in_transit: 'In transit', returned_to_vendor: 'Returned to vendor', melted: 'Melted', written_off: 'Written off',
};
const VIA_LABEL: Record<Via, string> = {
  manual: 'POST /v1/inventory/tags/{id}/status', sale: 'Sales markSold', sales_return: 'Sales returnToStock',
  approval_out: 'Approval memo issueOnApproval', approval_in: 'Approval memo returnFromApproval', vendor_return: 'Purchases returnToVendor',
  melt_send: 'Refinery sendToMelting', melt: 'Refinery melt', transfer_dispatch: 'POST /v1/inventory/transfers/{id}/dispatch',
  transfer_receive: 'POST /v1/inventory/transfers/{id}/receive', transfer_return: 'POST /v1/inventory/transfers/{id}/return',
  full_write_off: 'POST /v1/inventory/adjustments/{id}/approve (kind full_write_off)',
  order_reserve: 'Orders receiveLine (piece reserved for the order)', order_release: 'Orders cancel / release (piece back to stock)',
};

/** Throws 409 unless from → to is allowed through `via`. A written_off piece never changes again (409 tag_written_off). */
export function assertTransition(from: TagStatus, to: TagStatus, via: Via): void {
  if (from === 'written_off') fail(409, 'tag_written_off', 'the piece is written off and can not change any more');
  if (to === 'written_off' && via !== 'full_write_off') fail(409, 'invalid_status_transition', 'written_off is reached only by an approved full write-off');
  if (!T[via].some(([f, t]) => t === to && f.includes(from))) fail(409, 'invalid_status_transition', `${from} → ${to} is not allowed here`);
}
export function statusCatalog() {
  return TAG_STATUSES.map((code) => ({
    code, label: LABEL[code], in_stock: isInStock(code), sellable: code === 'in_stock', terminal: TERMINAL.has(code),
    transitions: (Object.keys(T) as Via[]).flatMap((via) => T[via].filter(([f]) => f.includes(code)).map(([, to]) => ({ to, via: VIA_LABEL[via] }))),
  }));
}
