/** Public facade of the masters module. Other modules import only this file. */
export const MODULE = 'masters' as const;
export { MastersModule } from './internal/masters.module';
export { type SaleCustomer, customerForSale, customerByPhone, quickAddCustomer, setCustomerPan } from './internal/customer-service';
