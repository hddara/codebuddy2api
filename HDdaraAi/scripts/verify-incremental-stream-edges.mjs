/**
 * Streams an answer character by character and compares the incremental result
 * with a full render at every step.
 *
 * Why character-at-a-time: the live page receives deltas, and a delta can land
 * in the middle of a token. A boundary rule that settles text on a partial token
 * freezes the fragment and never lets the rest of it arrive — which showed up on
 * a device as a numbered list rendering "16" where the answer said "165",
 * because the digits streamed in one at a time and the prefix was cached at the
 * intermediate value.
 *
 * The check is deliberately "every prefix, byte for byte" rather than a few
 * hand-picked inputs: the failure is a race against where the delta boundary
 * happens to fall, so it is only visible when all of them are tried.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

/** Absolute, because esbuild resolves a temp-dir entry relative to that temp dir. */
const SOURCE = join(import.meta.dirname, '../src/utils/incremental-markdown.ts')

/** Bundles the real source so the checks run against what ships, not a copy. */
async function loadModule() {
  const dir = mkdtempSync(join(tmpdir(), 'verify-incr-'))
  const entry = join(dir, 'entry.mjs')
  const outfile = join(dir, 'bundle.mjs')
  const ENTRY
    = `export { renderIncremental, resetIncrementalRender } from ${JSON.stringify(SOURCE)}\n`

  const { writeFileSync } = await import('node:fs')

  writeFileSync(entry, ENTRY)

  await build({
    absWorkingDir: process.cwd(),
    bundle: true,
    entryPoints: [entry],
    format: 'esm',
    logLevel: 'silent',
    outfile,
    platform: 'node',
    target: 'node18',
  })

  const mod = await import(`file://${outfile}`)

  return { mod, cleanup: () => rmSync(dir, { force: true, recursive: true }) }
}

const CASES = [
  {
    name: '递增数字列表（设备上出现 165 被截断为 16 的场景）',
    text: 'Here is a list:\n\n1\n2\n...\n164\n165\n166\n167\n',
  },
  {
    name: '单个递增数字（无空行，纯数字逐字流入）',
    text: '1000000\n2000000\n3000000\n',
  },
  {
    name: '段落 + 代码块 + 列表',
    text: 'Intro paragraph.\n\n```js\nconst value = 12345\n```\n\n- item one\n- item two\n',
  },
  {
    name: '表格中的数字逐字流入',
    text: '| n | value |\n| --- | --- |\n| 1 | 100 |\n| 2 | 200 |\n',
  },
  {
    name: '带编号的有序列表',
    text: '1. alpha\n2. beta\n3. gamma\n',
  },
]

let failures = 0

for (const testCase of CASES) {
  const { mod, cleanup } = await loadModule()

  try {
    // Render the whole text in one go: the reference the incremental path must
    // match at the end of the stream.
    mod.resetIncrementalRender()
    const { html: expected } = mod.renderIncremental(testCase.text, { reset: true })

    // Replay the same text one character at a time, the way deltas arrive.
    mod.resetIncrementalRender()
    let actual = ''

    for (let i = 1; i <= testCase.text.length; i += 1) {
      const prefix = testCase.text.slice(0, i)

      actual = mod.renderIncremental(prefix).html
    }

    if (actual === expected) {
      console.log(`PASS ${testCase.name}`)
    }
    else {
      failures += 1
      console.log(`FAIL ${testCase.name}`)
      console.log(`  流式结果与整段渲染不一致`)

      const at = firstDifference(actual, expected)

      console.log(`  首个差异位置 ${at}:`)
      console.log(`    流式: ${JSON.stringify(actual.slice(Math.max(at - 40, 0), at + 40))}`)
      console.log(`    整段: ${JSON.stringify(expected.slice(Math.max(at - 40, 0), at + 40))}`)
    }
  }
  finally {
    cleanup()
  }
}

/** Index of the first differing character, or -1 when one is a prefix of the other. */
function firstDifference(a, b) {
  const max = Math.max(a.length, b.length)

  for (let i = 0; i < max; i += 1) {
    if (a[i] !== b[i]) {
      return i
    }
  }

  return -1
}

if (failures > 0) {
  console.log(`\n${failures} case(s) failed.`)
  process.exit(1)
}

console.log('\nAll cases passed.')
