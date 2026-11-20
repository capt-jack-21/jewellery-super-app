/** Public facade of the orders module. Other modules import only this file. ONLY Orders writes orders.* tables, as orders_writer. */
export * from './service';
export { OrdersModule } from './http/orders.module';
