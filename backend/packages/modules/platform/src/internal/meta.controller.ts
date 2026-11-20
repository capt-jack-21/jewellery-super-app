import { Controller, Get, Inject } from '@nestjs/common';
import { PG_POOL } from '@jw/db';
import type { Pool } from 'pg';
import { Auth } from './common';
import { CONTRACT_VERSION } from './contract-version';

/** Oldest client the API still serves (contract 0.3.0 clients keep working). */
export const MIN_CLIENT_VERSION = '0.3.0';

/** Public client-compatibility probe (merged from Mirage's platform-ext draft). No tenant data. */
@Controller('v1/meta')
export class MetaController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** platform.language is a global catalogue (no tenant_id, no RLS; SELECT for app_rw). */
  @Get('languages') @Auth('public')
  async languages() {
    return (await this.pool.query(`SELECT code, name, native_name FROM platform.language ORDER BY code`)).rows;
  }

  @Get() @Auth('public')
  meta() {
    return { api_version: CONTRACT_VERSION, min_client_version: process.env.MIN_CLIENT_VERSION ?? MIN_CLIENT_VERSION,
      deployment_mode: (process.env.DEPLOYMENT_MODE ?? 'shared') as 'shared' | 'dedicated' | 'onprem' };
  }
}
