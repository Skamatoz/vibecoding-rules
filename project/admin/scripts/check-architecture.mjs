#!/usr/bin/env node
/**
 * Сторож устройства фронта на Nuxt: `pnpm check:arch` (входит в `pnpm check`).
 *
 * Правила (CLAUDE.md этого сервиса):
 *  · в API ходят только composables через useApi: в pages/ и components/
 *    нет $fetch, useFetch, useLazyFetch;
 *  · utils/ — чистые функции: без composables, запросов и импортов из
 *    components/ и composables/;
 *  · размер: страница — до 200 строк, остальное — до 300 (предупреждение);
 *    больше 600 строк — ошибка.
 * Ошибка даёт код выхода 1, и коммит не проходит.
 *
 * Запуск для другой папки: node scripts/check-architecture.mjs <путь к сервису>
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const APP = path.join(ROOT, 'app')
const WARN_PAGE = 200
const WARN_LINES = 300
const MAX_LINES = 600

// Свежая заготовка: кода ещё нет — проверять нечего, первый коммит не блокируем.
if (!fs.existsSync(APP)) {
  console.log('устройство фронта: папки app/ ещё нет — проверять нечего')
  process.exit(0)
}

const files = []
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(vue|ts)$/.test(e.name) && !e.name.endsWith('.d.ts') && !e.name.endsWith('.test.ts')) files.push(p)
  }
}
walk(APP)

const rel = (p) => path.relative(APP, p).split(path.sep).join('/')
const errors = []
const warnings = []

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  const from = rel(file)
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  if (/^(pages|components|layouts)\//.test(from)) {
    const m = code.match(/\$fetch\s*[(<]|\buse(Lazy)?Fetch\s*[(<]/)
    if (m) errors.push(`${from}: ${m[0].replace(/[(<]$/, '')} — в API ходит composable через useApi, не страница и не компонент`)
  }

  if (from.startsWith('utils/')) {
    if (/\$fetch\s*[(<]|\buse[A-Z]\w*\s*\(/.test(code)) {
      errors.push(`${from}: вызов composable или запрос — utils только для чистых функций`)
    }
    // `import type` — законно: типы ответа API часто лежат рядом с composable.
    if (/^\s*import\s+(?!type\s)[^'"]*from\s+['"][^'"]*\/(components|composables)\//m.test(code)) {
      errors.push(`${from}: импорт из components/ или composables/ — utils о них не знает`)
    }
  }

  const lines = text.split('\n').length
  const warnAt = from.startsWith('pages/') ? WARN_PAGE : WARN_LINES
  if (lines > MAX_LINES) errors.push(`${from}: ${lines} строк (потолок ${MAX_LINES}) — разрежь на компоненты`)
  else if (lines > warnAt) warnings.push(`${from}: ${lines} строк (цель до ${warnAt})`)
}

for (const w of warnings) console.log(`⚠️  ${w}`)
for (const e of errors) console.log(`✖ ${e}`)
console.log(
  errors.length
    ? `\nустройство фронта: нарушений ${errors.length} — исправить (правила — CLAUDE.md этого сервиса)`
    : `устройство фронта: в порядке (${files.length} файлов${warnings.length ? `, предупреждений ${warnings.length}` : ''})`,
)
process.exit(errors.length ? 1 : 0)
