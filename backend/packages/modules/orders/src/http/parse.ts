import { Problem } from '@jw/mod-platform';
import type { ZodTypeAny, output } from 'zod';

/**
 * zod parse → 422 validation_failed with field-level codes (0.8.3): an unknown body field → code field_not_supported (one entry
 * per field, path = the field); anything else → code invalid. Schemas are .strict(), so nothing is silently dropped.
 */
export function parse<S extends ZodTypeAny>(schema: S, body: unknown): output<S> {
  const r = schema.safeParse(body ?? {});
  if (r.success) return r.data;
  const errors: { path: string; code: string; message: string }[] = r.error.issues.flatMap((i) => i.code === 'unrecognized_keys'
    ? i.keys.map((k) => ({ path: [...i.path, k].join('.'), code: 'field_not_supported', message: 'field_not_supported' }))
    : [{ path: i.path.join('.') || '(body)', code: 'invalid', message: i.message }]);
  throw new Problem(422, 'validation_failed', 'Request body is invalid', errors);
}
