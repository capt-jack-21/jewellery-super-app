/** Domain error of the Sales service. The HTTP layer maps it 1:1 to problem+json (status, code, detail, errors[], extra members). */
export interface FieldError { path: string; code: string; message: string }
export class SalesError extends Error {
  constructor(readonly status: number, readonly code: string, detail?: string, readonly errors?: FieldError[],
    readonly extra?: Record<string, unknown>) {
    super(detail ?? code);
    this.name = 'SalesError';
  }
}
export function fail(status: number, code: string, detail?: string, errors?: FieldError[], extra?: Record<string, unknown>): never {
  throw new SalesError(status, code, detail, errors, extra);
}
/** 422 validation_failed with one field error. */
export const invalid = (path: string, message: string, code = 'invalid'): never =>
  fail(422, 'validation_failed', message, [{ path, code, message }]);
/** If-Match check (412 version_mismatch). */
export function checkVersion(what: string, current: number, ifVersion: number | undefined): void {
  if (ifVersion !== undefined && ifVersion !== current) fail(412, 'version_mismatch', `${what} was changed by someone else (now version ${current})`);
}
