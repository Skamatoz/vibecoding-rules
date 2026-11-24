# API: Hono + Prisma. Собираем в одном этапе, в образ запуска берём только
# зависимости для работы, схему и собранный dist.

# ── Сборка ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Из России npm и сервер движков Prisma работают нестабильно — берём с зеркала.
# Сервер не в России — эту строку, зеркало в .npmrc и флаг --registry можно убрать.
ENV PRISMA_ENGINES_MIRROR="https://registry.npmmirror.com/-/binary/prisma"
# Движкам Prisma на Alpine нужен openssl
RUN apk add --no-cache openssl

WORKDIR /app
# npm -g не читает .npmrc, поэтому реестр — флагом. Версия pnpm — та же, что в packageManager.
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g pnpm@11.6.0 --registry=https://registry.npmmirror.com/ \
    && pnpm install --frozen-lockfile

COPY . .
RUN npx prisma generate && pnpm run build

# ── Запуск ───────────────────────────────────────────────────────────────────
FROM node:22-alpine

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV PRISMA_ENGINES_MIRROR="https://registry.npmmirror.com/-/binary/prisma"
RUN apk add --no-cache openssl

WORKDIR /app
# prisma (CLI) — в dependencies, а не в devDependencies: migrate deploy нужен при старте.
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g pnpm@11.6.0 --registry=https://registry.npmmirror.com/ \
    && pnpm install --frozen-lockfile --prod

COPY prisma ./prisma
RUN npx prisma generate
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
USER node

EXPOSE 4000
# Миграции применяются при каждом старте: новые накатятся, применённые пропустятся.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
