/** Reports: read-only. Uses the app_ro connection and reports.* views only. No INSERT/UPDATE/DELETE (guards.mjs). */
export const MODULE = 'reports' as const;
import { currentTx } from '@jw/db';
export async function seriesGapCount(): Promise<number> {
  return Number((await currentTx().query('SELECT count(*)::int AS n FROM reports.series_gaps')).rows[0].n);
}
