import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getGetLanguageSettingsQueryKey, getLanguageSettings } from '@/lib/api/backend/settings/settings';
import { ok, setApiContext } from '@/lib/api/fetcher';
import { useSession } from '@/lib/session';
import { fromApiLang, useLocale } from './index';

/** Feeds the shop default (GET /v1/settings/language) and the user's override (session.user.language) into the I18nProvider. */
export function LanguageSync({ tenant = true }: { tenant?: boolean }) {
  const s = useSession(tenant).data;
  const { locale, setSources } = useLocale();
  const lang = useQuery({ queryKey: getGetLanguageSettingsQueryKey(), queryFn: () => ok(getLanguageSettings()), enabled: tenant && !!s });
  const tenantDefault = fromApiLang(lang.data?.shop_default);
  const override = fromApiLang(s?.user.language);
  useEffect(() => { setSources({ tenantDefault, userOverride: override }); }, [tenantDefault, override, setSources]);
  useEffect(() => { setApiContext({ locale }); }, [locale]);
  return null;
}
