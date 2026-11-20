import { useQuery } from '@tanstack/react-query';
import type { Counter, Item, Tray } from '@/lib/api/backend/model';
import { useSignedIn, useCan, useSession } from '@/lib/session';
import { invPerm } from '@/lib/permissions';
import { mastersApi, MAX_LIMIT } from '@/features/masters/api';
import { useRateRefs } from '@/features/rates/hooks';
import { inventoryApi, inventoryKeys } from './api';

/** Reference lists the inventory screens label with (REAL 0.7.4 masters + rates). First 200 active rows per list. */
export function useInvRefs() {
  const signedIn = useSignedIn();
  const { metals, purities, branches } = useRateRefs();
  const list = <T,>(kind: 'items' | 'counters' | 'trays') => ({
    queryKey: ['masters', kind, 'list', { limit: MAX_LIMIT, inv: true }] as const,
    queryFn: async () => (await mastersApi.list(kind, { limit: String(MAX_LIMIT) })).items as unknown as T[],
    enabled: signedIn, staleTime: 5 * 60_000, retry: false,
  });
  const items = useQuery(list<Item>('items'));
  const counters = useQuery(list<Counter>('counters'));
  const trays = useQuery(list<Tray>('trays'));
  const byId = <T extends { id: string }>(xs: readonly T[]) => new Map(xs.map((x) => [x.id, x]));
  const itemMap = byId(items.data ?? []);
  const purityMap = byId(purities);
  const branchMap = byId(branches);
  const counterMap = byId(counters.data ?? []);
  const trayMap = byId(trays.data ?? []);
  return {
    items: items.data ?? [], counters: counters.data ?? [], trays: trays.data ?? [], metals, purities, branches,
    itemName: (id?: string | null) => (id ? itemMap.get(id)?.name ?? '—' : '—'),
    purityCode: (id?: string | null) => (id ? purityMap.get(id)?.code ?? '—' : '—'),
    branchName: (id?: string | null) => (id ? branchMap.get(id)?.name ?? '—' : '—'),
    counterName: (id?: string | null) => (id ? counterMap.get(id)?.name ?? '—' : '—'),
    trayName: (id?: string | null) => (id ? trayMap.get(id)?.name ?? '—' : '—'),
    item: (id?: string | null) => (id ? itemMap.get(id) : undefined),
  };
}

/** Inventory permission check (contract 0.8.0 codes); always true while FEATURE_INVENTORY_PERMS is off. */
export function useInvCan() {
  const can = useCan();
  return (perm: string) => { const p = invPerm(perm); return !p || can(p); };
}

export function useInventorySettings() {
  const signedIn = useSignedIn();
  return useQuery({ queryKey: inventoryKeys.settings, queryFn: inventoryApi.settings, enabled: signedIn, retry: false });
}

/** The signed-in user (id + role codes) for the approver rule hint (the server decides: 403 approver_rule / self_approval). */
export function useMe() {
  const s = useSession().data;
  return { id: s?.user.id ?? '', roles: (s?.roles ?? []).map((r) => r.role as string) };
}
