# Auth & sessions (implemented, Platform module)

- Login: `POST /api/v1/auth/login` {tenant slug | shop custom domain Host, login = username or phone, password, device_key?}.
  200 → `sid` cookie (httpOnly, Secure unless COOKIE_INSECURE=1, SameSite=Lax) = `<tenant_id>.<256-bit token>`; only sha256(token) is stored
  in `platform.user_session.token_hash`. 202 → OTP challenge when `auth.otp_login_enabled` and the user has a phone.
- OTP: `otp/request` (OTP-only login; decoy challenge for unknown users), `otp/verify` (max 5 attempts, 10 min, single use). The code is
  delivered by writing `notifications.outbox` topic `auth.otp` in the same tx — the api never touches pg-boss.
- Lockout: 5 wrong passwords → `locked_until = now()+15 min`. Rate limits are in-process (per instance).
- Every request: AuthInterceptor opens the per-request tenant tx (withTenantTx, SET LOCAL app.tenant_id/user_id/branch_id), resolves the
  session inside it, applies idle timeout (`auth.session_timeout_minutes`, branch override honoured; revoke_reason idle_timeout), 12 h
  absolute expiry, suspended tenant → 403, read_only tenant → writes 403, then the @RequirePermission check (fixed roles only).
- Devices: `POST /devices` registers (pending), managers approve/revoke; revoke kills live sessions (DB trigger) = remote logout.
- Admin console (v1.4): opaque `admin_sid` token, sha256 in platform.platform_admin_session (revoked on logout), app_admin pool.
- Partner console (v1.4): `POST /v1/partner/auth/login` → cookie `psid="<partner_id>.<token>"`, sha256 in platform.partner_session (12 h absolute, 30 min idle); the partner tx sets only app.partner_id.
- No JWT anywhere. Env: SESSION_SECRET (required in production), ADMIN_DATABASE_URL, FILE_STORE_DIR, COOKIE_INSECURE (tests only).
