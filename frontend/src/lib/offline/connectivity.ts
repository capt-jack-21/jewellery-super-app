import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from 'react';
import { getMeta } from '@/lib/api/backend/auth/auth';
import { clientTooOld } from '@/lib/version';

let minClient: string | null = null;
const listeners = new Set<() => void>();
/** Latest /v1/meta min_client_version seen by the heartbeat. */
export const getMinClientVersion = () => minClient;
export function subscribeMinClient(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
function noteMeta(data: unknown) {
  const m = (data as { min_client_version?: string } | null)?.min_client_version ?? null;
  if (m !== minClient) { minClient = m; listeners.forEach((f) => f()); }
}
/** True when the server says this build is too old (blocking update screen). */
export function useUpdateRequired(): boolean {
  const [, force] = useState(0);
  useEffect(() => subscribeMinClient(() => force((n) => n + 1)), []);
  return clientTooOld(minClient);
}

/** Heartbeat-based online detection (navigator.onLine alone is unreliable on shop LANs). */
export function useHeartbeat(intervalMs = 15000): boolean {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    let alive = true;
    const ping = async () => {
      try { const r = await getMeta(); noteMeta((r as { data?: unknown }).data); if (alive) setOnline(true); } catch { if (alive) setOnline(false); }
    };
    void ping();
    const t = setInterval(ping, intervalMs);
    const off = () => setOnline(false);
    const on = () => void ping();
    window.addEventListener('offline', off);
    window.addEventListener('online', on);
    return () => { alive = false; clearInterval(t); window.removeEventListener('offline', off); window.removeEventListener('online', on); };
  }, [intervalMs]);
  return online;
}

const Ctx = createContext(true);
export function ConnectivityProvider({ children }: { children: ReactNode }) {
  return createElement(Ctx.Provider, { value: useHeartbeat() }, children);
}
/**
 * Online-only rule: billing AND estimates (and every other write) require the server.
 * When this returns false, screens show <OfflineBanner/> and disable write actions. Nothing is queued.
 */
export const useOnline = () => useContext(Ctx);
