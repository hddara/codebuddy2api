#!/usr/bin/env node
/**
 * Exercises the manual-base-URL recovery path against the real source.
 *
 * Why this exists as a script rather than a unit test: the mobile project has no
 * test runner, and the logic under test only misbehaves in the App runtime —
 * `uni.request` and `uni.getStorageSync` are injected globals with no DOM
 * equivalent. The script stubs exactly those two, bundles `base-url.ts` with
 * esbuild (unminified, so the exported names survive), and drives
 * `resolveApiBaseUrl()` through the failure observed on a device: a stale
 * `http://127.0.0.1:8097` left over from a local dev session, which used to be
 * adopted unconditionally and made every request fail forever.
 *
 * Scenarios:
 *   1. stored address answers             -> adopted, no candidate scan
 *   2. stored address is dead             -> automatic pipeline takes over
 *   3. no stored address                  -> automatic pipeline runs directly
 *   4. dead address, remote config absent -> falls back to the compiled-in origin
 *   5. a running session keeps failing    -> the address is dropped mid-session
 *
 * Usage:
 *   node scripts/verify-base-url-fallback.mjs
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const entry = resolve(here, '../src/api/core/base-url.ts')
const outfile = resolve(here, '../dist/.verify-base-url.mjs')

const PRODUCTION = 'https://code.apimesh.cn'
const STALE = 'http://127.0.0.1:8097'

/**
 * Bundles the module under test.
 *
 * `define` mirrors what Vite substitutes at build time, so the module sees the
 * same compile-time origin it ships with. The `@/` alias is resolved through a
 * plugin rather than rewriting imports in the source.
 */
async function bundle() {
  await build({
    alias: { '@': resolve(here, '../src') },
    bundle: true,
    define: {
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify(PRODUCTION),
      'import.meta.env.VITE_API_BASE_URLS': JSON.stringify(PRODUCTION),
      'import.meta.env.VITE_HEALTH_PATH': JSON.stringify('/health'),
      'import.meta.env.VITE_REMOTE_CONFIG_URL': JSON.stringify(
        `${PRODUCTION}/.well-known/hdara-ai-endpoints.json`,
      ),
    },
    entryPoints: [entry],
    format: 'esm',
    logLevel: 'silent',
    minify: false,
    outfile,
    platform: 'neutral',
    target: 'es2022',
  })

  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)
}

/**
 * Minimal `uni` stub. `behaviour` decides what each origin answers:
 *   'ok'     -> 200 with a JSON body (the probe passes)
 *   'html'   -> 200 with an HTML string (the ngrok interstitial; probe fails)
 *   'refuse' -> transport failure
 */
function makeUni({ behaviour = () => 'ok', log = [], storage = {} }) {
  return {
    getStorageSync: key => (key in storage ? storage[key] : ''),
    removeStorageSync: (key) => {
      delete storage[key]
      log.push(`removeStorage:${key}`)
    },
    request: ({ fail, success, url }) => {
      let origin = url

      try {
        origin = new URL(url).origin
      }
      catch {
        // Relative probe paths are resolved against the current base; keeping
        // the raw value makes the log line readable.
      }

      const mode = behaviour(origin, url)
      log.push(`request:${origin}${mode === 'ok' ? '' : `(${mode})`}`)

      queueMicrotask(() => {
        if (mode === 'refuse') {
          fail({ errMsg: 'request:fail abort statusCode:-1 Failed to connect' })

          return
        }

        success({
          data: mode === 'ok' ? { status: 'healthy' } : '<!DOCTYPE html>',
          statusCode: 200,
        })
      })
    },
    setStorage: () => {},
    setStorageSync: () => {},
  }
}

/** Fresh `uni` per scenario, then a fresh module instance to match. */
async function loadScenario(uni) {
  delete globalThis.uni
  globalThis.uni = uni

  return bundle()
}

const scenarios = [
  {
    expect: STALE,
    name: '存的是可达地址 -> 直接采用，不扫描候选',
    setup: () => ({
      behaviour: origin => (origin === STALE ? 'ok' : 'refuse'),
      storage: { auth: JSON.stringify({ baseUrl: STALE }) },
    }),
  },
  {
    expect: PRODUCTION,
    name: '存的是失效地址 (127.0.0.1:8097) -> 自动回退到生产地址',
    setup: () => ({
      behaviour: origin => (origin === PRODUCTION ? 'ok' : 'refuse'),
      storage: { auth: JSON.stringify({ baseUrl: STALE }) },
    }),
  },
  {
    expect: PRODUCTION,
    name: '未存地址 -> 直接走自动选路',
    setup: () => ({
      behaviour: origin => (origin === PRODUCTION ? 'ok' : 'refuse'),
      storage: {},
    }),
  },
  {
    expect: PRODUCTION,
    name: '存的是失效地址 + 无远端配置 -> 回退到编译期内置地址',
    setup: () => ({
      behaviour: origin => (origin === PRODUCTION ? 'ok' : 'refuse'),
      storage: { auth: JSON.stringify({ baseUrl: STALE }) },
    }),
  },
]

let failed = 0

const report = (ok, name, detail) => {
  if (!ok) {
    failed += 1
  }

  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)

  for (const line of detail) {
    console.log(`     ${line}`)
  }
}

for (const scenario of scenarios) {
  const log = []
  const api = await loadScenario(makeUni({ log, ...scenario.setup() }))
  const actual = await api.resolveApiBaseUrl()
  const detail = [`resolved = ${actual}`, `calls    = ${log.join(' -> ') || '(none)'}`]

  if (actual !== scenario.expect) {
    detail.push(`expected = ${scenario.expect}`)
  }

  report(actual === scenario.expect, scenario.name, detail)
}

// Recovery must also be reachable from a running session, not only a cold
// start: the device was already up and failing when the problem was observed.
{
  const log = []
  const api = await loadScenario(
    makeUni({
      behaviour: origin => (origin === PRODUCTION ? 'ok' : 'refuse'),
      log,
      storage: { auth: JSON.stringify({ baseUrl: STALE }) },
    }),
  )

  await api.resolveApiBaseUrl()
  // A screenful of requests failing against the adopted stale address.
  for (let i = 0; i < 6; i += 1) {
    api.reportApiFailure('network', 'simulated failure')
  }

  const after = api.getApiBaseUrl()

  report(after === PRODUCTION, '运行期持续失败 -> 也会放弃失效地址', [
    `resolved = ${after}`,
    `expected = ${PRODUCTION}`,
  ])
}

if (failed) {
  console.error(`\n${failed} scenario(s) failed`)
  process.exit(1)
}

console.log('\nAll scenarios passed.')
