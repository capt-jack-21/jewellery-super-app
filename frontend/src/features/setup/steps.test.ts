import { describe, expect, it } from 'vitest';
import type { Onboarding } from '@/lib/api/backend/model';
import { BILLING_GATE_IDS, BILLING_GATE_STEPS, billingGate, resumeStep, stepDone, WIZARD_STEPS } from './steps';

const GATE = ['shop_profile', 'gst', 'metals_purities', 'gst_rates', 'todays_rates'];
const ob = (done: string[], unlocked = GATE.every((c) => done.includes(c))): Onboarding => ({
  complete: false,
  billing_unlocked: unlocked,
  missing_billing_steps: GATE.filter((c) => !done.includes(c)),
  next_step: WIZARD_STEPS.find((s) => !done.includes(s.code))?.code ?? null,
  steps: WIZARD_STEPS.map((s, i) => ({ code: s.code, seq: i + 1, title: s.key, optional: !GATE.includes(s.code), required_for_billing: GATE.includes(s.code), status: done.includes(s.code) ? 'completed' : 'pending' })),
});

describe('setup wizard gate (server billing_unlocked)', () => {
  it('gate is exactly steps 1,2,4,5,6', () => {
    expect(BILLING_GATE_STEPS).toEqual([1, 2, 4, 5, 6]);
    expect(BILLING_GATE_IDS).toEqual(GATE);
  });
  it('uses billing_unlocked and maps missing steps to wizard numbers', () => {
    expect(billingGate(ob(GATE))).toMatchObject({ ready: true, missingWizard: [], serverMismatch: [] });
    expect(billingGate(ob(['shop_profile', 'gst', 'metals_purities']))).toMatchObject({ ready: false, missingWizard: [5, 6] });
    expect(billingGate(undefined).ready).toBe(false);
  });
  it('branches and print never block', () => {
    expect(billingGate(ob(GATE)).ready).toBe(true);
    expect(stepDone(WIZARD_STEPS[2], ob(GATE))).toBe(false);
  });
  it('flags server gate drift', () => {
    const o = ob(GATE);
    o.steps = o.steps.map((s) => (s.code === 'branches' ? { ...s, required_for_billing: true } : s));
    expect(billingGate(o).serverMismatch).toEqual(['branches']);
  });
  it('resumes at next_step', () => {
    expect(resumeStep(ob(['shop_profile']))).toBe(2);
    expect(resumeStep(ob(WIZARD_STEPS.map((s) => s.code)))).toBe(10);
  });
});
