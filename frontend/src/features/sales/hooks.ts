import { useEffect, useState } from 'react';

/** Value that settles `ms` after the last change (preview debounce; the server stays authoritative). */
export function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => { const h = setTimeout(() => setV(value), ms); return () => clearTimeout(h); }, [value, ms]);
  return v;
}

const SP_KEY = 'sales.salesperson';
/** The salesperson last used on this device (counter staff rarely change); only an id, never personal data. */
export const rememberedSalesperson = {
  get: (): string => { try { return localStorage.getItem(SP_KEY) ?? ''; } catch { return ''; } },
  set: (id: string) => { try { if (id) localStorage.setItem(SP_KEY, id); } catch { /* storage off: fine */ } },
};

/** Counter shortcuts (scanner + keyboard first). Returns the key name for a KeyboardEvent, or null. */
export type BillShortcut = 'pay' | 'oldGold' | 'customer' | 'discount' | 'issue' | 'estimate' | 'scan';
export function shortcutFor(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): BillShortcut | null {
  const mod = e.ctrlKey || e.metaKey;
  if (e.altKey) return null;
  if (!mod) return ({ F1: 'pay', F2: 'oldGold', F3: 'customer', F4: 'discount', F6: 'scan' } as Record<string, BillShortcut>)[e.key] ?? null;
  const k = e.key.toLowerCase();
  return k === 's' ? 'issue' : k === 'e' ? 'estimate' : null;
}
