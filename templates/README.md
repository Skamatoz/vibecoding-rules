# Заготовки проекта

Пример проекта: сайт мебельной фабрики (SSR) и CRM её отдела продаж (SPA) на одном API. Скопируй в корень своего проекта то, что нужно, и перепиши под себя.

```
CLAUDE.md               описание проекта для ассистента: масштаб, сервисы, правила
docker-compose.yml      локальная база Postgres для разработки
api/                    API: Hono + Prisma
  Dockerfile            сборка в два этапа, USER node, миграции при старте
  .dockerignore         .env и node_modules не попадают в образ
  .env.example          переменные с пояснениями
  .npmrc                зеркало npm для России
  pnpm-workspace.yaml   разрешение install-скриптов Prisma
  scripts/check-architecture.mjs   сторож слоёв и размеров файлов
admin/                  CRM или админка: Nuxt SPA, всё за логином
site/                   публичный сайт: Nuxt SSR, основной домен
```

В `admin/` и `site/` — те же Dockerfile, `.dockerignore`, `.env.example`, `.npmrc`, `pnpm-workspace.yaml` и сторож для фронта. Сайт не нужен — не копируй `site/`. Нужен кабинет клиента — скопируй `admin/` как `app/`.

## Что дописать в package.json каждого сервиса

```json
"scripts": {
  "check:arch": "node scripts/check-architecture.mjs",
  "check": "pnpm build && pnpm check:arch"
}
```

`pnpm check` — проверка перед коммитом: сборка проходит, слои не нарушены, файлов длиннее 600 строк нет.

В `api/` пакет `prisma` держи в `dependencies`, а не в `devDependencies`: образ запуска ставит только рабочие зависимости, а `prisma migrate deploy` нужен при старте.

## Что проверяет сторож

| Где | Ошибка — коммит не проходит | Предупреждение |
|---|---|---|
| API | роут импортирует prisma; `lib/` импортирует `services/`, `routes/` или `workers/`; сервис или воркер импортирует роут; файл длиннее 600 строк | файл длиннее 300 строк, цикл импорта |
| Фронт | `$fetch` или `useFetch` в странице или компоненте; запрос или composable в `utils/`; файл длиннее 600 строк | страница длиннее 200 строк, остальное — длиннее 300 |

Подробно — `AGENTS.md`, раздел 4 «Устройство кода».
