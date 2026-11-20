import { defineConfig } from 'orval';

/**
 * Inputs:
 *  - backend: copy of /workspace/backend/contracts/openapi.yaml, the single source of truth (refresh with `npm run api:sync`).
 * Paths are /v1/...; the fetcher prefixes the /api server URL.
 */
// Retain orphan generated files: the VPS workflow forbids deletions. Consumers use the new named schemas.
const out = (name: string, inputFile: string) => {
  const input = { target: inputFile };
  return {
  [name]: {
    input,
    output: {
      mode: 'tags-split' as const,
      target: `src/lib/api/${name}/endpoints.ts`,
      schemas: `src/lib/api/${name}/model`,
      client: 'react-query' as const,
      httpClient: 'fetch' as const,
      headers: true, // type header params (If-Match / IfMatchOptional) as a function argument
      clean: false,
      override: { mutator: { path: 'src/lib/api/fetcher.ts', name: 'apiFetch' } },
    },
  },
  [`${name}Zod`]: {
    input,
    output: { mode: 'tags-split' as const, target: `src/lib/api/${name}/zod/schemas.ts`, client: 'zod' as const, clean: false },
  },
  };
};

export default defineConfig({
  ...out('backend', './contracts/backend.openapi.yaml'),
});
