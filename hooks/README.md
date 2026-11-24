# Хук guard-db: ассистент не сотрёт базу

Правило в тексте ассистент иногда нарушает, а хук — нет. Claude Code запускает `guard-db.mjs` перед каждой командой и правкой файла. Опасное он блокирует и объясняет ассистенту, как сделать правильно.

Хук нужен потому, что однажды ассистент запустил `prisma migrate diff` с флагом `--shadow-database-url`, указывающим на боевую базу. Для Prisma shadow-база значит «эту можно затирать», и она стёрла все таблицы прода. Поэтому у Prisma здесь белый список: разрешено только то, что перечислено.

## Что блокирует

| Где | Что нельзя | Что можно |
|---|---|---|
| Prisma | `db push`, `migrate reset`, `migrate diff`, `migrate deploy`, `migrate resolve`, флаги `--shadow-database-url`, `--accept-data-loss`, `--force-reset`, `--create-only` | `migrate dev --name …`, `migrate status`, `generate`, `validate`, `format`, `studio`, `init` |
| Куда идёт миграция | `migrate dev` и `db seed` в базу не на этом компьютере, адрес базы прямо в команде, `dotenv -e`, `--env-file` | локальная база (`localhost`, `127.0.0.1`, `db`, `postgres` в Docker) |
| Ручной SQL | `psql -c` и `-f`, SQL через пайп в `psql`, `$executeRaw`, `$queryRawUnsafe`, `DROP` и `TRUNCATE`, `DELETE FROM`, `pg_restore`, `dropdb` | `$queryRaw` для `SELECT 1` в healthcheck |
| Файлы миграций | правка и создание файлов в `prisma/migrations/` | чтение |
| Обход | то же самое внутри файла-скрипта (`bash x.sh`, `node x.mjs`) | — |
| MCP к базе | всё, кроме чтения: `INSERT`, `UPDATE`, `DELETE`, `ALTER`, `SELECT … INTO`, пишущий `WITH`, второй запрос после `;` | `SELECT`, `WITH … SELECT`, `EXPLAIN`, `SHOW` |

Обходного слова нет специально: его ассистент дописал бы сам.

## Как поставить

Нужны Claude Code и Node 18 или новее.

1. Скопируй `guard-db.mjs` в проект: `.claude/hooks/guard-db.mjs`.
2. Добавь содержимое `settings.json` в `.claude/settings.json` проекта. Если файл уже есть, допиши блок `PreToolUse` к существующим `hooks`.
3. Закоммить оба файла. Тогда хук работает у всех, кто открывает проект.
4. Перезапусти Claude Code и проверь. Попроси ассистента выполнить `npx prisma db push`: должна прийти «БЛОКИРОВКА ХУКОМ guard-db».

Чтобы хук работал во всех проектах сразу, положи скрипт в `~/.claude/hooks/`, а в `~/.claude/settings.json` укажи путь `node "$HOME/.claude/hooks/guard-db.mjs"`.

## Настройка

- **Своя локальная база с другим именем хоста.** Допиши его в `LOCAL_DB_HOSTS` в начале скрипта. Адрес боевой базы туда не добавляй никогда.
- **MCP к базе.** Хук проверяет MCP-серверы, в имени которых есть `postgres`, `sql`, `db`, `supabase` или `neon`. Сам MCP тоже держи только на чтение: `postgres-mcp --access-mode restricted` или отдельный пользователь базы с правом SELECT. Хук и права базы — две защиты, и одна страхует другую.
- **Ложная блокировка.** Например, ты ищешь в коде текст `DELETE FROM` через Bash. Пусть ассистент ищет поиском по файлам, а не командой. Если хук мешает законной работе, поправь правило в скрипте, а не отключай хук целиком.

Хук — не замена бэкапу. Ежедневный бэкап базы вне сервера с проверенным восстановлением — `docs/server.md`, шаг 6.
