import { createPinia } from 'pinia'
import { createSSRApp } from 'vue'

import App from './App.vue'

import { persistPlugin } from './store/persist'
import 'uno.css'

export function createApp() {
  const app = createSSRApp(App)
  const pinia = createPinia()

  // Persist stores across cold starts (auth credentials especially).
  pinia.use(context => persistPlugin(context, []))
  app.use(pinia)

  return { app }
}
