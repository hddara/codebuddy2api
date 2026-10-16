/**
 * Component properties injected at runtime rather than written in each page.
 *
 * A separate file from `env.d.ts` on purpose: that one is a global script, and
 * adding an `import`/`export` to it would turn it into a module — after which
 * its `declare const __APP_VERSION__` would no longer be global and
 * `utils/app-info.ts` would stop compiling.
 *
 * `themeClass` comes from the global mixin in `main.ts`. Declared because a
 * mixin is invisible to the template type checker: every page binding
 * `:class="themeClass"` would otherwise fail to compile while rendering fine.
 */

export {}

/**
 * Vue ships two type entry points and which one a project resolves depends on
 * its module settings — this one resolves `vue.d.mts`, so augmenting only
 * `'vue'` silently does nothing and every page reports the property as missing.
 * Both are declared to be independent of that choice.
 *
 * `@vue/runtime-core` is the package that actually owns
 * `ComponentCustomProperties`; augmenting it as well keeps the declaration
 * correct if the resolver ever prefers the loose entry.
 */
declare module 'vue' {
  interface ComponentCustomProperties {
    /** The resolved colour theme's class name; see `store/themeStore.ts`. */
    themeClass: string
  }
}

declare module '@vue/runtime-core' {
  interface ComponentCustomProperties {
    /** The resolved colour theme's class name; see `store/themeStore.ts`. */
    themeClass: string
  }
}
