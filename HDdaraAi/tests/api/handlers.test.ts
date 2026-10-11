import { beforeEach, describe, expect, it } from 'vitest'

import { ApiError, handleAlovaError } from '@/api/core/handlers'

/**
 * Runs the handler and hands back whatever it threw, so a test can assert on the
 * error instead of on a rejected promise. Every path in it throws.
 */
function catchThrown(error: unknown): unknown {
  try {
    handleAlovaError(error as never)
  }
  catch (thrown) {
    return thrown
  }

  throw new Error('handleAlovaError was expected to throw')
}

function asError(value: unknown): Error {
  if (!(value instanceof Error)) {
    throw new Error(`expected an Error, received ${typeof value}`)
  }

  return value
}

describe('handleAlovaError', () => {
  beforeEach(() => {
    // The toast is deduplicated by a module-level timer; nothing to reset there,
    // but the storage-backed failure reporter is shared between cases.
    ;(uni as unknown as { __reset: () => void }).__reset()
  })

  describe('transport failures', () => {
    it('shows Chinese wording instead of the raw request:fail', () => {
      // The bug this pins down: the toast was translated but the thrown error
      // was not, so the login form displayed the literal `request:fail` under a
      // Chinese heading — the toast said one thing and the form another.
      const thrown = catchThrown(new Error('request:fail'))

      expect(asError(thrown).message).toBe('网络连接失败，请稍后重试')
      expect(asError(thrown).message).not.toContain('request:fail')
    })

    it('treats a NetworkError the same way, by name rather than wording', () => {
      const error = new Error('boom')
      error.name = 'NetworkError'

      expect(asError(catchThrown(error)).message).toBe('网络连接失败，请稍后重试')
    })

    it('rewrites a timeout into its own wording', () => {
      const error = new Error('timeout')
      error.name = 'TimeoutError'

      expect(asError(catchThrown(error)).message).toBe('请求超时，请重试')
    })

    it('keeps the original object so callers can still branch on it', () => {
      // `isAuthError` reads `status`, the stream reader reads `name`. Making an
      // error readable for display must not cost the code that handles it its
      // ability to recognise it.
      const original = new Error('request:fail')
      ;(original as Error & { status?: number }).status = 503

      const thrown = catchThrown(original)

      expect(thrown).toBe(original)
      expect((thrown as { status?: number }).status).toBe(503)
    })

    it('still produces a readable error when given a non-Error', () => {
      // `uni.request` can reject with a bare string on some platforms.
      const thrown = catchThrown('request:fail')

      expect(asError(thrown).message).toBe('网络连接失败，请稍后重试')
    })
  })

  describe('other failures', () => {
    it('passes an ApiError through untouched', () => {
      // The response handler already showed its toast; rewriting it here would
      // both duplicate the message and lose the status code.
      const apiError = new ApiError('网关暂时不可用', 502)

      const thrown = catchThrown(apiError)

      expect(thrown).toBe(apiError)
      expect((thrown as ApiError).message).toBe('网关暂时不可用')
    })

    it('passes an unreadable value through untouched', () => {
      // Nothing can be said about `{}` — there is no message to translate and no
      // name to branch on — so it is rethrown as-is and the caller's own
      // fallback (`describeError`) supplies the wording. Inventing a message
      // here would put the same text on screen as the generic branch.
      const value = {}

      expect(catchThrown(value)).toBe(value)
    })
  })
})
