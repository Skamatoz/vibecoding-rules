#!/usr/bin/env node
/**
 * Сторож устройства фронта: `pnpm check:arch` (входит в `pnpm check` и git-хук перед коммитом).
 *
 * Что проверяет (правила — CLAUDE.md этого сервиса):
 *  · в API ходят только composables через useApi: в pages/, components/ и layouts/
 *    нет $fetch, useFetch, useLazyFetch, fetch, axios;
 *  · utils/ — чистые функции: без composables, запросов и импортов из
 *    components/ и composables/ (`import type` можно);
 *  · размер: страница — до 200 строк, остальное — до 300 (предупреждение);
 *    больше 600 строк — ошибка.
 * Ошибка даёт код выхода 1, и коммит не проходит.
 *
 * Код ищется в app/ (Nuxt 4), потом в корне сервиса (Nuxt 3: pages/ и components/
 * в корне), потом в src/ (Vite).
 * Запуск для другой папки: node scripts/check-architecture.mjs <путь к сервису>
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const WARN_PAGE = 200
const WARN_LINES = 300
const MAX_LINES = 600

const hasUi = (d) => ['pages', 'components'].some((x) => fs.existsSync(path.join(d, x)))
const APP = [path.join(ROOT, 'app'), ROOT, path.join(ROOT, 'src')].find((d) => fs.existsSync(d) && hasUi(d))

if (!APP) {
  // Свежая заготовка: ни кода, ни package.json — проверять нечего, первый коммит не блокируем.
  if (!fs.existsSync(path.join(ROOT, 'package.json'))) {
    console.log('устройство фронта: кода ещё нет — проверять нечего')
    process.exit(0)
  }
  console.log(`✖ не нашёл pages/ или components/ ни в app/, ни в корне, ни в src/ (${ROOT})`)
  console.log('  Код лежит в другой папке — запусти: node scripts/check-architecture.mjs <путь к сервису>')
  process.exit(1)
}

const SKIP = new Set(['node_modules', 'dist', 'build', '.output', '.nuxt', 'coverage', 'scripts', 'server', 'public'])
const files = []
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(vue|ts|tsx|js|jsx)$/.test(e.name) && !/\.(d|test|spec)\.[tj]sx?$/.test(e.name) && !/^(nuxt|vite|tailwind|eslint)\.config\./.test(e.name)) files.push(p)
  }
}
walk(APP)

const rel = (p) => path.relative(APP, p).split(path.sep).join('/')
const errors = []
const warnings = []

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  const from = rel(file)
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1')

  if (/^(pages|components|layouts)\//.test(from)) {
    const m = code.match(/\$fetch\s*[(<]|\buse(Lazy)?Fetch\s*[(<]|(^|[^$\w.])fetch\s*\(|\baxios\b/)
    if (m) errors.push(`${from}: ${m[0].trim().replace(/[(<]$/, '')} — в API ходит composable через useApi, не страница и не компонент`)
  }

  if (from.startsWith('utils/')) {
    if (/\$fetch\s*[(<]|(^|[^$\w.])fetch\s*\(|\baxios\b|\buse[A-Z]\w*\s*\(/.test(code)) {
      errors.push(`${from}: вызов composable или запрос — utils только для чистых функций`)
    }
    // `import type` — законно: типы ответа API часто лежат рядом с composable.
    if (/^\s*import\s+(?!type\s)[^'"]*from\s+['"][^'"]*(\/|^|['"])(components|composables)\//m.test(code)) {
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
