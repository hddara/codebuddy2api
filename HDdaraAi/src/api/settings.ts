import { consoleGet, consolePost } from './core/console'

/**
 * The gateway's own runtime configuration.
 *
 * Everything here changes how the gateway behaves for *all* clients, not just
 * this app — which is why the screens that expose it are worded as gateway
 * settings and put behind their own page rather than mixed into the app's
 * local preferences.
 *
 * The app reads the whole set and writes back only the keys a screen touched.
 * `updateSettings` on the server merges key-by-key, so a partial body leaves
 * everything else alone; sending the full object would be a way for a stale
 * screen to silently revert a change made elsewhere.
 */

/** Every runtime key the gateway persists, as the API reports them. */
export interface GatewaySettings {
  CODEBUDDY_API_ENDPOINT: string
  CODEBUDDY_ADMIN_PASSKEY_RP_ID: string
  CODEBUDDY_AUTH_MODE: string
  CODEBUDDY_AUTO_CHECKIN_ENABLED: string
  CODEBUDDY_AUTO_CHECKIN_TIME: string
  CODEBUDDY_CREDENTIAL_LIMIT_HOURS: string
  CODEBUDDY_INTERNET_ENVIRONMENT: string
  CODEBUDDY_LOG_LEVEL: string
}

/** Human labels per key, in the locale the console reports. */
export type GatewaySettingLabels = Partial<Record<keyof GatewaySettings, string>>

export interface GatewaySettingsPayload {
  labels: GatewaySettingLabels
  settings: GatewaySettings
}

/** Reads the current configuration and its labels. */
export async function fetchGatewaySettings(): Promise<GatewaySettingsPayload> {
  return consoleGet<GatewaySettingsPayload>('/admin-api/settings')
}

/**
 * Writes a subset of the configuration.
 *
 * Partial by design: the server merges into the stored config, so a screen that
 * only edited the check-in time does not have to know or restate the log level.
 */
export async function saveGatewaySettings(
  patch: Partial<Record<keyof GatewaySettings, string>>,
): Promise<GatewaySettings> {
  const payload = await consolePost<{ settings: GatewaySettings }>(
    '/admin-api/settings',
    { settings: patch },
  )

  return payload.settings
}

/**
 * The keys worth surfacing on a phone, with the control each one needs.
 *
 * Not the whole config: `CODEBUDDY_API_ENDPOINT` and the passkey relying-party
 * id are the kind of thing that, set wrongly from a phone, locks the console out
 * of its own domain — they stay in the web console. What is left is the set a
 * user actually adjusts day to day.
 */
export type SettingControl = 'switch' | 'text' | 'time' | 'select'

export interface SettingField {
  control: SettingControl
  /** Value that disables everything else in the group, when there is one. */
  dependsOn?: { key: keyof GatewaySettings, value: string }
  hint: string
  key: keyof GatewaySettings
  /** Required for `select`; the choices, each with its own label. */
  options?: Array<{ label: string, value: string }>
  placeholder?: string
}

export const EDITABLE_SETTING_FIELDS: SettingField[] = [
  {
    control: 'switch',
    hint: '开启后网关会在指定时间自动为所有上游账号签到。',
    key: 'CODEBUDDY_AUTO_CHECKIN_ENABLED',
  },
  {
    control: 'time',
    dependsOn: { key: 'CODEBUDDY_AUTO_CHECKIN_ENABLED', value: 'true' },
    hint: '服务器本地时间，格式 HH:mm。',
    key: 'CODEBUDDY_AUTO_CHECKIN_TIME',
    placeholder: '09:00',
  },
  {
    control: 'text',
    hint: '账号被上游限流后，超过这个时长自动解除并重新参与轮询。',
    key: 'CODEBUDDY_CREDENTIAL_LIMIT_HOURS',
    placeholder: '24',
  },
  {
    control: 'select',
    hint: '上游接口的环境。内网环境需要能访问腾讯内网。',
    key: 'CODEBUDDY_INTERNET_ENVIRONMENT',
    options: [
      { label: '公网', value: 'public' },
      { label: '内网', value: 'internal' },
      { label: 'IOA', value: 'ioa' },
    ],
  },
  {
    control: 'select',
    hint: '写入服务端日志的详细程度，排查问题时调高。',
    key: 'CODEBUDDY_LOG_LEVEL',
    options: [
      { label: '错误', value: 'error' },
      { label: '警告', value: 'warn' },
      { label: '信息', value: 'info' },
      { label: '调试', value: 'debug' },
    ],
  },
]

/**
 * Reads a switch value.
 *
 * The gateway stores these as the strings `'true'`/`'false'` because the whole
 * config is persisted as a flat string map. Treating the raw string as truthy
 * would make `'false'` mean on, which is the kind of bug that survives testing.
 */
export function isSettingEnabled(value: string | undefined): boolean {
  return String(value ?? '').trim().toLowerCase() === 'true'
}

/** Renders a boolean switch back into the stored string form. */
export function settingFlag(enabled: boolean): string {
  return enabled ? 'true' : 'false'
}

/**
 * Whether a field should be editable right now.
 *
 * A dependent field (`自动签到时间`) is only meaningful while its switch is on;
 * leaving it enabled would let a user set a time that nothing reads.
 */
export function isSettingEditable(
  field: SettingField,
  settings: GatewaySettings,
): boolean {
  if (!field.dependsOn) {
    return true
  }

  return settings[field.dependsOn.key] === field.dependsOn.value
}
