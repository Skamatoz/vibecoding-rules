#!/usr/bin/env node
/**
 * Сторож устройства API: `pnpm check:arch` (входит в `pnpm check` и git-хук перед коммитом).
 *
 * Что проверяет (правила — AGENTS.md этого сервиса):
 *  · роут не импортирует prisma — ни `lib/prisma`, ни `lib/db`, ни `@prisma/client`:
 *    в базу ходит только сервис;
 *  · роут не ходит во внешние API (`fetch`, `axios`) — это делает сервис через lib;
 *  · lib — инфраструктура: о сервисах, роутах и воркерах не знает;
 *  · сервисы и воркеры не зависят от роутов;
 *  · файл длиннее MAX_LINES — ошибка, длиннее WARN_LINES — предупреждение;
 *  · циклы импорта — предупреждение.
 * Импорты понимает любые: относительные, без расширения, с алиасами `@/`, `~/`,
 * `#/`, `src/` и путями из tsconfig.json, в одинарных и двойных кавычках.
 * Ошибка даёт код выхода 1, и коммит не проходит.
 *
 * Код ищется в src/. Нет src/ — в корне сервиса (папки routes/, services/ … там).
 * Запуск для другой папки: node scripts/check-architecture.mjs <путь к сервису>
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const WARN_LINES = 300
const MAX_LINES = 600

/** [чей файл (префикс от папки с кодом), что ему нельзя импортировать, почему]. */
const RULES = [
  ['routes/', ['lib/prisma', 'lib/db'], 'роут не ходит в базу — только через сервис'],
  ['lib/', ['services/', 'routes/', 'workers/'], 'lib — инфраструктура, о домене не знает'],
  ['services/', ['routes/'], 'сервис не зависит от HTTP-слоя'],
  ['workers/', ['routes/'], 'воркер не зависит от HTTP-слоя'],
]

let SRC = path.join(ROOT, 'src')
if (!fs.existsSync(SRC)) {
  // Свежая заготовка: ни кода, ни package.json — проверять нечего, первый коммит не блокируем.
  if (!fs.existsSync(path.join(ROOT, 'package.json'))) {
    console.log('устройство API: кода ещё нет — проверять нечего')
    process.exit(0)
  }
  SRC = ROOT
  console.log('⚠️  папки src/ нет — проверяю корень сервиса')
}

const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', 'scripts', 'prisma'])
const files = []
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(ts|mts|cts|js|mjs)$/.test(e.name) && !/\.(test|spec|d)\.[mc]?[tj]s$/.test(e.name)) files.push(p)
  }
}
walk(SRC)

// Алиасы: стандартные плюс paths из tsconfig.json ("@/*": ["./src/*"]).
const ALIASES = [['@/', SRC], ['~/', SRC], ['#/', SRC], ['src/', path.join(ROOT, 'src')]]
try {
  const raw = fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1')
  const co = JSON.parse(raw).compilerOptions || {}
  const base = path.resolve(ROOT, co.baseUrl || '.')
  for (const [k, v] of Object.entries(co.paths || {})) {
    if (k.endsWith('/*') && Array.isArray(v) && typeof v[0] === 'string' && v[0].endsWith('/*')) {
      ALIASES.unshift([k.slice(0, -1), path.resolve(base, v[0].slice(0, -1))])
    }
  }
} catch {}

const noExt = (p) => p.replace(/\.(d\.)?([mc]?[tj]s|tsx|jsx)$/, '').replace(/\/index$/, '')
const rel = (p) => noExt(path.relative(SRC, p).split(path.sep).join('/'))

/** Путь импорта → файл относительно папки с кодом, или null для пакета из node_modules. */
function resolveSpec(fromFile, spec) {
  if (spec.startsWith('./') || spec.startsWith('../')) return rel(path.resolve(path.dirname(fromFile), spec))
  for (const [prefix, dir] of ALIASES) {
    if (spec.startsWith(prefix)) return rel(path.join(dir, spec.slice(prefix.length)))
  }
  return null
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s([^;'"]*?)\sfrom\s+(['"])([^'"]+)\2|(?:^|\n)\s*import\s+(['"])([^'"]+)\4|import\(\s*(['"])([^'"]+)\6\s*\)/g

/** Граф: файл → файлы, которые он импортирует (только значения: `import type` для циклов не в счёт). */
const graph = new Map()
const errors = []
const warnings = []

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1')
  const from = rel(file)
  const deps = []
  for (const m of code.matchAll(IMPORT_RE)) {
    const spec = m[3] ?? m[5] ?? m[7]
    const typeOnly = /^\s*type\s/.test(m[1] ?? '') || /^\s*(?:import|export)\s+type\s/.test(m[0].trimStart())
    if (spec === '@prisma/client' && from.startsWith('routes/') && !typeOnly) {
      errors.push(`${from} → @prisma/client: роут не ходит в базу — только через сервис`)
    }
    const target = resolveSpec(file, spec)
    if (!target) continue
    for (const [owner, banned, why] of RULES) {
      if (!from.startsWith(owner)) continue
      if (banned.some((b) => target === b || target.startsWith(b.endsWith('/') ? b : b + '/'))) errors.push(`${from} → ${target}: ${why}`)
    }
    if (!typeOnly) deps.push(target)
  }
  if (from.startsWith('routes/')) {
    const call = code.match(/(^|[^$\w.])fetch\s*\(|\baxios\b|\bofetch\s*\(/)
    if (call) errors.push(`${from}: ${call[0].trim().replace(/\($/, '')} — роут не ходит во внешние API, это делает сервис через lib`)
  }
  graph.set(from, deps)
  const lines = text.split('\n').length
  if (lines > MAX_LINES) errors.push(`${from}: ${lines} строк (потолок ${MAX_LINES}) — разрежь по смыслу`)
  else if (lines > WARN_LINES) warnings.push(`${from}: ${lines} строк (цель до ${WARN_LINES})`)
}

// Циклы импорта (по значениям): алгоритм Тарьяна, компоненты сильной связности.
let index = 0
const idx = new Map()
const low = new Map()
const stack = []
const onStack = new Set()
const cycles = []
const strong = (v) => {
  idx.set(v, index)
  low.set(v, index)
  index++
  stack.push(v)
  onStack.add(v)
  for (const w of graph.get(v) ?? []) {
    if (!graph.has(w)) continue
    if (!idx.has(w)) {
      strong(w)
      low.set(v, Math.min(low.get(v), low.get(w)))
    } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)))
  }
  if (low.get(v) === idx.get(v)) {
    const comp = []
    let w
    do {
      w = stack.pop()
      onStack.delete(w)
      comp.push(w)
    } while (w !== v)
    if (comp.length > 1) cycles.push(comp.sort())
  }
}
for (const v of graph.keys()) if (!idx.has(v)) strong(v)
for (const c of cycles) warnings.push(`цикл импорта (${c.length}): ${c.join(' ⇄ ')}`)

for (const w of warnings) console.log(`⚠️  ${w}`)
for (const e of errors) console.log(`✖ ${e}`)
console.log(
  errors.length
    ? `\nустройство API: нарушений ${errors.length} — исправить (правила — AGENTS.md этого сервиса)`
    : `устройство API: в порядке (${files.length} файлов${warnings.length ? `, предупреждений ${warnings.length}` : ''})`,
)
process.exit(errors.length ? 1 : 0)
