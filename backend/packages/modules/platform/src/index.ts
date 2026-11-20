/** Public facade of the platform module. Other modules import only this file. */
export const MODULE = 'platform' as const;
export { PlatformModule } from './internal/platform.module';
export { ProblemFilter } from './internal/filter';
export { AuthInterceptor } from './internal/auth.interceptor';
export { SessionService, effectiveSetting, audit } from './internal/session.service';
export { DNS_RESOLVER, type TxtResolver } from './internal/branding.controller';
export { hashPassword, fail, parse, pgProblem, todayIST, ifMatch, etag, staleOr404 } from './internal/common';
export { markOnboardingStepCompleted } from './internal/onboarding.controller';
export { Auth, RequirePermission, Ctx, Problem, type AuthContext, type JwRequest } from './internal/common';
export { openBankAccountNo, IFSC } from './internal/bank-accounts.controller';
export { STORAGE, objectKey, LocalDiskDriver, S3Driver, storageFromEnv, type StorageService, type StorageArea, type ObjectMeta } from './internal/storage';
export { signFileToken, verifyFileToken, FILE_TOKEN_TTL_SECONDS } from './internal/file-token';
export { registerImportKind, registerFileAccess, writeTable, type ImportKindDef, type RowErr, type FileAccessFn, type FileInfo,
  registerStockImporter, type StockImporter, type StockImportRow } from './internal/registry';
export { readRows, applyMapping, MAX_BYTES, MAX_ROWS } from './internal/import.controller';
export { XLSX_TYPE, readAll, originalName } from './internal/storage';
export { DATA_KINDS } from './internal/schemas';
export { sha256, rateLimit } from './internal/common';
export { seal, open as openSecret, amountInWords, supportedLocales as wordsLocales } from '@jw/shared';
export { bucketKey, bucketHit, bucketLocked, bucketRetryAfter, RateLimited } from './internal/common';
export { needKey, requestHash, withIdempotency } from './internal/idempotency';
