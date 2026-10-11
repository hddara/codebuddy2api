import { describe, expect, it } from 'vitest'

import { isNgrokBaseUrl, transportHeaders } from '@/api/core/base-url'

const TUNNEL_HEADER = 'ngrok-skip-browser-warning'

describe('isNgrokBaseUrl', () => {
  it('recognises a tunnel origin', () => {
    expect(isNgrokBaseUrl('https://ab12-1-2-3-4.ngrok-free.app')).toBe(true)
    expect(isNgrokBaseUrl('https://x.ngrok.io')).toBe(true)
    expect(isNgrokBaseUrl('https://NGROK.example.com')).toBe(true)
  })

  it('does not mistake an ordinary origin for one', () => {
    // The header is for one vendor's interstitial. Sending it elsewhere is at
    // best noise, and a server that rejects unknown headers fails the preflight
    // — which the app reads as "this address is down".
    expect(isNgrokBaseUrl('https://code.apimesh.cn')).toBe(false)
    expect(isNgrokBaseUrl('http://192.168.1.13:8788')).toBe(false)
    expect(isNgrokBaseUrl('')).toBe(false)
  })
})

describe('transportHeaders', () => {
  it('adds the interstitial header for a tunnel', () => {
    // ngrok's free tier answers a browser user agent with HTML instead of JSON,
    // and the header is what asks for the real response.
    expect(transportHeaders('https://x.ngrok-free.app')).toEqual({
      [TUNNEL_HEADER]: '1',
    })
  })

  it('adds nothing for an origin that is not a tunnel', () => {
    expect(transportHeaders('https://code.apimesh.cn')).toEqual({})
    expect(transportHeaders('http://192.168.1.13:8788')).toEqual({})
    expect(transportHeaders('')).toEqual({})
  })

  it('is what both the probe and the request use, so they cannot disagree', () => {
    // Both call sites funnel through here. They used to differ: the probe sent
    // the header unconditionally, so a gateway that rejected it was judged dead
    // by the probe while its actual requests succeeded — and the app fell back
    // to another origin with nothing on screen explaining why. One function is
    // the whole guard against that returning; this asserts the shared result
    // rather than the call sites, which cannot be observed from here.
    for (const base of ['https://x.ngrok-free.app', 'https://code.apimesh.cn']) {
      const viaBase = transportHeaders(base)

      expect(viaBase).toEqual(
        isNgrokBaseUrl(base) ? { [TUNNEL_HEADER]: '1' } : {},
      )
    }
  })
})
