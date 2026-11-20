import { Global, Module } from '@nestjs/common';
import { PlatformModule } from '@jw/mod-platform';
import { MastersModule } from '@jw/mod-masters';
import { RatesModule } from '@jw/mod-rates';
import { InventoryModule } from '@jw/mod-inventory';
import { OrdersModule } from '@jw/mod-orders';
import { SalesModule } from './sales/sales.module';
import { OrdersPortsModule } from './orders/orders-ports.module';
import { HealthController } from './health/health.controller';
import { ADMIN_POOL, makeAdminPool, makePool, PG_POOL } from './core/pool';

@Global()
@Module({
  providers: [{ provide: PG_POOL, useFactory: makePool }, { provide: ADMIN_POOL, useFactory: makeAdminPool }],
  exports: [PG_POOL, ADMIN_POOL],
})
export class DbModule {}

/** AuthInterceptor (per-request tenant tx + session auth) is registered globally by PlatformModule. */
@Module({ imports: [DbModule, PlatformModule, MastersModule, RatesModule, InventoryModule, SalesModule, OrdersModule, OrdersPortsModule], controllers: [HealthController] })
export class AppModule {}
