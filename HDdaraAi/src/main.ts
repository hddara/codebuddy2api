import { createPinia } from 'pinia'
import { createSSRApp } from 'vue'

import App from './App.vue'

import { i18n } from './locales'
import { persistPlugin } from './store/persist'
import { THEME_CLASS, useThemeStore } from './store/themeStore'
import 'uno.css'

export function createApp() {
  const app = createSSRApp(App)
  const pinia = createPinia()

  // Persist stores across cold starts (auth credentials especially).
  // `persistPlugin` owns the exclusion list itself, so it takes only the context.
  pinia.use(persistPlugin)
  app.use(pinia)

  // Before the mixin below, so a translation used during the first render
  // resolves rather than warning.
  app.use(i18n)

  /**
   * Gives every component the resolved theme's class name.
   *
   * A global mixin rather than a per-page import because the alternative is
   * twelve identical `const themeClass = ...` blocks, and the thirteenth page
   * someone adds would not have one — the theme would silently not apply there,
   * which is the kind of bug nobody reports as a bug ("this screen looks
   * different").
   *
   * The store is resolved inside the computed, not at mixin installation:
   * `createApp` runs before the app is mounted, and `useThemeStore()` outside a
   * component context would bind to no active pinia.
   */
  app.mixin({
    computed: {
      themeClass(): string {
        return THEME_CLASS[useThemeStore().resolved]
      },
    },
  })

  return { app }
}
