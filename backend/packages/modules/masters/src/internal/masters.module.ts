import { Module } from '@nestjs/common';
import { PlatformModule } from '@jw/mod-platform';
import { AttachmentsController, DesignPhotosController, GenericMastersController, KycRevealController } from './generic.controller';
import { ExportsController } from './io';
import { MastersController } from './masters.controller';
import { TaxSettingsController } from './tax-settings.controller';

/** Static routes (metals, purities, designs/:id/photos, vendors/pan-backfill-status) are registered before the generic :resource routes. */
@Module({ imports: [PlatformModule],
  controllers: [MastersController, TaxSettingsController, DesignPhotosController, KycRevealController, GenericMastersController, AttachmentsController, ExportsController] })
export class MastersModule {}
