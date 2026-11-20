/** Public facade of Inventory. ONLY Inventory mutates stock (tag.status/branch_id/weights, stock_ledger) as inventory_writer. */
export * from './service';
export { InventoryModule, stockImportViaInventory } from './http/inventory.module';
/** Request-body schemas exported for contract tests (0.8.7). */
export { LabelsIn } from './http/controllers';
