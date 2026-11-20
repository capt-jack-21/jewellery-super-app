import { useEffect, useRef } from 'react';
import { logout as apiLogout } from '@/lib/api/backend/auth/auth';
import { adminLogout } from '@/lib/api/backend/admin/admin';
import { partnerLogout } from '@/lib/api/backend/partner/partner';
import { adminStore, type Surface } from '@/lib/session';

export async function logout(surface: Surface = 'tenant') {
  try {
    if (surface === 'platform') await adminLogout();
    else if (surface === 'partner') await partnerLogout();
    else await apiLogout();
  } catch { /* already gone */ }
  if (surface === 'platform') adminStore.set(null);
}

/** P11: auto-logout after `minutes` of no input. The server also expires idle sessions; this is the UX half. */
export function useIdleLogout(minutes: number, onLogout: () => void) {
  const cb = useRef(onLogout);
  cb.current = onLogout;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => void logout().then(() => cb.current()), minutes * 60_000); };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    events.forEach((e) => window.addEventListener(e, arm, { passive: true }));
    arm();
    return () => { clearTimeout(timer); events.forEach((e) => window.removeEventListener(e, arm)); };
  }, [minutes]);
}
