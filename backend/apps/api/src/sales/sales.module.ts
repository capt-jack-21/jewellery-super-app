import { Module, type OnModuleInit } from '@nestjs/common';
import { amountInWords } from '@jw/mod-platform';
import * as inv from '@jw/mod-inventory';
import * as masters from '@jw/mod-masters';
import { registerSalesPorts } from '@jw/mod-sales';
import { SalesCreditNotesController, SalesEstimatesController, SalesInvoicesController, SalesSetupController } from './sales.controllers';

/**
 * Composition root for Sales: Sales is framework-free and never imports Inventory / Masters internals; their public service functions are
 * injected as ports here (stock changes run in the caller's transaction under the Inventory module role; Sales never writes inventory tables).
 */
@Module({ controllers: [SalesSetupController, SalesInvoicesController, SalesEstimatesController, SalesCreditNotesController] })
export class SalesModule implements OnModuleInit {
  onModuleInit(): void {
    registerSalesPorts({
      stock: {
        findTag: inv.findTagForSale, tags: inv.tagsForSale, assertSellable: inv.assertSellable, markSold: inv.markSold,
        sellLoose: inv.sellLoose, oldMetalIn: inv.oldMetalIn, returnToStock: inv.returnToStock,
      },
      customers: { get: masters.customerForSale, byPhone: masters.customerByPhone, quickAdd: masters.quickAddCustomer, setPan: masters.setCustomerPan },
      words: (amount, locale) => amountInWords(amount, { locale }),
    });
  }
}
