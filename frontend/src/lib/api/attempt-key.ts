import { useState } from 'react';
import { ApiError } from '@/lib/api/fetcher';
import { uuid } from '@/lib/uuid';

/**
 * One Idempotency-Key per attempt. The key survives a retry of the same body (network error / 5xx),
 * and is dropped on success, on any 4xx, or as soon as the form changes (a different body would be 422 idempotency_key_reused).
 */
export function useAttemptKey() {
  const [key, setKey] = useState<string | null>(null);
  return {
    take: () => { if (key) return key; const k = uuid().replace(/[^A-Za-z0-9_-]/g, ''); setKey(k); return k; },
    settle: (e: unknown) => { if (!(e instanceof ApiError) || (e.status >= 400 && e.status < 500)) setKey(null); },
    reset: () => setKey(null),
  };
}
