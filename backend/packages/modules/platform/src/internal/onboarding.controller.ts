import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { currentTx } from '@jw/db';
import { RequirePermission, fail, parse } from './common';
import { OnboardingBody, onboardingStep } from './schemas';

export async function onboardingState() {
  const r = await currentTx().query<{ code: string; seq: number; title: string; optional: boolean; required_for_billing: boolean; status: string; completed_at: Date | null; details: unknown }>(
    `SELECT s.code, s.seq, s.title, s.optional, s.required_for_billing, coalesce(p.status, 'pending') AS status, p.completed_at, coalesce(p.details, '{}') AS details
       FROM platform.onboarding_step s LEFT JOIN platform.onboarding_progress p ON p.step = s.code ORDER BY s.seq`);
  const done = (s: { status: string; optional: boolean }) => s.status === 'completed' || (s.optional && s.status === 'skipped');
  const next = r.rows.find((s) => !done(s));
  // Billing gate is owned by the data model (platform.v_billing_unlocked); never re-derived here.
  const g = (await currentTx().query<{ billing_unlocked: boolean; missing_steps: string[] }>(
    `SELECT billing_unlocked, missing_steps FROM platform.v_billing_unlocked WHERE tenant_id = platform.current_tenant()`)).rows[0];
  return { complete: !next, billing_unlocked: g?.billing_unlocked ?? false, missing_billing_steps: g?.missing_steps ?? [],
    next_step: next?.code ?? null, steps: r.rows };
}

/** Mark a wizard step completed from another module's write (same tenant tx). Never downgrades an existing completion. */
export async function markOnboardingStepCompleted(step: string, details: Record<string, unknown> = {}): Promise<void> {
  await currentTx().query(
    `INSERT INTO platform.onboarding_progress(tenant_id, step, status, completed_at, details)
     VALUES (platform.current_tenant(), $1, 'completed', now(), $2::jsonb)
     ON CONFLICT (tenant_id, step) DO UPDATE SET status = 'completed',
       completed_at = coalesce(platform.onboarding_progress.completed_at, now()),
       details = platform.onboarding_progress.details || EXCLUDED.details, updated_at = now()`,
    [step, JSON.stringify(details)]);
}

@Controller('v1/onboarding')
export class OnboardingController {
  @Get()
  get() { return onboardingState(); }

  @Put('steps/:step') @RequirePermission('platform.settings.edit')
  async put(@Param('step') step: string, @Body() body: unknown) {
    if (!onboardingStep.safeParse(step).success) fail(404, 'unknown_step');
    const b = parse(OnboardingBody, body);
    const c = currentTx();
    const s = (await c.query<{ optional: boolean }>(`SELECT optional FROM platform.onboarding_step WHERE code = $1`, [step])).rows[0] ?? fail(404, 'unknown_step');
    if (b.status === 'skipped' && !s.optional) fail(422, 'step_not_optional');
    await c.query(
      `INSERT INTO platform.onboarding_progress(tenant_id, step, status, completed_at, details)
       VALUES (platform.current_tenant(), $1, $2, CASE WHEN $2 = 'completed' THEN now() END, $3::jsonb)
       ON CONFLICT (tenant_id, step) DO UPDATE SET status = EXCLUDED.status,
         completed_at = CASE WHEN EXCLUDED.status = 'completed' THEN coalesce(platform.onboarding_progress.completed_at, now()) END,
         details = platform.onboarding_progress.details || EXCLUDED.details, updated_at = now()`,
      [step, b.status, JSON.stringify(b.details ?? {})]);
    return onboardingState();
  }
}
