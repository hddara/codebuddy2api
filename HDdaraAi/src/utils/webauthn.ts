/**
 * WebAuthn bridging for passkey registration.
 *
 * Kept away from the API module because it does not talk to the gateway at all:
 * it is the browser half of the ceremony, and the awkward half. The browser
 * speaks `ArrayBuffer`, the server speaks base64url, and every field that has to
 * cross between them needs the same conversion — which is why this is one file
 * rather than a handful of helpers inlined at the call site.
 *
 * Platform support is a real limit, not a formality. WebAuthn is a browser API:
 * it exists on H5, and it does not exist inside the App webview or the WeChat
 * miniprogram runtime. Those builds must be told so instead of being offered a
 * button that fails when pressed.
 */

/** Whether this build can run a WebAuthn ceremony at all. */
export function canUseWebAuthn(): boolean {
  return (
    typeof navigator !== 'undefined'
    && typeof navigator.credentials?.create === 'function'
  )
}

/** The catalogue key for why registration is unavailable. */
export type WebAuthnBlockedKey
  = | 'account.insecureOrigin'
    | 'account.unsupportedPlatform'

/**
 * Why registration is unavailable, or `null` when it is available.
 *
 * Returns a translation key rather than a sentence: this module has no access to
 * `useI18n()` (it is not a component), and importing the module-level translator
 * would freeze the message at whatever locale was active when it loaded.
 *
 * The two reasons are kept distinct because they call for different actions — a
 * platform without the API cannot be fixed by the user, while an insecure origin
 * can. The gateway refuses plain-HTTP registration anyway, so naming the cause
 * here turns a server-side 400 into something actionable.
 */
export function webAuthnUnsupportedReason(): WebAuthnBlockedKey | null {
  if (!canUseWebAuthn()) {
    return 'account.unsupportedPlatform'
  }

  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return 'account.insecureOrigin'
  }

  return null
}

/**
 * base64url → bytes.
 *
 * `atob` rejects the URL-safe alphabet, so the two substitutions are required
 * rather than cosmetic. Padding is restored because `atob` rejects unpadded
 * input and the server strips it.
 */
export function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  const bytes = new Uint8Array(binary.length)

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }

  return bytes
}

/** bytes → base64url, the encoding the server's verifier expects. */
export function bytesToBase64Url(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes)
  let binary = ''

  for (let i = 0; i < view.length; i++) {
    binary += String.fromCharCode(view[i])
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The subset of the server's creation options this app consumes. */
export interface RegistrationOptionsJson {
  challenge: string
  rp: { id?: string, name: string }
  user: { displayName: string, id: string, name: string }
  pubKeyCredParams: PublicKeyCredentialParameters[]
  attestation?: AttestationConveyancePreference
  authenticatorSelection?: AuthenticatorSelectionCriteria
  excludeCredentials?: { id: string, transports?: AuthenticatorTransport[], type?: string }[]
  timeout?: number
}

/**
 * Rebuilds the wire format into the object `navigator.credentials.create` wants.
 *
 * Only the fields listed above are converted; anything else the server sends is
 * dropped rather than guessed at. A field the browser does not understand is
 * harmless, but a mistyped one is a silent failure inside the authenticator,
 * which reports nothing useful.
 */
export function toCreationOptions(
  json: RegistrationOptionsJson,
): PublicKeyCredentialCreationOptions {
  return {
    attestation: json.attestation ?? 'none',
    authenticatorSelection: json.authenticatorSelection,
    challenge: base64UrlToBytes(json.challenge) as unknown as BufferSource,
    excludeCredentials: (json.excludeCredentials ?? []).map(item => ({
      id: base64UrlToBytes(item.id) as unknown as BufferSource,
      transports: item.transports,
      type: 'public-key' as PublicKeyCredentialType,
    })),
    pubKeyCredParams: json.pubKeyCredParams,
    rp: json.rp,
    timeout: json.timeout,
    user: {
      displayName: json.user.displayName,
      id: base64UrlToBytes(json.user.id) as unknown as BufferSource,
      name: json.user.name,
    },
  }
}

/**
 * The attestation the server's verifier consumes.
 *
 * `getTransports()` is optional in the spec and absent in older WebKit builds,
 * so it is called defensively — a throw here would lose an otherwise valid
 * registration that the authenticator has already created.
 */
export function toRegistrationResponse(
  credential: PublicKeyCredential,
): Record<string, unknown> {
  const response = credential.response as AuthenticatorAttestationResponse

  return {
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    response: {
      attestationObject: bytesToBase64Url(response.attestationObject),
      clientDataJSON: bytesToBase64Url(response.clientDataJSON),
      transports:
        typeof response.getTransports === 'function'
          ? response.getTransports()
          : [],
    },
    type: credential.type,
  }
}

/**
 * Distinguishes "the user declined" from "something went wrong".
 *
 * Cancelling is the common outcome — it is what happens when the sheet is
 * dismissed — and reporting it as an error trains users to ignore the message
 * that matters. `NotAllowedError` covers both cancellation and timeout; they are
 * indistinguishable by design, and neither is a fault.
 */
export function isUserCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === 'NotAllowedError'
}

/**
 * Runs the ceremony. Separated from the network calls so the two halves can be
 * reasoned about — and tested — independently.
 */
export async function createPasskeyCredential(
  options: RegistrationOptionsJson,
): Promise<Record<string, unknown>> {
  const credential = (await navigator.credentials.create({
    publicKey: toCreationOptions(options),
  })) as PublicKeyCredential | null

  if (!credential) {
    throw new Error('浏览器未返回通行密钥')
  }

  return toRegistrationResponse(credential)
}
