# API: Hono + Prisma. Два этапа: первый собирает код, во второй — образ запуска —
# попадают только рабочие зависимости, схема и собранный dist.
# Prisma вызывается из node_modules/.bin, а не через npx: npx при отсутствии
# пакета молча скачал бы последнюю версию из интернета.

# ── Сборка ───────────────────────────────────────────────────────────────────
FROM node:24-alpine AS build

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
RUN node_modules/.bin/prisma generate && pnpm run build

# ── Запуск ───────────────────────────────────────────────────────────────────
FROM node:24-alpine

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV PRISMA_ENGINES_MIRROR="https://registry.npmmirror.com/-/binary/prisma"
RUN apk add --no-cache openssl

WORKDIR /app
# prisma (CLI) — в dependencies, а не в devDependencies: migrate deploy нужен при старте.
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g pnpm@11.6.0 --registry=https://registry.npmmirror.com/ \
    && pnpm install --frozen-lockfile --prod

# Без prisma в dependencies миграции при старте не запустятся — падаем здесь, при сборке, а не на проде.
RUN test -x node_modules/.bin/prisma \
    || (echo "prisma должна быть в dependencies, а не в devDependencies" && exit 1)

COPY prisma ./prisma
RUN node_modules/.bin/prisma generate
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
USER node

EXPOSE 4000

# Swarm считает новую версию поднявшейся только после здорового /health (он ходит в базу).
# start-period — запас на миграции при старте.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Миграции применяются при каждом старте: новые накатятся, применённые пропустятся.
# exec: node заменяет оболочку и сам получает SIGTERM. Без exec сигнал достаётся sh,
# node его не видит, плавная остановка не срабатывает, и через 10 секунд процесс убивают.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node dist/index.js"]
