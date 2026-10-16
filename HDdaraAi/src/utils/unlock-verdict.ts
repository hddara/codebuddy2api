import { isAuthError } from './errors'

/**
 * What the last attempt to use a stored credential found.
 *
 * Three outcomes rather than the boolean this replaces, because the lock screen
 * has to act differently on each and collapsing them caused two distinct bugs:
 *
 *  - a **rejected** token was reported as "登录已过期，请重新填写凭据" immediately
 *    after a successful face scan, which reads as though the scan failed;
 *  - an **unreachable** gateway was reported as *success*. `verifyStored` used to
 *    `return true` for anything that was not an auth rejection, so a device in
 *    airplane mode passed the lock screen on a biometric match and only met the
 *    failure one screen later, separately on every page.
 *
 * The distinction is load-bearing, not cosmetic: only `rejected` means the user
 * has to do something, and telling them so when the truth is `unreachable` sends
 * them to retype a password that was never the problem.
 */
export type StoredVerdict = 'valid' | 'rejected' | 'unreachable'

/**
 * Classifies the result of a credential check that either resolved or threw.
 *
 * Written as a pure function over the thrown value rather than folded into the
 * request, so the rule is testable without a network: it is a decision about an
 * error, and the request that produced it is incidental.
 *
 * `isAuthError` is the shared reader for "the server refused this credential" —
 * status code first, wording only as a fallback. It lives in `utils/errors.ts`
 * so this and the per-page error messages cannot drift apart.
 */
export function classifyStoredCredential(error: unknown): StoredVerdict {
  if (!error)
    return 'valid'

  return isAuthError(error) ? 'rejected' : 'unreachable'
}

/**
 * What to tell a user whose biometric matched but who could not be let in.
 *
 * Keyed by the verdict rather than written once with a clause swapped, because
 * the two cases call for different actions: one is "sign in again", the other is
 * "check your network and retry" — and the old single sentence told both kinds
 * of user to re-enter their credential.
 *
 * The `rejected` wording leads with the fact that the identity check succeeded.
 * That is not decoration: this text lands seconds after a face scan, and the
 * previous wording ("登录已过期，请重新填写凭据") left users believing the scan
 * had failed and pressing it again.
 *
 * `valid` has no message — there is nothing to say — and is typed out anyway so
 * a new verdict cannot be added without deciding what it says.
 */
export function describeUnlockFailure(verdict: StoredVerdict): string {
  if (verdict === 'rejected')
    return '身份已确认，但登录状态已失效，请重新登录以继续'

  if (verdict === 'unreachable')
    return '无法连接网关，请检查网络后重试'

  return ''
}
