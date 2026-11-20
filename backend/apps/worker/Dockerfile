# Build context: /workspace  (docker build -f backend/apps/worker/Dockerfile /workspace)
FROM node:20-slim AS build
WORKDIR /repo
RUN npm i -g pnpm@9
COPY backend .
RUN pnpm install --frozen-lockfile && pnpm turbo run build --filter=@jw/worker... && pnpm deploy --filter=@jw/worker --prod /out
FROM node:20-slim
WORKDIR /app
COPY --from=build /out .
CMD ["node", "dist/index.js"]
