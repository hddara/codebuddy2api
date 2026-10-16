import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { presetUni } from '@uni-helper/unocss-preset-uni'
import {
  defineConfig,
  presetIcons,
  transformerDirectives,
  transformerVariantGroup,
} from 'unocss'

/**
 * Pulls the palette out of `src/styles/theme.scss` so there is exactly one
 * place a colour is written down.
 *
 * Read from the theme file rather than `tokens.scss` because that is where the
 * values now live: the SCSS names there are `var()` aliases, which UnoCSS cannot
 * turn into a utility class — a `bg-surface` that resolved to `var(--c-surface)`
 * would look right in the editor and produce nothing in the build.
 *
 * Only the light block is read. UnoCSS generates static class rules, so it
 * cannot express "varies by theme"; the dark values reach the page through the
 * custom properties themselves, which the utilities reference.
 */
function readTokenColors(): Record<string, string> {
  const here = dirname(fileURLToPath(import.meta.url))
  const scss = readFileSync(resolve(here, 'src/styles/theme.scss'), 'utf8')

  // The light block is the first one; stop at the dark selector so a name that
  // only exists in dark cannot leak a wrong value into the light palette.
  const lightBlock = scss.split('.theme-dark')[0]
  const palette: Record<string, string> = {}

  for (const match of lightBlock.matchAll(/--c-([a-z-]+):\s*(#[0-9a-fA-F]{3,8});/g)) {
    const [, name, value] = match

    // `primary-active` becomes `primaryActive`: utility class names cannot carry
    // a dash inside a colour key without being split as a variant.
    const key = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

    palette[key] = value
  }

  return palette
}

/**
 * UnoCSS configuration.
 *
 * `presetIcons` declares its icon collections explicitly, which **turns off
 * automatic loading of every other collection**: any `i-<set>:<name>` class
 * whose set is missing here silently renders empty (the build still succeeds and
 * only logs `failed to load icon`). Register a set here before using it.
 */
export default defineConfig({
  content: {
    pipeline: {
      include: [/\.(vue|nvue|[jt]sx|ts|mdx?|html)($|\?)/],
    },
  },
  presets: [
    presetUni({
      attributify: {
        prefixedOnly: true,
      },
    }),
    presetIcons({
      scale: 1.2,
      warn: true,
      extraProperties: {
        'display': 'inline-block',
        'vertical-align': 'middle',
      },
      collections: {
        carbon: () =>
          import('@iconify-json/carbon/icons.json', {
            with: { type: 'json' },
          }).then(icons => icons.default),
      },
    }),
  ],
  transformers: [transformerDirectives(), transformerVariantGroup()],
  theme: {
    colors: readTokenColors(),
  },
  shortcuts: {
    // presetUni maps text-N to N x 8rpx, so `text-2` is ~16rpx and unreadable on
    // a phone. Raise it to the minimum comfortable size.
    'text-2': 'text-22rpx',
  },
})
