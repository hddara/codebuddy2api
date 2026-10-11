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
 * Pulls the palette out of `src/styles/tokens.scss` so there is exactly one
 * place a colour is written down.
 *
 * The two used to be maintained by hand and drifted: an accent change meant
 * editing both files and there was nothing to make you notice if you forgot.
 * Reading the SCSS directly makes the mirror impossible to get wrong.
 */
function readTokenColors(): Record<string, string> {
  const here = dirname(fileURLToPath(import.meta.url))
  const scss = readFileSync(resolve(here, 'src/styles/tokens.scss'), 'utf8')
  const palette: Record<string, string> = {}

  for (const match of scss.matchAll(/^\$color-([a-z-]+):\s*(#[0-9a-fA-F]{3,8});/gm)) {
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
