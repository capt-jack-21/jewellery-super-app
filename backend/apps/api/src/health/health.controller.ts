import { Controller, Get } from '@nestjs/common';
import { currentTx } from '@jw/db';
import { Auth } from '@jw/mod-platform';

@Controller()
export class HealthController {
  @Auth('public') @Get('health') health() { return { status: 'ok' }; }
  /** Tenant-scoped probe: proves the request tx carries app.tenant_id and RLS applies. */
  @Get('v1/whoami') async whoami() {
    const r = await currentTx().query(`SELECT platform.current_tenant() AS tenant, current_user AS role,
      (SELECT count(*)::int FROM platform.branch) AS branches`);
    return r.rows[0];
  }
}
