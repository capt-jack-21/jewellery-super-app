import { fail } from './errors';

/**
 * Other modules' services Sales calls, wired by the composition root (apps/api SalesModule) so Sales never imports another module's
 * internals and never writes their tables: ONLY Inventory mutates stock, ONLY Masters writes customers (and their encrypted PAN).
 * Every call runs on the caller's request transaction (AsyncLocalStorage in @jw/db), so a failure anywhere rolls everything back.
 */
export interface SaleTagRow {
  id: string; tag_no: string; branch_id: string; item_id: string; sub_item_id: string | null; purity_id: string; status: string;
  pieces: number; gross_wt: string; stone_wt: string; net_wt: string; counter_id: string | null; box_id: string | null;
  huid: string | null; hallmark_exempt: boolean; hsn: string | null; mc_type: string; mc_value: string; wastage_pct: string;
  min_wastage_pct: string | null; max_wastage_pct: string | null; min_sale_value: string | null; max_sale_value: string | null; huid_charge: string;
}
export interface StockCtx { branchId: string; userId: string; sourceType: string; sourceId: string; reservedTagIds?: readonly string[] }
export interface LooseQty { item_id: string; purity_id: string; counter_id: string | null; box_id: string | null; pieces: number; gross_wt: string; net_wt: string }
/** One line going back to stock: a tag (tag_id) or a loose quantity; counter_id / box_id = where it goes. */
export interface ReturnRow { tag_id: string | null; item_id: string; purity_id: string; counter_id: string | null; box_id: string | null; pieces: number; gross_wt: string; net_wt: string }
export interface StockPort {
  /** Scan resolution: tag number / HUID / label payload → tag id (undefined = unknown). */
  findTag(code: string): Promise<string | undefined>;
  /** Tags by id (lock = FOR UPDATE in id order for the rest of the transaction); missing ids are absent from the map. */
  tags(ids: string[], lock: boolean): Promise<Map<string, SaleTagRow>>;
  /** Stock.validateSellable: throws 409 tag_sold / tag_reserved / … / tag_other_branch / huid_missing. */
  assertSellable(t: SaleTagRow, branchId: string, reservedOk?: boolean): void;
  /** in_stock → sold + ledger 'sale' (-1) at the piece's location. 409 when a piece is not sellable any more. */
  markSold(tagIds: string[], ctx: StockCtx): Promise<void>;
  /** Loose sale: 409 insufficient_loose_stock unless the location holds it; ledger 'sale' (-1). */
  sellLoose(rows: LooseQty[], ctx: StockCtx): Promise<void>;
  /** Old gold taken in on a bill: ledger 'old_metal_in' (+1, item_id NULL); returns the ledger row ids in input order. */
  oldMetalIn(rows: { purity_id: string; gross_wt: string; net_wt: string }[], ctx: StockCtx): Promise<string[]>;
  /** Back to stock (cancel / return): tags sold → in_stock at the target counter / tray; loose rows +1 there. */
  returnToStock(rows: ReturnRow[], ctx: StockCtx & { movement: 'sales_return' | 'cancel_reversal' }): Promise<void>;
}
export interface CustomerRow {
  id: string; name: string; phone: string | null; gstin: string | null; state_code: string | null; address: Record<string, unknown> | null;
  pan_last4: string | null; is_active: boolean;
}
export interface CustomerPort {
  get(id: string): Promise<CustomerRow | undefined>;
  byPhone(phone: string): Promise<CustomerRow | undefined>;
  /** Masters quick-add (S1). 409 customer_phone_exists is decided by Sales before calling. */
  quickAdd(c: { name: string; phone: string; gstin?: string | null; state_code?: string | null; address?: Record<string, unknown> | null; home_branch_id: string }): Promise<CustomerRow>;
  /** Stores the PAN encrypted on the customer (Masters). Never logged or audited in clear. */
  setPan(customerId: string, pan: string): Promise<void>;
}
/** Amount in words (Indian lakh / crore) for prints; locale e.g. en-IN. Injected from @jw/shared through the API composition. */
export type WordsPort = (amount: string, locale: string) => string;
let words: WordsPort | undefined;
let stock: StockPort | undefined;
let customers: CustomerPort | undefined;
export function registerSalesPorts(p: { stock: StockPort; customers: CustomerPort; words?: WordsPort }): void { stock = p.stock; customers = p.customers; words = p.words ?? words; }
export const wordsPort = (): WordsPort => words ?? fail(500, 'not_wired', 'Sales words port not registered');
export const stockPort = (): StockPort => stock ?? fail(500, 'not_wired', 'Sales stock port not registered');
export const customerPort = (): CustomerPort => customers ?? fail(500, 'not_wired', 'Sales customer port not registered');
