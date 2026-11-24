#!/usr/bin/env node
// guard-db.mjs — хук Claude Code (PreToolUse), который не даёт ассистенту
// стереть или испортить базу. Подключение — hooks/README.md.
//
// Почему белый список, а не чёрный. Ассистент однажды запустил
//   prisma migrate diff --shadow-database-url "<боевая база>" --script
// Для Prisma shadow-база значит «эту можно затирать»: она стёрла все таблицы
// прода. Чёрный список эту команду пропустил. Поэтому здесь у Prisma
// разрешено только перечисленное, всё остальное запрещено.
//
// Что блокирует:
//   Bash:
//     - Prisma, кроме migrate dev --name, generate, validate, format, version,
//       studio, init, migrate status;
//     - флаги --shadow-database-url, --accept-data-loss, --force-reset, --create-only;
//     - подмену базы прямо в команде (DATABASE_URL=..., dotenv -e, --env-file);
//     - migrate dev в нелокальную базу (список LOCAL_DB_HOSTS ниже);
//     - ручной SQL: psql -c/-f, $executeRaw, DROP/TRUNCATE, DELETE FROM,
//       pg_restore, dropdb;
//     - запись в prisma/migrations/;
//     - то же самое, спрятанное в файл-скрипт (bash x.sh, node x.mjs).
//   Write и Edit: правку файлов в prisma/migrations/.
//   MCP к базе: всё, кроме чтения (SELECT, WITH … SELECT, EXPLAIN, SHOW).
//
// Блокировка — exit 2 и текст в stderr: Claude Code показывает его ассистенту.
// Обходного слова нет намеренно: его ассистент дописал бы сам.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Куда можно делать `prisma migrate dev`. Только локальная база разработки:
// Postgres в Docker на своём компьютере. Боевую базу меняет деплой
// (`prisma migrate deploy` при старте контейнера), а не ассистент.
const LOCAL_DB_HOSTS = new Set([
  'localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal', 'db', 'postgres',
])

// ── вход ─────────────────────────────────────────────────────────────────────

let raw = ''
try { raw = fs.readFileSync(0, 'utf8') } catch {}

let input
try {
  input = JSON.parse(raw)
} catch {
  // Не разобрали вход — перекрываем по грубым признакам: лучше лишний запрет.
  if (/prisma\/migrations\/|shadow-database-url|db\s+push|migrate\s+(diff|reset)/.test(raw)) {
    deny('не удалось разобрать вход хука, а в нём опасная команда.')
  }
  process.exit(0)
}

const tool = String(input.tool_name || '')
const ti = input.tool_input || {}
const cwd = input.cwd || process.cwd()

// ── вывод ────────────────────────────────────────────────────────────────────

function deny(reason, hint) {
  const lines = [
    `БЛОКИРОВКА ХУКОМ guard-db: ${reason}`,
    '',
  ]
  if (hint) lines.push(hint, '')
  lines.push(
    'Схему меняют только так:',
    '  1) правишь prisma/schema.prisma',
    '  2) npx prisma migrate dev --name <что_меняем>   (в локальную базу)',
    'На прод миграции накатывает деплой. Ручного SQL нет.',
    'Не обходи хук другим флагом, скриптом или подменой env. Скажи владельцу, что хотел сделать и зачем.',
  )
  process.stderr.write(lines.join('\n') + '\n')
  process.exit(2)
}

// ── MCP к базе: только чтение ────────────────────────────────────────────────

if (tool.startsWith('mcp__')) {
  // Только MCP к базе: у поисковых MCP тоже бывает поле query.
  if (!/postgres|pg|sql|database|supabase|neon|db/i.test(tool)) process.exit(0)
  const v = ti.sql ?? ti.query ?? ti.statement ?? ''
  const sql = typeof v === 'string' ? v : JSON.stringify(v)
  if (!sql.trim()) process.exit(0) // list_schemas и подобное без SQL

  const upper = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .toUpperCase()

  const WRITES = /\b(INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|MERGE\s+INTO|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|COPY|VACUUM|REINDEX|CLUSTER|LOCK|CALL|DO|REFRESH)\b/
  const SIDE_EFFECTS = /\b(PG_TERMINATE_BACKEND|PG_CANCEL_BACKEND|PG_RELOAD_CONF|SET_CONFIG|DBLINK\w*|LO_UNLINK|LO_IMPORT|LO_EXPORT|PG_ADVISORY_\w+|NEXTVAL|SETVAL)\s*\(/
  const READ_START = /^\(*\s*(SELECT|WITH|EXPLAIN|SHOW|TABLE|VALUES)\b/

  for (const stmt of upper.split(';').map((s) => s.trim()).filter(Boolean)) {
    if (!READ_START.test(stmt)) deny(`через MCP разрешено только чтение, а запрос начинается с «${stmt.split(' ')[0]}».`)
    if (WRITES.test(stmt)) deny('в запросе через MCP есть запись или изменение схемы.')
    if (SIDE_EFFECTS.test(stmt)) deny('в запросе через MCP есть функция с побочным действием.')
    if (/^\(*\s*SELECT\b/.test(stmt) && /\bINTO\b/.test(stmt)) deny('SELECT … INTO создаёт таблицу.')
  }
  process.exit(0)
}

// ── Write и Edit ─────────────────────────────────────────────────────────────

if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
  const fp = String(ti.file_path || ti.notebook_path || '').replace(/\\/g, '/')
  if (fp.includes('prisma/migrations/')) {
    deny('файлы в prisma/migrations/ руками не создаются и не правятся.')
  }
  process.exit(0)
}

if (tool !== 'Bash') process.exit(0)

// ── Bash ─────────────────────────────────────────────────────────────────────

const cmd = String(ti.command || '')

// Правила, которые проверяются и в самой команде, и внутри запускаемых файлов.
// sqlOnly: true — правило про любую базу Postgres, а не только про Prisma.
const BAD = [
  { rx: /--shadow-database-url/, label: 'флаг --shadow-database-url' },
  { rx: /--accept-data-loss/, label: 'флаг --accept-data-loss' },
  { rx: /--force-reset/, label: 'флаг --force-reset' },
  { rx: /(^|[^\w-])db\s+(push|execute|pull)([^\w-]|$)/, label: 'prisma db push/execute/pull' },
  { rx: /(^|[^\w-])migrate\s+(diff|deploy|reset|resolve)([^\w-]|$)/, label: 'prisma migrate diff/deploy/reset/resolve' },
  // $queryRaw`SELECT 1` (тегированный шаблон) — законный healthcheck, его не трогаем.
  { rx: /\$executeRaw(Unsafe)?|\$queryRawUnsafe/, label: 'сырой SQL через Prisma', sqlOnly: true },
  { rx: /\b(drop|truncate)\s+(table|schema|database|type|index|view)\b/i, label: 'DROP/TRUNCATE', sqlOnly: true },
  { rx: /\bdelete\s+from\s/i, label: 'DELETE FROM', sqlOnly: true },
  { rx: /(^|[^\w-])(psql|pg_restore|pg_dumpall|dropdb)([^\w-]|$)/, label: 'psql / pg_restore / dropdb', sqlOnly: true },
]

// 1. Разрушающий SQL — в любом проекте, есть там Prisma или нет.
if (/(^|[^\w-])psql(\s|$)/.test(cmd)) {
  if (/(\s|^)(-c|-f|--command|--file)(\s|=)|<<|<\s*\S+|\|\s*(\S*\/)?psql\b/.test(cmd)) {
    deny('ручной SQL через psql запрещён.', 'Посмотреть данные — через MCP только на чтение.')
  }
}
for (const b of BAD.filter((b) => b.sqlOnly)) {
  if (b.rx.test(cmd)) {
    deny(`запрещённая операция: ${b.label}.`, 'Ищешь такой текст в коде — используй поиск по файлам, а не Bash.')
  }
}

// 2. Есть ли здесь Prisma.
const schemaDirs = findPrismaProjects(cwd, cmd)
const prismaHere = /prisma/i.test(cmd) || schemaDirs.length > 0

// 3. Команда запускает файл (bash x.sh, node x.mjs, npx tsx x.ts) — проверяем,
//    что внутри. Спрятать команду в скрипт — это обход, а не решение.
const RUNNERS = new Set(['bash', 'sh', 'zsh', 'dash', 'node', 'tsx', 'ts-node', 'deno', 'bun', 'python', 'python3', 'npx', 'pnpm', 'yarn'])
const EXTS = /\.(sh|bash|zsh|mjs|cjs|js|ts|mts|cts|py|sql)$/
const tokens = tokenize(cmd)
if (tokens.some((t) => RUNNERS.has(path.basename(t)))) {
  const rules = prismaHere ? BAD : BAD.filter((b) => b.sqlOnly)
  for (const t of tokens) {
    if (t.startsWith('-') || RUNNERS.has(path.basename(t))) continue
    if (!EXTS.test(t) && !t.includes('/')) continue
    // Сборка и зависимости — не скрипты ассистента: в бандле Prisma свои строки.
    if (/(^|\/)(dist|build|\.output|\.nuxt|node_modules)\//.test(t)) continue
    const p = path.isAbsolute(t) ? t : path.join(cwd, t)
    let body = ''
    try {
      if (!fs.statSync(p).isFile()) continue
      body = fs.readFileSync(p, 'utf8').slice(0, 200_000)
    } catch { continue }
    const hit = rules.find((b) => b.rx.test(body))
    if (hit) deny(`внутри запускаемого файла ${t} — ${hit.label}.`)
  }
}

if (!prismaHere) process.exit(0)

// 4. Флаги, которые затирают базу или ведут к ручной миграции.
for (const flag of ['--shadow-database-url', '--accept-data-loss', '--force-reset', '--create-only']) {
  if (cmd.includes(flag)) deny(`запрещённый флаг Prisma: ${flag}.`)
}

// 5. Запрещённые подкоманды — по подстроке, где бы ни стояли:
//    `pnpm db:push`, `npx prisma@6 db push`, `sh -c "… db push"`.
if (/(^|[^\w-])db\s+(push|execute|pull)([^\w-]|$)/.test(cmd)) deny('prisma db push/execute/pull запрещены.')
if (/(^|[^\w-])migrate\s+(diff|deploy|reset|resolve)([^\w-]|$)/.test(cmd)) deny('prisma migrate diff/deploy/reset/resolve запрещены.')
if (/(^|[^\w-])(db|migrate):(push|execute|pull|reset|deploy)([^\w-]|$)/.test(cmd)) deny('npm-скрипт, за которым стоит db push / reset / deploy.')

// 6. Подмена базы прямо в команде. Файл .env остаётся правильным, а миграция
//    уходит в другую базу.
if (/(^|[^\w-])migrate([^\w-]|$)/.test(cmd)) {
  if (/(^|[^\w$])(DATABASE_URL|DIRECT_URL|SHADOW_DATABASE_URL|POSTGRES_URL|POSTGRES_PRISMA_URL)\s*=/.test(cmd)) {
    deny('адрес базы задан прямо в команде (DATABASE_URL=…).')
  }
  if (/(^|[^\w-])(dotenv|dotenv-cli|env-cmd)(\s|$)|--env-file|(^|[^\w-])(source|\.)\s+\S*\.env/.test(cmd)) {
    deny('окружение подгружается из другого файла (dotenv, --env-file, source .env*).')
  }
}

// 7. Белый список подкоманд Prisma. Вызовом считается `prisma` в позиции
//    команды: в начале, после ; && || | ( или после npx / pnpm / yarn.
const call = cmd.match(
  /(?:^|[;&|(\n])\s*(?:(?:npx|bunx|pnpm(?:\s+(?:exec|dlx))?|yarn|npm\s+exec)\s+(?:-y\s+|--yes\s+)?)?(?:\.\/)?(?:node_modules\/\.bin\/)?prisma(?:@[\w.^~-]+)?\s+([\w:.-]+)(?:\s+([\w:.-]+))?/,
)
if (call) {
  const sub = call[1]
  const sub2 = call[2] || ''
  const ok = ['generate', 'validate', 'format', 'version', '-v', '--version', 'studio', 'init']
  if (sub === 'migrate' && sub2 === 'dev') {
    if (!/--name(\s+|=)[^\s-]/.test(cmd)) {
      deny('migrate dev без --name.', 'Без имени Prisma уходит в диалог и при расхождении схемы предлагает сбросить базу.')
    }
    checkLocalDb()
  } else if (sub === 'migrate' && sub2 === 'status') {
    // только чтение
  } else if (!ok.includes(sub)) {
    deny(`подкоманда prisma ${sub}${sub2 ? ' ' + sub2 : ''} запрещена.`, `Разрешено: migrate dev --name, migrate status, ${ok.join(', ')}.`)
  }
}
// Те же проверки для migrate dev в любой форме, которую не разобрал шаблон выше
// (`pnpm --dir api exec prisma migrate dev`, npm-скрипт db:migrate), и для seed:
// сид обычно чистит таблицы перед заполнением.
if (/(^|[^\w-])migrate\s+dev([^\w-]|$)/.test(cmd)) {
  if (!/--name(\s+|=)[^\s-]/.test(cmd)) {
    deny('migrate dev без --name.', 'Без имени Prisma уходит в диалог и при расхождении схемы предлагает сбросить базу.')
  }
  checkLocalDb()
}
if (/(^|[^\w-])(db|migrate):(dev|migrate|seed)([^\w-]|$)|(^|[^\w-])db\s+seed([^\w-]|$)/.test(cmd)) checkLocalDb()

// 8. Запись в prisma/migrations/ через Bash (cp, mv, >, tee, sed -i …).
const WRITE_OPS = /(^|[^0-9])>{1,2}|\stee(\s|$)|(^|\s)(cp|mv|touch|mkdir|rm|dd|rsync|install|ditto|sed\s+-i|perl\s+-pi)(\s|$)/
if ((/prisma\/migrations\//.test(cmd) || /migration\.sql/.test(cmd)) && WRITE_OPS.test(cmd)) {
  deny('запись в prisma/migrations/ запрещена.')
}

process.exit(0)

// ── помощники ────────────────────────────────────────────────────────────────

function tokenize(s) {
  const out = []
  const re = /"([^"]*)"|'([^']*)'|([^\s;&|()<>]+)/g
  let m
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

// Папки с prisma/schema.prisma: cwd и выше до домашней, на уровень ниже
// (схема в api/prisma), и папки из `cd <путь>` в самой команде.
function findPrismaProjects(start, command) {
  const found = new Set()
  const home = os.homedir()
  const has = (d) => fs.existsSync(path.join(d, 'prisma', 'schema.prisma'))
  const starts = [start]
  for (const m of command.matchAll(/(?:^|[;&|(]\s*)cd\s+("[^"]+"|'[^']+'|\S+)/g)) {
    const d = m[1].replace(/^["']|["']$/g, '')
    starts.push(path.resolve(start, d.replace(/^~(?=$|\/)/, home)))
  }
  for (const s of starts) {
    let d = path.resolve(s)
    for (let i = 0; i < 8; i++) {
      if (has(d)) found.add(d)
      if (i === 0) {
        try {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && has(path.join(d, e.name))) {
              found.add(path.join(d, e.name))
            }
          }
        } catch {}
      }
      const parent = path.dirname(d)
      if (d === home || parent === d) break
      d = parent
    }
  }
  return [...found]
}

// migrate dev — только в локальную базу. Адрес берём из .env рядом с prisma/
// или из окружения. Не смогли узнать — запрещаем: ошибаемся в сторону запрета.
function checkLocalDb() {
  if (schemaDirs.length === 0) {
    deny('не нашёл prisma/schema.prisma, поэтому не могу проверить, в какую базу уйдёт миграция.', 'Запусти migrate dev из папки сервиса со схемой.')
  }
  for (const dir of schemaDirs) {
    let varName = 'DATABASE_URL'
    try {
      const schema = fs.readFileSync(path.join(dir, 'prisma', 'schema.prisma'), 'utf8')
      const m = schema.match(/url\s*=\s*env\(\s*"(\w+)"\s*\)/)
      if (m) varName = m[1]
    } catch {}
    let url = ''
    for (const f of ['.env', '.env.local', '.env.development']) {
      try {
        const txt = fs.readFileSync(path.join(dir, f), 'utf8')
        const m = txt.match(new RegExp(`^\\s*(?:export\\s+)?${varName}\\s*=\\s*["']?([^"'\\n#]+)`, 'm'))
        if (m) { url = m[1].trim(); break }
      } catch {}
    }
    if (!url) url = process.env[varName] || ''
    if (!url) {
      deny(`не нашёл ${varName} для ${dir}, поэтому не могу проверить, в какую базу уйдёт миграция.`, `Положи ${varName} с адресом локальной базы в ${path.join(dir, '.env')}.`)
    }
    let host = ''
    try { host = new URL(url).hostname } catch {}
    if (!LOCAL_DB_HOSTS.has(host)) {
      deny(
        `команда нацелена не на локальную базу (хост «${host || 'не разобрал'}»).`,
        'Разработка идёт в своей базе: Postgres в Docker на этом компьютере. Боевую схему обновляет деплой.',
      )
    }
  }
}
