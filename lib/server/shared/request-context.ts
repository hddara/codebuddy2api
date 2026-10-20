import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request correlation id.
 *
 * A single gateway request touches several modules (auth, model alias, credential
 * selection, upstream fetch, stream mapping, usage recording) and each of them
 * logs on its own. Without an id that is shared across those async hops the
 * lines of one request cannot be told apart from the lines of the thirty others
 * running at the same time, which makes "which step failed" unanswerable.
 * `AsyncLocalStorage` propagates the id implicitly, so nothing has to be
 * threaded through the call signatures.
 */
export interface RequestContext {
  id: string;
  route: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

let sequence = 0;

const nextRequestId = (): string => {
  sequence = (sequence + 1) % 1_000_000;

  return `r${Date.now().toString(36)}-${sequence.toString(36)}`;
};

export const runWithRequestContext = <T>(
  route: string,
  handler: () => Promise<T>,
): Promise<T> => storage.run({ id: nextRequestId(), route }, handler);

export const getRequestContext = (): RequestContext | undefined =>
  storage.getStore();
