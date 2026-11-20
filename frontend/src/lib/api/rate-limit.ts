import { useEffect, useState } from 'react';
import { ApiError } from './fetcher';

/** Seconds left before a rate-limited (429) action may be retried; 0 when not limited. Ticks every second. */
export function useRetryCountdown(error: unknown): number {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (error instanceof ApiError && error.isRateLimited) setUntil(Date.now() + (error.retryAfter ?? 30) * 1000);
  }, [error]);
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  useEffect(() => {
    if (until <= Date.now()) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [until]);
  return left;
}
