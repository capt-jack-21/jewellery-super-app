import { useT } from '@/i18n';
export function NotFound() { const t = useT(); return <p className="p-8 text-center text-muted-foreground">{t('notFound')}</p>; }
