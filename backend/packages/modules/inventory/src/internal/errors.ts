/** Domain error of the Inventory service. The HTTP layer maps it 1:1 to problem+json (status, code, detail, errors[]). */
export interface FieldError { path: string; code: string; message: string }
export class InventoryError extends Error {
  constructor(readonly status: number, readonly code: string, detail?: string, readonly errors?: FieldError[]) {
    super(detail ?? code);
    this.name = 'InventoryError';
  }
}
export function fail(status: number, code: string, detail?: string, errors?: FieldError[]): never {
  throw new InventoryError(status, code, detail, errors);
}
/** If-Match check: ifVersion undefined = internal caller (no precondition); a different version → 412 version_mismatch. */
export function checkVersion(what: string, current: number, ifVersion: number | undefined): void {
  if (ifVersion !== undefined && ifVersion !== current) fail(412, 'version_mismatch', `${what} was changed by someone else (now version ${current})`);
}
/** 422 validation_failed with one field error. */
export const invalid = (path: string, message: string, code = 'invalid'): never =>
  fail(422, 'validation_failed', message, [{ path, code, message }]);
