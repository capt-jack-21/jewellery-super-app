# Build context: /workspace (parent of backend/ and jewellery-data-model/):
#   docker build -f backend/apps/api/Dockerfile -t jw-api /workspace
FROM node:20-slim AS build
WORKDIR /src
RUN npm i -g pnpm@9.15.9
COPY jewellery-data-model/migrations ./jewellery-data-model/migrations
COPY backend ./backend
WORKDIR /src/backend
RUN pnpm install --frozen-lockfile && pnpm turbo run build --filter=@jw/api... \
 && pnpm deploy --filter=@jw/api --prod /out && cp -r apps/api/dist /out/
FROM node:20-slim
WORKDIR /app
COPY --from=build /out .
# every migrations/*.sql, including 000_bootstrap.sql (DevOps runs that one as superuser), is at /app/migrations (MIGRATIONS_DIR overrides)
COPY jewellery-data-model/migrations/ /app/migrations/
RUN ls /app/migrations/000_bootstrap.sql dist/migrate.js
ENV NODE_ENV=production MIGRATIONS_DIR=/app/migrations
EXPOSE 3000
CMD ["node", "dist/main.js"]
