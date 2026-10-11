import { describe, expect, it } from 'vitest'

import { consoleErrorMessage } from '@/api/core/console'

describe('consoleErrorMessage', () => {
  describe('the two shapes the server actually uses', () => {
    it('reads a nested message', () => {
      // Session and passkey routes answer `{ error: { message } }`.
      expect(
        consoleErrorMessage({ data: { error: { message: 'Invalid password' } } }, 'fallback'),
      ).toBe('Invalid password')
    })

    it('reads a bare string', () => {
      // Credential and access-key routes answer `{ error: string }`. Handling
      // only the nested form rendered these as "[object Object]" — which hides
      // that the server said anything at all.
      expect(
        consoleErrorMessage({ data: { error: 'Credential deleted' } }, 'fallback'),
      ).toBe('Credential deleted')
    })

    it('prefers the nested message when both could apply', () => {
      expect(
        consoleErrorMessage({ data: { error: { message: 'nested' } } }, 'fallback'),
      ).toBe('nested')
    })
  })

  describe('the ways a body can be absent', () => {
    it('falls back to the error message when there is no body', () => {
      // A transport failure reaches here as a plain Error with `request:fail`
      // already rewritten by the alova handler — see `handlers.ts`.
      expect(consoleErrorMessage(new Error('网络连接失败，请稍后重试'), 'fallback')).toBe(
        '网络连接失败，请稍后重试',
      )
    })

    it('uses the caller wording when nothing else is available', () => {
      // An Error with no text is what a platform leaves behind when it rejects
      // without a reason; the caller's wording is the only thing left to show.
      const blank = new Error('placeholder')
      blank.message = ''

      expect(consoleErrorMessage(null, '加载凭据失败')).toBe('加载凭据失败')
      expect(consoleErrorMessage({}, '加载凭据失败')).toBe('加载凭据失败')
      expect(consoleErrorMessage({ data: {} }, '加载凭据失败')).toBe('加载凭据失败')
      expect(consoleErrorMessage(blank, '加载凭据失败')).toBe('加载凭据失败')
    })

    it('does not accept a blank message as an answer', () => {
      // `{ error: '   ' }` carries no information; showing a blank line where an
      // explanation belongs is worse than the generic wording.
      expect(consoleErrorMessage({ data: { error: '   ' } }, '稍后重试')).toBe('稍后重试')
      expect(
        consoleErrorMessage({ data: { error: { message: '' } } }, '稍后重试'),
      ).toBe('稍后重试')
    })

    it('ignores an error field that is neither a string nor an object with a message', () => {
      expect(consoleErrorMessage({ data: { error: 42 } }, '稍后重试')).toBe('稍后重试')
      expect(consoleErrorMessage({ data: { error: [] } }, '稍后重试')).toBe('稍后重试')
      expect(consoleErrorMessage({ data: { error: { code: 'x' } } }, '稍后重试')).toBe(
        '稍后重试',
      )
    })
  })
})
