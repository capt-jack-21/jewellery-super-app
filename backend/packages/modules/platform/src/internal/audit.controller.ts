import { Controller, Get, Query } from '@nestjs/common';
import { currentTx } from '@jw/db';
import { z } from 'zod';
import { RequirePermission, parse } from './common';
import { uuid } from './schemas';

const Q = z.object({
  from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(),
  table: z.string().max(80).optional(), row_id: uuid.optional(), user_id: uuid.optional(), action: z.string().max(60).optional(),
  before_seq: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

@Controller('v1/audit-events')
export class AuditController {
  @Get() @RequirePermission('reports.view')
  async list(@Query() query: unknown) {
    const q = parse(Q, query);
    const r = await currentTx().query<{ seq: string }>(
      `SELECT seq::int AS seq, occurred_at, user_id, branch_id, host(ip) AS ip, action, table_name, row_id, old_row, new_row, encode(hash, 'hex') AS hash
         FROM platform.audit_event
        WHERE tenant_id = platform.current_tenant()
          AND ($1::timestamptz IS NULL OR occurred_at >= $1) AND ($2::timestamptz IS NULL OR occurred_at < $2)
          AND ($3::text IS NULL OR table_name = $3) AND ($4::uuid IS NULL OR row_id = $4) AND ($5::uuid IS NULL OR user_id = $5)
          AND ($6::text IS NULL OR action = $6) AND ($7::bigint IS NULL OR seq < $7)
        ORDER BY seq DESC LIMIT $8`,
      [q.from ?? null, q.to ?? null, q.table ?? null, q.row_id ?? null, q.user_id ?? null, q.action ?? null, q.before_seq ?? null, q.limit + 1]);
    const more = r.rows.length > q.limit;
    const items = r.rows.slice(0, q.limit);
    return { items, next_before_seq: more ? Number(items[items.length - 1].seq) : null };
  }

  @Get('verify') @RequirePermission('reports.view')
  async verify() {
    const r = await currentTx().query<{ broken: string | null; last: string | null }>(
      `SELECT platform.audit_verify(platform.current_tenant()) AS broken,
              (SELECT last_seq FROM platform.audit_chain_head WHERE tenant_id = platform.current_tenant()) AS last`);
    const b = r.rows[0];
    return { intact: b.broken === null, first_broken_seq: b.broken === null ? null : Number(b.broken), last_seq: Number(b.last ?? 0) };
  }
}
