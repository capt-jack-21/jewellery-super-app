import type { Onboarding, OnboardingStepsItem } from '@/lib/api/backend/model';

/**
 * Approved 10-step wizard (plan §9.1) keyed by the server's onboarding step codes (GET /v1/onboarding).
 * The server owns progress (PUT /v1/onboarding/steps/{code}) and the billing gate (`billing_unlocked`).
 * Gate = exactly shop_profile, gst, metals_purities, gst_rates, todays_rates (steps 1, 2, 4, 5, 6).
 */
export const WIZARD_STEPS = [
  { n: 1, key: 'profile', code: 'shop_profile', gate: true },
  { n: 2, key: 'gst', code: 'gst', gate: true },
  { n: 3, key: 'branches', code: 'branches', gate: false },
  { n: 4, key: 'metals', code: 'metals_purities', gate: true },
  { n: 5, key: 'gstRates', code: 'gst_rates', gate: true },
  { n: 6, key: 'rates', code: 'todays_rates', gate: true },
  { n: 7, key: 'users', code: 'users_roles', gate: false },
  { n: 8, key: 'branding', code: 'branding', gate: false },
  { n: 9, key: 'print', code: 'printers_language', gate: false },
  { n: 10, key: 'import', code: 'import', gate: false },
] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number];
export const BILLING_GATE_IDS = WIZARD_STEPS.filter((s) => s.gate).map((s) => s.code);
export const BILLING_GATE_STEPS = WIZARD_STEPS.filter((s) => s.gate).map((s) => s.n);

export const serverStep = (step: WizardStep, ob: Onboarding | undefined): OnboardingStepsItem | undefined => ob?.steps.find((s) => s.code === step.code);
export const stepDone = (step: WizardStep, ob: Onboarding | undefined): boolean => {
  const st = serverStep(step, ob)?.status;
  return st === 'completed' || st === 'skipped';
};
/** Only optional steps may be skipped (server rule); unknown → not skippable. */
export const skippable = (step: WizardStep, ob: Onboarding | undefined): boolean => !!serverStep(step, ob)?.optional;

/** Gate comes from the API. Client-side we only map missing codes to wizard numbers and flag contract drift. */
export function billingGate(ob: Onboarding | undefined) {
  const missing = ob?.missing_billing_steps ?? [];
  const missingWizard = WIZARD_STEPS.filter((s) => missing.includes(s.code)).map((s) => s.n);
  const serverGate = (ob?.steps ?? []).filter((s) => s.required_for_billing).map((s) => s.code);
  const serverMismatch = ob ? [...serverGate.filter((c) => !BILLING_GATE_IDS.includes(c as never)), ...BILLING_GATE_IDS.filter((c) => !serverGate.includes(c))] : [];
  return { ready: !!ob?.billing_unlocked, missingWizard, serverMismatch };
}

/** Resume at the server's next_step, else the first not-done step. */
export function resumeStep(ob: Onboarding | undefined): number {
  const byServer = WIZARD_STEPS.find((s) => s.code === ob?.next_step);
  return byServer?.n ?? WIZARD_STEPS.find((s) => !stepDone(s, ob))?.n ?? WIZARD_STEPS.length;
}
