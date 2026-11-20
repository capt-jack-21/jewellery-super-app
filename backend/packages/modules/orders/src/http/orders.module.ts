import { Module } from '@nestjs/common';
import { PlatformModule } from '@jw/mod-platform';
import { OrdersController, OrdersDueController, OrdersSettingsController, RepairsController } from './controllers';

/** Orders & Repairs HTTP module. Routes are added slice by slice (O1 /v1/orders, O12 /v1/orders/settings, O7 /v1/repairs). */
@Module({ imports: [PlatformModule], controllers: [OrdersSettingsController, OrdersDueController, OrdersController, RepairsController] })
export class OrdersModule {}
