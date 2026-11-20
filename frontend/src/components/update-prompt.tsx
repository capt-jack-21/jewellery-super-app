import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';

/** PWA update prompt (registerType: 'prompt'): never auto-reloads mid-bill. Disabled while API mocks run (MSW owns the SW scope). */
export function UpdatePrompt() {
  const t = useT();
  const [update, setUpdate] = useState<null | ((reload?: boolean) => Promise<void>)>(null);
  useEffect(() => {
    if (import.meta.env.VITE_API_MOCKS === 'true' || !import.meta.env.PROD) return;
    void import('virtual:pwa-register').then(({ registerSW }) => {
      const fn = registerSW({ onNeedRefresh: () => setUpdate(() => fn) });
    });
  }, []);
  if (!update) return null;
  return (
    <div role="status" className="fixed bottom-4 right-4 flex items-center gap-3 rounded-lg border border-border bg-card p-3 shadow-sm">
      <span className="text-sm">{t('app.updateAvailable')}</span>
      <Button size="sm" onClick={() => void update(true)}>{t('app.reload')}</Button>
    </div>
  );
}
