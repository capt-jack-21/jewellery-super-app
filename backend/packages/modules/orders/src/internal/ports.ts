import { type OrdersActor } from './actor';
import { fail } from './errors';

/**
 * Ports: what Orders needs from other modules. Orders never imports Inventory; the API composition root (apps/api/src/orders) injects the
 * public Inventory function. Stock changes run in the caller's transaction under the Inventory module role.
 */
export interface ReceivePieceInput {
  branch_id: string; order_id: string; order_no: string; vendor_id: string; item_id: string; purity_id: string; pieces: number;
  gross_wt: string; stone_wt?: string; net_wt?: string; huid?: string | null; size?: string | null; counter_id?: string | null; box_id?: string | null;
  received_on?: string;
}
export interface ReceivedPiece { lot_id: string; lot_no: string; tag_id: string; tag_no: string }
export interface StockPort {
  /** Inventory: lot (order_receipt) + tag + reserved for the order. */
  receivePiece(a: OrdersActor, i: ReceivePieceInput): Promise<ReceivedPiece>;
}
export interface TakeAdvanceInput {
  branch_id: string; customer_id: string; order_id?: string; repair_id?: string; kind: 'amount' | 'metal'; amount?: string; purity_id?: string; weight?: string;
  locked_rate_per_g?: string | null; purpose?: string | null; received_on?: string;
}
export interface AdvanceRow {
  id: string; receipt_no: string; branch_id: string; customer_id: string; order_id: string | null; repair_id: string | null; kind: 'amount' | 'metal'; received_on: string;
  amount: string; purity_id: string | null; weight: string | null; locked_rate_per_g: string | null; balance: string; balance_fine_g: string;
  status: string; purpose: string | null;
}
export interface OrderInvoiceRequest {
  order_id: string; branch_id: string; customer_id: string; tag_ids: string[]; locked_rate_per_g: string | null; rate_rule: 'locked' | 'lower_of';
  advance_ids: string[]; bill: Record<string, unknown>;
}
export interface RepairInvoiceRequest {
  repair_id: string; branch_id: string; customer_id: string; advance_ids: string[]; bill: Record<string, unknown>;
  lines: { description: string; sac: string | null; amount: string }[];
}
export interface SalesPort {
  /** Sales: the service bill that delivers a repair (repair charges as service lines, money advances applied as payment). */
  issueRepairInvoice(a: OrdersActor, i: RepairInvoiceRequest): Promise<{ id: string; doc_no: string; advances: { advance_id: string; amount: string }[] }>;
  /** Sales: the bill that delivers the order (locked rate, money advances as payment, reserved tags sold). One transaction with the caller. */
  issueOrderInvoice(a: OrdersActor, i: OrderInvoiceRequest): Promise<{ id: string; doc_no: string; advances: { advance_id: string; amount: string }[] }>;
  /** Sales: money or metal advance (receipt number, fine-gram balance). Orders never writes sales.advance. */
  takeAdvance(a: OrdersActor, i: TakeAdvanceInput): Promise<AdvanceRow>;
  listAdvances(orderId: string): Promise<AdvanceRow[]>;
  listRepairAdvances(repairId: string): Promise<AdvanceRow[]>;
}
let stock: StockPort | undefined;
let sales: SalesPort | undefined;
export function registerOrdersPorts(p: { stock: StockPort; sales: SalesPort }): void { stock = p.stock; sales = p.sales; }
export const stockPort = (): StockPort => stock ?? fail(500, 'not_wired', 'Orders stock port not registered');
export const salesPort = (): SalesPort => sales ?? fail(500, 'not_wired', 'Orders sales port not registered');
