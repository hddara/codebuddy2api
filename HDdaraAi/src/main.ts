import { createPinia } from 'pinia'
import { createSSRApp } from 'vue'

import App from './App.vue'

import { persistPlugin } from './store/persist'
import 'uno.css'

export function createApp() {
  const app = createSSRApp(App)
  const pinia = createPinia()

  // Persist stores across cold starts (auth credentials especially).
  // `persistPlugin` owns the exclusion list itself, so it takes only the context.
  pinia.use(persistPlugin)
  app.use(pinia)

  return { app }
}
