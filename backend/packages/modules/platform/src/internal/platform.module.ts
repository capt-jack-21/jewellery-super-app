import { MetaController } from './meta.controller';
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AdminController } from './admin.controller';
import { AuditController } from './audit.controller';
import { AuthController } from './auth.controller';
import { AuthInterceptor } from './auth.interceptor';
import { BankAccountsController } from './bank-accounts.controller';
import { BrandingController, DNS_RESOLVER, defaultResolver } from './branding.controller';
import { DevicesController } from './devices.controller';
import { FilesController } from './files.controller';
import { ImportController } from './import.controller';
import { OnboardingController } from './onboarding.controller';
import { PartnerController } from './partner.controller';
import { SessionService } from './session.service';
import { FILE_TOKEN_KEY, STORAGE, fileTokenKeyFromEnv, storageFromEnv } from './storage';
import { SettingsController } from './settings.controller';
import { TenantController } from './tenant.controller';
import { UsersController } from './users.controller';

/** Needs PG_POOL and ADMIN_POOL providers from the host app (global). */
@Module({
  controllers: [MetaController, AuthController, DevicesController, TenantController, BankAccountsController, UsersController, SettingsController, OnboardingController,
    BrandingController, AuditController, ImportController, FilesController, PartnerController, AdminController],
  providers: [SessionService, { provide: DNS_RESOLVER, useValue: defaultResolver }, { provide: APP_INTERCEPTOR, useClass: AuthInterceptor },
    // 0.5.0: env validated at boot (factories throw on bad STORAGE_DRIVER / S3_* / FILE_TOKEN_SECRET)
    { provide: STORAGE, useFactory: () => storageFromEnv() }, { provide: FILE_TOKEN_KEY, useFactory: () => fileTokenKeyFromEnv() }],
  exports: [SessionService, STORAGE],
})
export class PlatformModule {}
