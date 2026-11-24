#!/usr/bin/env node
// guard-db.mjs — хук Claude Code (PreToolUse), который не даёт ассистенту
// стереть или испортить базу. Подключён в .claude/settings.json проекта:
// Claude Code запускает его перед каждой командой и правкой файла.
// Нужен Node 18+. Проверка: попроси ассистента выполнить `npx prisma db push` —
// должна прийти «БЛОКИРОВКА ХУКОМ guard-db».
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
//     - migrate dev и seed в нелокальную базу (список LOCAL_DB_HOSTS ниже).
//       Адрес смотрится как у Prisma: окружение, профиль шелла, потом .env;
//     - ручной SQL: psql -c/-f, $executeRaw, DROP/TRUNCATE, DELETE FROM,
//       pg_restore, dropdb. Текст SQL — только если команда что-то запускает,
//       сообщения коммитов не проверяются;
//     - запись в prisma/migrations/;
//     - то же самое, спрятанное в файл (bash x.sh, node x.mjs, ./deploy.sh)
//       или в npm-скрипт (npm run deploy, pnpm deploy, yarn deploy).
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

// Текст для проверки на SQL: без сообщений коммита. Иначе `git commit -m "fix:
// delete from cache"` блокируется как SQL, хотя ничего не выполняет.
const scanText = cmd.replace(/(^|\s)(-m|--message)(\s+|=)("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/g, ' ')

// Программы, через которые текст в команде может уйти в базу как SQL.
const EXECUTORS = /(^|[\s;&|(])(\S*\/)?(node|tsx|ts-node|bun|deno|python3?|psql|sqlite3|mysql|mariadb|prisma|npx|pnpm|yarn|npm|docker|ssh|sh|bash|zsh|dash)(\s|$)/

// 1. Разрушающий SQL — в любом проекте, есть там Prisma или нет.
if (/(^|[^\w-])psql(\s|$)/.test(scanText)) {
  if (/(\s|^)(-c|-f|--command|--file)(\s|=)|<<|<\s*\S+|\|\s*(\S*\/)?psql\b/.test(scanText)) {
    deny('ручной SQL через psql запрещён.', 'Посмотреть данные — через MCP к базе, он только читает.')
  }
}
for (const b of BAD.filter((b) => b.sqlOnly)) {
  // psql, pg_restore, dropdb — это сами программы, их ловим всегда. Текст SQL
  // (DROP, DELETE FROM, $executeRaw) опасен, только если команда что-то запускает.
  const isProgram = b.label.startsWith('psql')
  if (b.rx.test(scanText) && (isProgram || EXECUTORS.test(scanText))) {
    deny(`запрещённая операция: ${b.label}.`, 'Ищешь такой текст в коде — используй поиск по файлам, а не Bash.')
  }
}

// 2. Есть ли здесь Prisma.
const schemaDirs = findPrismaProjects(cwd, cmd)
const prismaHere = /prisma/i.test(cmd) || schemaDirs.length > 0

// 3. Команда запускает файл или npm-скрипт — проверяем, что внутри.
//    Спрятать команду в скрипт — это обход, а не решение.
const rules = prismaHere ? BAD : BAD.filter((b) => b.sqlOnly)
const RUNNERS = new Set(['bash', 'sh', 'zsh', 'dash', 'node', 'tsx', 'ts-node', 'deno', 'bun', 'python', 'python3', 'npx', 'pnpm', 'yarn', 'npm'])
const EXTS = /\.(sh|bash|zsh|mjs|cjs|js|ts|mts|cts|py|sql)$/
// Сборка и зависимости — не скрипты ассистента: в бандле Prisma свои строки.
const SKIP_DIRS = /(^|\/)(dist|build|\.output|\.nuxt|node_modules)\//

function scanFile(file, label) {
  if (SKIP_DIRS.test(file)) return
  let body = ''
  try {
    if (!fs.statSync(file).isFile()) return
    body = fs.readFileSync(file, 'utf8').slice(0, 200_000)
  } catch { return }
  if (body.includes('\u0000')) return // бинарник, а не скрипт
  const hit = rules.find((b) => b.rx.test(body))
  if (hit) deny(`внутри запускаемого файла ${label} — ${hit.label}.`)
}

// 3а. Команда с раннером: все файлы-скрипты в ней. Это ловит и
//     `cp src.mjs t.mjs && node t.mjs`: t.mjs ещё нет, но src.mjs уже читается.
const tokens = tokenize(cmd)
if (tokens.some((t) => RUNNERS.has(path.basename(t)))) {
  for (const t of tokens) {
    if (t.startsWith('-') || !EXTS.test(t)) continue
    scanFile(path.isAbsolute(t) ? t : path.join(cwd, t), t)
  }
}

// 3б. По частям команды: запуск файла напрямую (`./deploy.sh`, `bin/migrate`)
//     и npm-скрипты (`npm run deploy`, `pnpm deploy`, `yarn deploy`).
const PM_BUILTINS = new Set(['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'exec', 'dlx', 'x', 'init', 'create', 'ci', 'list', 'ls', 'outdated', 'why', 'link', 'unlink', 'publish', 'pack', 'store', 'config', 'prune', 'audit', 'dedupe', 'import', 'rebuild', 'fetch', 'patch', 'setup', 'env', 'help', 'info', 'view', 'login', 'logout', 'whoami', 'version', 'cache', 'global', 'licenses', 'workspace', 'workspaces'])
let curDir = cwd
for (const seg of cmd.split(/&&|\|\||[;|\n]/)) {
  const tk = tokenize(seg)
  let i = 0
  while (i < tk.length && (/^\w+=/.test(tk[i]) || ['sudo', 'env', 'time', 'exec', 'command', 'nohup'].includes(tk[i]))) i++
  const prog = tk[i]
  if (!prog) continue
  if (prog === 'cd') { curDir = path.resolve(curDir, (tk[i + 1] || os.homedir()).replace(/^~(?=$|\/)/, os.homedir())); continue }
  if (prog.includes('/') && !RUNNERS.has(path.basename(prog))) {
    scanFile(path.isAbsolute(prog) ? prog : path.join(curDir, prog), prog)
    continue
  }
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(prog)) continue
  // Папка пакета: --dir, -C, --prefix, --cwd или текущая после cd.
  let pkgDir = curDir
  const rest = []
  for (let j = i + 1; j < tk.length; j++) {
    if (['--dir', '-C', '--prefix', '--cwd'].includes(tk[j])) { pkgDir = path.resolve(curDir, tk[++j] || '.'); continue }
    if (/^--(dir|prefix|cwd)=/.test(tk[j])) { pkgDir = path.resolve(curDir, tk[j].split('=')[1]); continue }
    if (tk[j].startsWith('-')) continue
    rest.push(tk[j])
  }
  let name = rest[0]
  if (name === 'run' || name === 'run-script') name = rest[1]
  else if (prog === 'npm' && !['test', 't', 'start', 'stop', 'restart'].includes(name)) name = undefined
  else if (PM_BUILTINS.has(name)) name = undefined
  if (name === 't') name = 'test'
  if (!name) continue
  checkPackageScript(pkgDir, name, 0)
}

function checkPackageScript(dir, name, depth) {
  let scripts = {}
  try { scripts = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts || {} } catch { return }
  const body = scripts[name]
  if (typeof body !== 'string') return
  const hit = BAD.find((b) => b.rx.test(body))
  if (hit) deny(`npm-скрипт «${name}» запускает: ${hit.label}.`)
  if (/(^|[^\w-])(migrate\s+dev|db\s+seed)([^\w-]|$)/.test(body)) checkLocalDb()
  // Скрипт зовёт файл или другой скрипт — смотрим и туда, на два уровня.
  for (const t of tokenize(body)) {
    if (EXTS.test(t) && !t.startsWith('-')) scanFile(path.join(dir, t), `${t} (из скрипта «${name}»)`)
  }
  if (depth < 2) {
    for (const m of body.matchAll(/(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/g)) {
      if (m[1] !== name && !PM_BUILTINS.has(m[1])) checkPackageScript(dir, m[1], depth + 1)
    }
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

// migrate dev и seed — только в локальную базу. Адрес ищем там же, где его
// возьмёт Prisma, и в том же порядке: переменная окружения главнее .env.
// Не смогли узнать — запрещаем: ошибаемся в сторону запрета.
function checkLocalDb() {
  if (schemaDirs.length === 0) {
    deny('не нашёл prisma/schema.prisma, поэтому не могу проверить, в какую базу уйдёт миграция.', 'Запусти migrate dev из папки сервиса со схемой.')
  }
  const hostOf = (u) => { try { return new URL(u).hostname } catch { return '' } }
  const isLocal = (u) => LOCAL_DB_HOSTS.has(hostOf(u))
  const readVar = (file, name) => {
    try {
      const txt = fs.readFileSync(file, 'utf8')
      const m = txt.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*["']?([^"'\\n#]+)`, 'm'))
      return m ? m[1].trim() : ''
    } catch { return '' }
  }
  const remote = (where, u) => deny(
    `${where}: команда нацелена не на локальную базу (хост «${hostOf(u) || 'не разобрал'}»).`,
    'Разработка идёт в своей базе: Postgres в Docker на этом компьютере. Боевую схему обновляет деплой.',
  )

  for (const dir of schemaDirs) {
    let varName = 'DATABASE_URL'
    try {
      const schema = fs.readFileSync(path.join(dir, 'prisma', 'schema.prisma'), 'utf8')
      const m = schema.match(/url\s*=\s*env\(\s*"(\w+)"\s*\)/)
      if (m) varName = m[1]
    } catch {}

    // 1) Окружение. Prisma берёт его раньше .env: если здесь прод, .env не спасёт.
    const envUrl = process.env[varName] || ''
    if (envUrl && !isLocal(envUrl)) remote(`${varName} в окружении`, envUrl)

    // 2) Профиль шелла. Команды Bash запускаются с ним, а хук его может не видеть.
    for (const f of ['.zshrc', '.zprofile', '.zshenv', '.bashrc', '.bash_profile', '.profile']) {
      const u = readVar(path.join(os.homedir(), f), varName)
      if (u && !isLocal(u)) remote(`${varName} в ~/${f}`, u)
    }

    // 3) Файлы .env — рядом с package.json и рядом со схемой.
    let fileUrl = ''
    for (const f of ['.env', 'prisma/.env', '.env.local', '.env.development']) {
      fileUrl = readVar(path.join(dir, f), varName)
      if (fileUrl) break
    }
    if (fileUrl && !isLocal(fileUrl)) remote(`${varName} в .env`, fileUrl)

    if (!envUrl && !fileUrl) {
      deny(`не нашёл ${varName} для ${dir}, поэтому не могу проверить, в какую базу уйдёт миграция.`, `Положи ${varName} с адресом локальной базы в ${path.join(dir, '.env')}.`)
    }
  }
}
