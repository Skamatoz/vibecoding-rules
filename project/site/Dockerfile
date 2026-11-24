# Публичный сайт: Nuxt SSR — страницы рендерит сервер, поисковики и превью
# ссылок видят готовый текст. runtimeConfig читается при старте из env Dokploy.

# ── Сборка ───────────────────────────────────────────────────────────────────
FROM node:24-alpine AS build

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
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

COPY --from=build --chown=node:node /app/.output ./.output

USER node

EXPOSE 3000

# Swarm считает новую версию поднявшейся только после ответа главной страницы.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", ".output/server/index.mjs"]
