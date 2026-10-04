import path from 'node:path';
import process from 'node:process';

import UniComponents from '@uni-helper/vite-plugin-uni-components';
import UniLayouts from '@uni-helper/vite-plugin-uni-layouts';
import UniManifest from '@uni-helper/vite-plugin-uni-manifest';
import UniPages from '@uni-helper/vite-plugin-uni-pages';
import UnoCSS from 'unocss/vite';
import AutoImport from 'unplugin-auto-import/vite';
import { defineConfig, loadEnv } from 'vite';

import uniPlugin from '@dcloudio/vite-plugin-uni';

// `@dcloudio/vite-plugin-uni` ships CommonJS, so under ESM the callable lives on
// `.default`. Create a fresh instance rather than reusing the module export.
const Uni = (
  (uniPlugin as unknown as { default?: () => unknown }).default ?? uniPlugin
) as () => unknown;

const root = path.resolve(__dirname, 'src');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd());

  return {
    envPrefix: 'VITE_',
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
  };
});
