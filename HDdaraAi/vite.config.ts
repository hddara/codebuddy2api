import path from 'node:path'
import process from 'node:process'

import uniPlugin from '@dcloudio/vite-plugin-uni'
import UniComponents from '@uni-helper/vite-plugin-uni-components'
import UniLayouts from '@uni-helper/vite-plugin-uni-layouts'
import UniManifest from '@uni-helper/vite-plugin-uni-manifest'
import UniPages from '@uni-helper/vite-plugin-uni-pages'
import UnoCSS from 'unocss/vite'
import AutoImport from 'unplugin-auto-import/vite'

import { defineConfig, loadEnv } from 'vite'

import manifest from './manifest.config'

// `@dcloudio/vite-plugin-uni` ships CommonJS, so under ESM the callable lives on
// `.default`. Create a fresh instance rather than reusing the module export.
const Uni = (
  (uniPlugin as unknown as { default?: () => unknown }).default ?? uniPlugin
) as () => unknown

const root = path.resolve(__dirname, 'src')

// `utils/app-info.ts` reads these as bare globals. Without the defines below the
// reference throws, and because `getAppVersion()` runs inside the request
// interceptor that would break every API call. Sourcing them from the manifest
// keeps the version the settings page shows and the one it reports identical.
const appVersion = String(
  (manifest as { versionName?: string }).versionName ?? '0.0.0',
)
const appVersionCode = String(
  (manifest as { versionCode?: string | number }).versionCode ?? '0',
)

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd())

  return {
    envPrefix: 'VITE_',
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      __APP_VERSION_CODE__: JSON.stringify(appVersionCode),
    },
    plugins: [
      // `pages.config.ts` is the source of truth; `src/pages.json` is generated.
      UniPages({ dts: 'src/uni-pages.d.ts' }),
      UniLayouts(),
      UniManifest(),
      UniComponents({ dts: 'src/components.d.ts' }),
      AutoImport({
        dts: 'src/auto-imports.d.ts',
        imports: ['vue', 'pinia', 'uni-app'],
      }),
      UnoCSS(),
      Uni(),
    ],
    resolve: {
      alias: {
        '@': root,
      },
    },
    server: {
      port: Number(env.VITE_PORT) || 8901,
      host: true,
    },
  }
})
