#!/usr/bin/env node
/**
 * Сторож устройства API: `pnpm check:arch` (входит в `pnpm check`).
 *
 * Слои — routes → services → lib (AGENTS.md, раздел 4):
 *  · роут — только схема, права и вызов сервиса: в базу не ходит;
 *  · lib — инфраструктура: о сервисах, роутах и воркерах не знает;
 *  · сервисы и воркеры не зависят от роутов.
 * Размер: файл длиннее WARN_LINES — предупреждение, длиннее MAX_LINES — ошибка.
 * Циклы импорта — предупреждение.
 * Ошибка даёт код выхода 1, и коммит не проходит.
 *
 * Без зависимостей: импорты читаются регуляркой, пути — как в коде (`.js` → `.ts`).
 * Запуск для другой папки: node scripts/check-architecture.mjs <путь к сервису>
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const SRC = path.join(ROOT, 'src')
const WARN_LINES = 300
const MAX_LINES = 600

/** [чей файл (префикс от src/), что ему нельзя импортировать (префиксы), почему]. */
const RULES = [
  ['routes/', ['lib/prisma.ts', 'lib/db.ts'], 'роут не ходит в базу — только через сервис'],
  ['lib/', ['services/', 'routes/', 'workers/'], 'lib — инфраструктура, о домене не знает'],
  ['services/', ['routes/'], 'сервис не зависит от HTTP-слоя'],
  ['workers/', ['routes/'], 'воркер не зависит от HTTP-слоя'],
]

if (!fs.existsSync(SRC)) {
  console.log(`✖ нет папки ${SRC}`)
  process.exit(1)
}

const files = []
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) files.push(p)
  }
}
walk(SRC)

const rel = (p) => path.relative(SRC, p).split(path.sep).join('/')
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+'(\.{1,2}\/[^']+)'|import\(\s*'(\.{1,2}\/[^']+)'\s*\)/g

/** Граф: файл → файлы, которые он импортирует (только значения: `import type` для циклов не в счёт). */
const graph = new Map()
const errors = []
const warnings = []

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  const from = rel(file)
  const deps = []
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2]
    const target = rel(path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts')))
    const typeOnly = /^\s*(?:import|export)\s+type\s/.test(m[0].trimStart())
    for (const [owner, banned, why] of RULES) {
      if (!from.startsWith(owner)) continue
      if (banned.some((b) => target === b || target.startsWith(b))) errors.push(`${from} → ${target}: ${why}`)
    }
    if (!typeOnly) deps.push(target)
  }
  // Роут импортирует Prisma напрямую из пакета — тоже поход в базу мимо сервиса.
  if (from.startsWith('routes/') && /from\s+'@prisma\/client'/.test(text) && !/import\s+type\s[^'"]*from\s+'@prisma\/client'/.test(text)) {
    errors.push(`${from} → @prisma/client: роут не ходит в базу — только через сервис`)
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
    ? `\nустройство API: нарушений ${errors.length} — исправить (правила — AGENTS.md, раздел 4)`
    : `устройство API: в порядке (${files.length} файлов${warnings.length ? `, предупреждений ${warnings.length}` : ''})`,
)
process.exit(errors.length ? 1 : 0)
