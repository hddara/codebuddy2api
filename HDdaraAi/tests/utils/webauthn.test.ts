import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  base64UrlToBytes,
  bytesToBase64Url,
  canUseWebAuthn,
  createPasskeyCredential,
  isUserCancellation,
  toCreationOptions,
  toRegistrationResponse,
  webAuthnUnsupportedReason,
} from '@/utils/webauthn'

/**
 * The base64url round trip is where a ceremony fails silently: the server
 * verifies signatures over exact bytes, so a mangled encoding produces
 * "verification failed" with nothing pointing back here.
 */
describe('base64url encoding', () => {
  it('decodes the URL-safe alphabet', () => {
    // `-` and `_` are the two characters that differ from standard base64 and
    // `atob` rejects both; this string exercises each.
    expect(Array.from(base64UrlToBytes('-_8'))).toEqual([251, 255])
  })

  it('accepts unpadded input', () => {
    // The server strips padding, and `atob` throws without it.
    expect(base64UrlToBytes('YQ')).toEqual(base64UrlToBytes('YQ=='))
    expect(Array.from(base64UrlToBytes('YQ'))).toEqual([97])
  })

  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 254, 255])

    expect(Array.from(base64UrlToBytes(bytesToBase64Url(bytes.buffer)))).toEqual(
      Array.from(bytes),
    )
  })

  it('emits no padding and no unsafe characters', () => {
    // A `+` or `/` here would survive `JSON.stringify` and fail server-side.
    const encoded = bytesToBase64Url(new Uint8Array([251, 255, 190]).buffer)

    expect(encoded).not.toMatch(/[+/=]/)
  })
})

describe('platform detection', () => {
  const originalNavigator = globalThis.navigator

  afterEach(() => {
    vi.stubGlobal('navigator', originalNavigator)
    vi.unstubAllGlobals()
  })

  it('reports unsupported when the API is absent', () => {
    vi.stubGlobal('navigator', {})

    expect(canUseWebAuthn()).toBe(false)
    // A catalogue key, not a sentence: the probe runs outside a component and
    // has no translator. The page resolves it through `t()`.
    expect(webAuthnUnsupportedReason()).toBe('account.unsupportedPlatform')
  })

  it('reports unsupported without a secure context', () => {
    vi.stubGlobal('navigator', { credentials: { create: vi.fn() } })
    vi.stubGlobal('window', { isSecureContext: false })

    expect(canUseWebAuthn()).toBe(true)
    expect(webAuthnUnsupportedReason()).toBe('account.insecureOrigin')
  })

  it('reports available on a secure origin', () => {
    vi.stubGlobal('navigator', { credentials: { create: vi.fn() } })
    vi.stubGlobal('window', { isSecureContext: true })

    expect(webAuthnUnsupportedReason()).toBeNull()
  })
})

describe('toCreationOptions', () => {
  it('converts every byte field out of base64url', () => {
    const options = toCreationOptions({
      challenge: 'YQ',
      pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
      rp: { id: 'example.test', name: 'Gateway' },
      user: { displayName: 'admin', id: 'Yg', name: 'admin' },
    })

    expect(Array.from(options.challenge as Uint8Array)).toEqual([97])
    expect(Array.from(options.user.id as Uint8Array)).toEqual([98])
    expect(options.rp).toEqual({ id: 'example.test', name: 'Gateway' })
  })

  it('defaults attestation to none', () => {
    // The server requests `none`; omitting it lets a browser prompt for a
    // hardware key that this account has no use for.
    const options = toCreationOptions({
      challenge: 'YQ',
      pubKeyCredParams: [],
      rp: { name: 'G' },
      user: { displayName: 'a', id: 'Yg', name: 'a' },
    })

    expect(options.attestation).toBe('none')
  })

  it('tags excluded credentials as public-key', () => {
    // `excludeCredentials` is how the browser skips authenticators that are
    // already registered — a missing `type` makes the entry inert.
    const options = toCreationOptions({
      challenge: 'YQ',
      excludeCredentials: [{ id: 'YQ' }],
      pubKeyCredParams: [],
      rp: { name: 'G' },
      user: { displayName: 'a', id: 'Yg', name: 'a' },
    })

    expect(options.excludeCredentials?.[0].type).toBe('public-key')
    expect(Array.from(options.excludeCredentials![0].id as Uint8Array)).toEqual([97])
  })

  it('tolerates a server response with no excludeCredentials', () => {
    const options = toCreationOptions({
      challenge: 'YQ',
      pubKeyCredParams: [],
      rp: { name: 'G' },
      user: { displayName: 'a', id: 'Yg', name: 'a' },
    })

    expect(options.excludeCredentials).toEqual([])
  })
})

describe('toRegistrationResponse', () => {
  it('base64url-encodes every buffer the verifier reads', () => {
    const credential = {
      id: 'credential-id',
      rawId: new Uint8Array([97, 98]).buffer,
      response: {
        attestationObject: new Uint8Array([1, 2]).buffer,
        clientDataJSON: new Uint8Array([3, 4]).buffer,
        getTransports: () => ['internal'],
      },
      type: 'public-key',
    } as unknown as PublicKeyCredential

    const result = toRegistrationResponse(credential) as {
      rawId: string
      response: { attestationObject: string, clientDataJSON: string, transports: string[] }
    }

    // `[97, 98]` is `YW` in standard base64 but `YWI` unpadded — and this case
    // proves padding is stripped, which is what the server's verifier expects.
    expect(result.rawId).toBe('YWI')
    expect(result.response.attestationObject).toBe('AQI')
    expect(result.response.clientDataJSON).toBe('AwQ')
    expect(result.response.transports).toEqual(['internal'])
  })

  it('survives an authenticator without getTransports', () => {
    // Optional in the spec and absent on older WebKit; throwing here would
    // discard a credential the authenticator has already created.
    const credential = {
      id: 'x',
      rawId: new Uint8Array([1]).buffer,
      response: {
        attestationObject: new Uint8Array([1]).buffer,
        clientDataJSON: new Uint8Array([2]).buffer,
      },
      type: 'public-key',
    } as unknown as PublicKeyCredential

    const result = toRegistrationResponse(credential) as {
      response: { transports: string[] }
    }

    expect(result.response.transports).toEqual([])
  })
})

describe('isUserCancellation', () => {
  it('treats NotAllowedError as cancellation', () => {
    expect(isUserCancellation(new DOMException('x', 'NotAllowedError'))).toBe(true)
  })

  it('does not swallow real failures', () => {
    expect(isUserCancellation(new Error('boom'))).toBe(false)
    expect(isUserCancellation('nope')).toBe(false)
  })
})

describe('createPasskeyCredential', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { credentials: { create: vi.fn() } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const options = {
    challenge: 'YQ',
    pubKeyCredParams: [],
    rp: { name: 'G' },
    user: { displayName: 'a', id: 'Yg', name: 'a' },
  }

  it('throws when the browser returns nothing', async () => {
    // `create` resolves null when the user dismisses in some builds instead of
    // rejecting; without this guard the next step would post `null`.
    vi.mocked(navigator.credentials.create).mockResolvedValue(null)

    await expect(createPasskeyCredential(options)).rejects.toThrow('未返回')
  })

  it('passes the converted options through to the browser', async () => {
    const credential = {
      id: 'x',
      rawId: new Uint8Array([1]).buffer,
      response: {
        attestationObject: new Uint8Array([1]).buffer,
        clientDataJSON: new Uint8Array([2]).buffer,
        getTransports: () => [],
      },
      type: 'public-key',
    } as unknown as PublicKeyCredential

    vi.mocked(navigator.credentials.create).mockResolvedValue(credential)

    const result = await createPasskeyCredential(options)

    expect(result.id).toBe('x')
    expect(navigator.credentials.create).toHaveBeenCalledWith({
      publicKey: expect.objectContaining({ attestation: 'none' }),
    })
  })
})
