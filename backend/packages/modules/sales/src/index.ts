/** Public facade of the Sales module. ONLY Sales writes sales.invoice / credit_note / doc_series / receipts / prints (as sales_writer). */
export const MODULE = 'sales' as const;
export * from './service';
