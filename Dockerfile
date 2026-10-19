# syntax=docker/dockerfile:1
#
# Образ автономной лаборатории.
#
# Три стадии: зависимости → сборка → рантайм. В рантайм попадает только
# standalone-вывод Next.js (см. output: "standalone" в next.config.ts), поэтому
# образ не тащит devDependencies и исходники.
#
# Сборка требует доступа в интернет только для next/font (Google Fonts) и npm.
# Запуск требует DATABASE_URL — его задаёт docker-compose.yml или оркестратор.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Автопилот на стадии сборки не нужен: build не должен запускать циклы.
ENV AUTOPILOT=0
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Миграции схемы нужны в образе, чтобы применить их к боевой базе:
#   docker compose run --rm app npx drizzle-kit push
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=nextjs:nodejs /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/drizzle-kit ./node_modules/drizzle-kit

USER nextjs
EXPOSE 3000

# Простейшая проверка живости: /api/health выполняет `select 1` к базе и
# отдаёт 500, если соединения нет.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
