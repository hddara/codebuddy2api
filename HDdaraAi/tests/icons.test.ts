import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Guards every `i-carbon:*` class against a name the icon set does not have.
 *
 * Why this is a test and not a build check: `presetIcons` turns a missing name
 * into **silent emptiness**. The build succeeds, the layout reserves the space,
 * and the only trace is a `failed to load icon` line in the output that nobody
 * reads on a green run. A typo therefore ships as a blank square — which is how
 * `i-carbon:radio-push` (the real name is `radio-push-to-talk`) very nearly
 * went out.
 *
 * The class is also not checkable by eye: several plausible names are absent and
 * several present ones are surprising, so the set is the only authority.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

/** Reads the carbon icon names, following the pnpm store layout. */
function loadIconNames(): Set<string> {
  const candidates = [
    join(ROOT, 'node_modules/@iconify-json/carbon/icons.json'),
    ...safeReaddir(join(ROOT, 'node_modules/.pnpm'))
      .filter(entry => entry.startsWith('@iconify-json+carbon@'))
      .map(entry =>
        join(
          ROOT,
          'node_modules/.pnpm',
          entry,
          'node_modules/@iconify-json/carbon/icons.json',
        ),
      ),
  ]

  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        aliases?: Record<string, unknown>
        icons?: Record<string, unknown>
      }

      // Aliases count: `presetIcons` resolves them, so `i-carbon:copy` works
      // even when only an alias shares the name.
      return new Set([
        ...Object.keys(parsed.icons ?? {}),
        ...Object.keys(parsed.aliases ?? {}),
      ])
    }
    catch {
      // Try the next candidate.
    }
  }

  throw new Error('unable to locate @iconify-json/carbon/icons.json')
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path)
  }
  catch {
    return []
  }
}

/** Every source file under `src`, as absolute paths. */
function sourceFiles(dir: string): string[] {
  const found: string[] = []

  for (const entry of safeReaddir(dir)) {
    const path = join(dir, entry)

    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path))
      continue
    }

    if (/\.(?:vue|ts|tsx)$/.test(entry)) {
      found.push(path)
    }
  }

  return found
}

/** The `i-carbon:<name>` classes used across the source tree. */
function usedCarbonIcons(): Map<string, string[]> {
  const usage = new Map<string, string[]>()

  for (const file of sourceFiles(join(ROOT, 'src'))) {
    const contents = readFileSync(file, 'utf8')

    for (const match of contents.matchAll(/i-carbon:([a-z0-9-]+)/g)) {
      const name = match[1] ?? ''
      const where = usage.get(name) ?? []

      where.push(file.slice(ROOT.length + 1))
      usage.set(name, where)
    }
  }

  return usage
}

describe('carbon icons', () => {
  it('only names icons the set actually has', () => {
    const available = loadIconNames()
    const used = usedCarbonIcons()

    expect(used.size).toBeGreaterThan(0)

    const missing = [...used.entries()]
      .filter(([name]) => !available.has(name))
      .map(([name, where]) => `${name} (used in ${where.join(', ')})`)

    expect(missing).toEqual([])
  })

  it('finds the icon set, so the check above cannot pass vacuously', () => {
    // Without this the suite would still be green if the JSON moved, because an
    // empty set makes the comparison trivially unsatisfiable in the other
    // direction — this pins that the set is real and large.
    expect(loadIconNames().size).toBeGreaterThan(1_000)
  })
})
