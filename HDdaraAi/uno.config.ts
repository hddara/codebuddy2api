import { presetUni } from '@uni-helper/unocss-preset-uni'
import {
  defineConfig,
  presetIcons,
  transformerDirectives,
  transformerVariantGroup,
} from 'unocss'

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
    colors: {
      primary: '#0A84FF',
      success: '#22A06B',
      danger: '#CF1322',
    },
  },
  shortcuts: {
    // presetUni maps text-N to N x 8rpx, so `text-2` is ~16rpx and unreadable on
    // a phone. Raise it to the minimum comfortable size.
    'text-2': 'text-22rpx',
  },
})
