import { useQuery } from '@tanstack/react-query';
import { getListLanguagesQueryKey, listLanguages } from '@/lib/api/backend/auth/auth';
import type { Language } from '@/lib/api/backend/model';
import { ApiError, ok } from '@/lib/api/fetcher';

/** Supported languages come from the server (GET /v1/meta/languages, public). Not hard-coded. */
export function useLanguages() {
  return useQuery({ queryKey: getListLanguagesQueryKey(), queryFn: () => ok(listLanguages()), staleTime: 60 * 60_000 });
}

export const languageLabel = (l: Pick<Language, 'name' | 'native_name'>): string =>
  l.native_name && l.native_name !== l.name ? `${l.native_name} (${l.name})` : l.name;

/** 422 unknown_language: the code is not in platform.language (list changed under us). */
export const isUnknownLanguage = (e: unknown): boolean => e instanceof ApiError && e.status === 422 && e.code === 'unknown_language';
