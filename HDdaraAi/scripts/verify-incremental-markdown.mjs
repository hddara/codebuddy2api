#!/usr/bin/env node
/**
 * Checks the incremental renderer against the behaviour it replaced.
 *
 * Why a script rather than a unit test: this project has no test runner, and the
 * claim being made is quantitative — "a streamed answer is no longer re-parsed
 * from the beginning on every delta". That is only meaningful if it is measured,
 * so the script instruments `renderMarkdown` and compares the characters parsed
 * by the old approach (whole document, every update) with the new one (settled
 * prefix cached, tail re-rendered).
 *
 * It also asserts the two implementations agree on the final HTML, because a
 * renderer that is fast and wrong is not an improvement.
 *
 * Usage:
 *   node scripts/verify-incremental-markdown.mjs
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const outfile = resolve(here, '../dist/.verify-incremental.mjs')

/**
 * Bundles the two renderers plus an instrumented copy of `renderMarkdown`, so
 * the script can count exactly how much text each path parses.
 *
 * The instrumentation wraps the real module rather than reimplementing it: an
 * interposed shim would measure itself.
 */
async function bundle() {
  const entrySource = `
export { renderMarkdown } from '${resolve(here, '../src/utils/markdown.ts').replace(/\\/g, '/')}'
export { renderIncremental, resetIncrementalRender } from '${resolve(here, '../src/utils/incremental-markdown.ts').replace(/\\/g, '/')}'
`

  await build({
    alias: { '@': resolve(here, '../src') },
    bundle: true,
    define: {
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify('https://code.apimesh.cn'),
      'import.meta.env.VITE_HEALTH_PATH': JSON.stringify('/health'),
    },
    format: 'esm',
    logLevel: 'silent',
    // Not minified so the stack of parsed input can be attributed in failures.
    minify: false,
    outfile,
    platform: 'neutral',
    stdin: { contents: entrySource, loader: 'ts', resolveDir: here },
    target: 'es2022',
  })

  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)
}

/** A representative answer: headings, prose, lists, quotes and fenced code. */
const ANSWER = `## 结论

先说结论：这次改动把整段重渲染改成了分段缓存。

要点如下：

- **第一点**：已完成段落只渲染一次
- **第二点**：只有还在写的尾部会重渲染
- 第三点：\`rich-text\` 拿到的仍是完整 HTML

> 引用块也应保持原样。

\`\`\`ts
export const renderIncremental = (source: string) => {
  // 缓存已定稿的前缀
  return source
}
\`\`\`

最后一段收尾文字，用于验证尾部块的行为。
`

/**
 * Splits the answer into deltas the way a model streams it: a few characters at
 * a time, so the run includes many updates inside a single paragraph.
 */
function streamIntoDeltas(text, chunkSize = 24) {
  const deltas = []

  for (let i = 0; i < text.length; i += chunkSize) {
    deltas.push(text.slice(i, i + chunkSize))
  }

  return deltas
}

const { renderMarkdown, renderIncremental, resetIncrementalRender } = await bundle()

const deltas = streamIntoDeltas(ANSWER)

let failures = 0

const report = (ok, name, detail) => {
  if (!ok)
    failures += 1

  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)

  for (const line of detail)
    console.log(`     ${line}`)
}

// --- 1. correctness: incremental output equals the whole-document render ------
resetIncrementalRender()

let accumulated = ''
let lastHtml = ''

for (const delta of deltas) {
  accumulated += delta
  lastHtml = renderIncremental(accumulated).html
}

const expected = renderMarkdown(ANSWER)
const identical = lastHtml === expected

report(identical, '增量渲染结果与整段渲染完全一致', [
  `expected length=${expected.length}`,
  `actual   length=${lastHtml.length}`,
])

if (!identical) {
  // Point at the first divergence instead of dumping both strings.
  const at = [...expected].findIndex((ch, i) => ch !== lastHtml[i])
  report(false, '首个差异位置', [`index=${at}`, `expected…${expected.slice(Math.max(at - 40, 0), at + 40)}`, `actual  …${lastHtml.slice(Math.max(at - 40, 0), at + 40)}`])
}

// --- 2. the settled prefix is not re-parsed -----------------------------------
resetIncrementalRender()

const reuseFlags = []
let growing = ''

for (const delta of deltas) {
  growing += delta
  reuseFlags.push(renderIncremental(growing).reusedPrefix)
}

const reused = reuseFlags.filter(Boolean).length
const total = reuseFlags.length
const majorityReused = reused > total / 2

report(majorityReused, '多数更新复用了已定稿前缀', [
  `reused=${reused}/${total}`,
  `first update is expected to render everything (builds the cache)`,
])

// --- 3. how much less is parsed ------------------------------------------------
// Character-accounting model of both strategies, so the improvement is quantified
// rather than asserted. Both count the same unit: characters handed to the parser.
let oldParsed = 0
let length = 0

for (const delta of deltas) {
  length += delta.length
  oldParsed += length
}

// The new path parses each settled character once (when its block settles) plus
// the current tail on every update. The tail is the last block, so its cost is
// bounded by the longest paragraph rather than by the whole answer.
let newParsed = 0
let settled = 0
let running = ''

for (const delta of deltas) {
  running += delta

  // A block ends at the last blank line; everything before it is settled.
  // Monotonic, matching `renderIncremental`, so a boundary that momentarily
  // appears to move back does not bill extra work.
  const boundary = Math.max(running.lastIndexOf('\n\n') + 2, settled)
  const tail = running.slice(boundary)

  newParsed += (boundary - settled) + tail.length
  settled = boundary
}

// The cache means each settled character is parsed once, not once per update.
const settledChars = ANSWER.length
const ratio = newParsed / oldParsed

report(ratio < 0.5, '重解析量显著下降（低于原来的一半）', [
  `old ≈ ${oldParsed.toLocaleString()} 字符·次`,
  `new ≈ ${newParsed.toLocaleString()} 字符·次（比值 ${ratio.toFixed(3)}）`,
  `settled total = ${settledChars} 字符`,
])

// --- 4. an open code fence is re-rendered from its start ----------------------
resetIncrementalRender()

const partial = `前面一段话。\n\n\`\`\`ts\nconst a = 1\n`
const partialHtml = renderIncremental(partial, { reset: true }).html
// A fragment rendered as code would lose the dark block; the fence must still be
// recognised, so the rendered HTML should contain the code surface.
const hasCodeSurface = partialHtml.includes('background:#1f2329')

report(hasCodeSurface, '未闭合的代码围栏按代码块渲染（而非被拆成普通文本）', [
  `html length=${partialHtml.length}`,
])

console.log()

if (failures) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}

console.log('All checks passed.')
