# Админка: Nuxt SPA (ssr: false). Nuxt-сервер отдаёт оболочку приложения и
# подставляет runtimeConfig при старте, поэтому адрес API берётся из env Dokploy.

# ── Сборка ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NUXT_TELEMETRY_DISABLED=1

WORKDIR /app
# npm -g не читает .npmrc, поэтому реестр — флагом. Версия pnpm — та же, что в packageManager.
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g pnpm@11.6.0 --registry=https://registry.npmmirror.com/ \
    && pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

# ── Запуск: только собранный .output ─────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001

COPY --from=build --chown=node:node /app/.output ./.output

USER node

EXPOSE 3001
CMD ["node", ".output/server/index.mjs"]
