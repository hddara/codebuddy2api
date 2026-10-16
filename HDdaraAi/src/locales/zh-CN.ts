/**
 * Simplified Chinese — the source language.
 *
 * The app's copy was written in Chinese and is only now being made
 * translatable, so this file is the original wording rather than a translation
 * of it. Keys are grouped by where they appear, not by grammatical role, because
 * a translator needs to see that two strings live on the same screen to keep them
 * consistent — which a flat list loses.
 *
 * Deliberately **not** `as const`: that would give every value a literal type,
 * and `en.ts`'s `satisfies typeof zhCN` would then demand the English
 * translation read `'取消'`. The shape is what should be shared, not the words.
 *
 * Only the first slice is extracted so far. The rest is still inline in the
 * pages — see the note in `index.ts` for why that is a deliberate staging point
 * rather than an unfinished job.
 */
export default {
  common: {
    cancel: '取消',
    confirm: '确认',
    copy: '复制',
    delete: '删除',
    edit: '编辑',
    retry: '重试',
    save: '保存',
    saving: '保存中…',
  },

  settings: {
    appearance: '外观',
    followSystem: '跟随系统',
    light: '浅色',
    dark: '深色',
    // Split around the theme name instead of a `{theme}` placeholder. The App
    // build resolves vue-i18n to its runtime-only entry, which cannot compile
    // message syntax — a placeholder renders literally as `{theme}` there while
    // working on H5. Concatenating in JS needs no compiler on any target.
    followSystemHintPrefix: '跟随系统，当前为',
    followSystemHintSuffix: '。',
    fixedHint: '已固定，不随系统变化。',
    themeDark: '深色',
    themeLight: '浅色',
    title: '设置',
  },

  account: {
    title: '账户管理',
    passkeys: '通行密钥',
    addPasskey: '添加通行密钥',
    passkeyName: '名称（可选）',
    passkeyNamePlaceholder: '例如：我的 iPhone',
    passkeyNameHint: '留空时按顺序命名。同一账号的多个通行密钥靠它区分。',
    passkeyStart: '开始注册',
    passkeyRegistering: '注册中…',
    passkeyEmpty: '还没有通行密钥',
    passkeyEmptyHint: '注册后可以用指纹或面容直接登录，无需输入密码。',
    passkeyCancelled: '已取消注册',
    // Bracketed by concatenation for the same reason as `followSystemHint`:
    // the App build has no message compiler, so `{name}` would show verbatim.
    passkeyRegisteredPrefix: '已注册「',
    passkeyRegisteredSuffix: '」',
    passkeyFailed: '注册通行密钥失败',
    unsupportedPlatform: '当前平台不支持通行密钥，请在浏览器中打开后重试。',
    insecureOrigin: '通行密钥需要在 HTTPS 或 localhost 下使用。',
  },
}
