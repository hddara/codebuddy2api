/// <reference types="vite/client" />

/**
 * Compile-time values injected by `vite.config.mts`.
 *
 * Declared here because they are bare globals, not `import.meta.env` entries:
 * `utils/app-info.ts` reads them directly, and without a declaration the type
 * checker (and only the type checker — Vite substitutes them at build time)
 * reports them as undefined names.
 */
declare const __APP_VERSION__: string
declare const __APP_VERSION_CODE__: string

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
  readonly VITE_HEALTH_PATH?: string
  readonly VITE_PORT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
