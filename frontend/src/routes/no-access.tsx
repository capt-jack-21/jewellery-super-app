import { Link, useSearch } from '@tanstack/react-router';
import { ShieldOff } from 'lucide-react';
import { useT } from '@/i18n';

/** Route guard target: the user lacks the page's permission. Renders no data, so no forbidden query fires. */
export function NoAccess() {
  const t = useT();
  const from = (useSearch({ strict: false }) as { from?: string }).from;
  return (
    <div role="alert" data-testid="no-access" className="mx-auto flex max-w-md flex-col items-center gap-3 p-8 text-center">
      <ShieldOff className="h-10 w-10 text-muted-foreground" aria-hidden />
      <h1 className="font-heading text-xl font-semibold">{t('noAccess.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('noAccess.body')}</p>
      {from ? <p className="font-mono text-xs text-muted-foreground">{from}</p> : null}
      <Link to="/" className="text-sm text-primary underline">{t('noAccess.home')}</Link>
    </div>
  );
}
