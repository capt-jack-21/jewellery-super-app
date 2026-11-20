import { describe, expect, it } from 'vitest';
import { relayJobOptions, CONSUMED_TOPICS, RELAY_RETRY_LIMIT, RETENTION_CONSUMED_H, RETENTION_UNCONSUMED_H } from './relay';
import { DEVICE_PENDING_TOPIC } from './dispatch';

describe('relayed job options (bounded retries / retention, lead decision 2)', () => {
  it('every relayed job has bounded retries with backoff and a bounded active time', () => {
    for (const t of ['auth.otp', 'platform.user_invited', DEVICE_PENDING_TOPIC]) {
      const o = relayJobOptions(t);
      expect(o.retryLimit).toBe(RELAY_RETRY_LIMIT);
      expect(o.retryLimit).toBeLessThanOrEqual(10);
      expect(o.retryBackoff).toBe(true);
      expect(o.expireInSeconds).toBeGreaterThan(0);
    }
  });
  it('topics with no consumer (auth.otp, platform.user_invited) get the short retention', () => {
    expect(CONSUMED_TOPICS.has('auth.otp')).toBe(false);
    expect(relayJobOptions('auth.otp').retentionHours).toBe(RETENTION_UNCONSUMED_H);
    expect(relayJobOptions('platform.user_invited').retentionHours).toBe(RETENTION_UNCONSUMED_H);
    expect(relayJobOptions(DEVICE_PENDING_TOPIC).retentionHours).toBe(RETENTION_CONSUMED_H);
    expect(RETENTION_UNCONSUMED_H).toBeLessThan(RETENTION_CONSUMED_H);
  });
});
