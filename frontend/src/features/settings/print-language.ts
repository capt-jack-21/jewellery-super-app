/** Release print policy only. UI language masters and immutable historical formatters are unaffected. */
export const RELEASE_PRINT_LANGUAGES = ['en', 'ta'] as const;
export const RELEASE_PRINT_LOCALES = ['en-IN', 'ta-IN'] as const;
export type ReleasePrintLocale = typeof RELEASE_PRINT_LOCALES[number];
export const isPrintLanguage = (v: unknown): v is typeof RELEASE_PRINT_LANGUAGES[number] => v === 'en' || v === 'ta';
export const isPrintLocale = (v: unknown): v is ReleasePrintLocale => v === 'en-IN' || v === 'ta-IN';
