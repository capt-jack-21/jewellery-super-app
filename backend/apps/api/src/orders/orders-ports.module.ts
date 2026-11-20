import { Module, type OnModuleInit } from '@nestjs/common';
import * as inv from '@jw/mod-inventory';
import { todayIST } from '@jw/mod-platform';
import * as sales from '@jw/mod-sales';
import { OrdersError, registerOrdersPorts } from '@jw/mod-orders';

/**
 * Composition root for Orders: Orders never imports Inventory; its public service function is injected as a port here
 * (stock changes run in the caller's transaction under the Inventory module role; Orders never writes inventory tables).
 */
@Module({})
export class OrdersPortsModule implements OnModuleInit {
  onModuleInit(): void {
    registerOrdersPorts({
      stock: {
        async receivePiece(a, i) {
          try {
            const r = await inv.receiveOrderPiece(a, i);
            return { lot_id: r.lot_id, lot_no: r.lot_no, tag_id: r.tag_id, tag_no: r.tag_no };
          } catch (e) {
            // Inventory's refusals (HUID, weights, counter) reach the client with Inventory's own code and field errors
            if (e instanceof inv.InventoryError) throw new OrdersError(e.status, e.code, e.message, e.errors);
            throw e;
          }
        },
      },
      sales: {
        async takeAdvance(a, i) {
          try { return await sales.takeAdvance(a, i); }
          catch (e) { if (e instanceof sales.SalesError) throw new OrdersError(e.status, e.code, e.message, e.errors); throw e; }
        },
        async issueOrderInvoice(a, i) {
          try { return await sales.issueOrderInvoice(a, i, await todayIST()); }
          catch (e) { if (e instanceof sales.SalesError) throw new OrdersError(e.status, e.code, e.message, e.errors); throw e; }
        },
        async issueRepairInvoice(a, i) {
          try { return await sales.issueRepairInvoice(a, i, await todayIST()); }
          catch (e) { if (e instanceof sales.SalesError) throw new OrdersError(e.status, e.code, e.message, e.errors); throw e; }
        },
        listAdvances: (orderId) => sales.listAdvances(orderId),
        listRepairAdvances: (repairId) => sales.listRepairAdvances(repairId),
      },
    });
  }
}
