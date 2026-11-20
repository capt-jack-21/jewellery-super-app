import { many } from './db';

/**
 * RefLabels for list rows (contract 0.7.1): { <id field>: { code, name } } for the referenced ids the caller can read
 * (RLS; ids that are not visible are simply omitted). Purities have no name column: name = code.
 */
const SOURCES = {
  branch: `SELECT id, code, name FROM platform.branch WHERE id = ANY($1::uuid[])`,
  item: `SELECT id, code, name FROM masters.item WHERE id = ANY($1::uuid[])`,
  purity: `SELECT id, code, code AS name FROM masters.purity WHERE id = ANY($1::uuid[])`,
  counter: `SELECT id, code, name FROM masters.counter WHERE id = ANY($1::uuid[])`,
  tray: `SELECT id, code, name FROM masters.box WHERE id = ANY($1::uuid[])`,
  vendor: `SELECT id, code, name FROM masters.vendor WHERE id = ANY($1::uuid[])`,
} as const;
export type LabelSource = keyof typeof SOURCES;
export type LabelFields = Record<string, LabelSource>;
type Lbl = { code: string | null; name: string };

export async function withLabels<T extends Record<string, unknown>>(rows: T[], fields: LabelFields): Promise<(T & { labels: Record<string, Lbl> })[]> {
  const want = new Map<LabelSource, Set<string>>();
  for (const r of rows) for (const [f, src] of Object.entries(fields)) {
    const v = r[f];
    if (typeof v === 'string') (want.get(src) ?? want.set(src, new Set()).get(src)!).add(v);
  }
  const found = new Map<LabelSource, Map<string, Lbl>>();
  for (const [src, ids] of want) {
    const got = await many<{ id: string; code: string | null; name: string }>(SOURCES[src], [[...ids]]);
    found.set(src, new Map(got.map((g) => [g.id, { code: g.code, name: g.name ?? g.code ?? '' }])));
  }
  return rows.map((r) => {
    const labels: Record<string, Lbl> = {};
    for (const [f, src] of Object.entries(fields)) {
      const v = r[f];
      const l = typeof v === 'string' ? found.get(src)?.get(v) : undefined;
      if (l) labels[f] = l;
    }
    return { ...r, labels };
  });
}
