/**
 * English.
 *
 * Mirrors `zh-CN.ts` key for key. Kept as a typed object so a missing key is a
 * compile error rather than a string that renders as its own key at runtime —
 * which is how a half-finished translation reaches production unnoticed.
 */
import type zhCN from './zh-CN'

export default {
  common: {
    cancel: 'Cancel',
    confirm: 'Confirm',
    copy: 'Copy',
    delete: 'Delete',
    edit: 'Edit',
    retry: 'Retry',
    save: 'Save',
    saving: 'Saving…',
  },

  settings: {
    appearance: 'Appearance',
    followSystem: 'Follow system',
    light: 'Light',
    dark: 'Dark',
    followSystemHintPrefix: 'Following the system — currently ',
    followSystemHintSuffix: '.',
    fixedHint: 'Fixed; does not follow the system.',
    themeDark: 'dark',
    themeLight: 'light',
    title: 'Settings',
  },

  account: {
    title: 'Account',
    passkeys: 'Passkeys',
    addPasskey: 'Add a passkey',
    passkeyName: 'Name (optional)',
    passkeyNamePlaceholder: 'For example: My iPhone',
    passkeyNameHint:
      'Left blank, it is numbered. The name is what tells this account\'s passkeys apart.',
    passkeyStart: 'Start',
    passkeyRegistering: 'Registering…',
    passkeyEmpty: 'No passkeys yet',
    passkeyEmptyHint:
      'Once registered, you can sign in with your fingerprint or face — no password.',
    passkeyCancelled: 'Registration cancelled',
    passkeyRegisteredPrefix: 'Registered "',
    passkeyRegisteredSuffix: '"',
    passkeyFailed: 'Could not register the passkey',
    unsupportedPlatform:
      'This platform does not support passkeys. Open the app in a browser and try again.',
    insecureOrigin: 'Passkeys need HTTPS or localhost.',
  },
} satisfies typeof zhCN
