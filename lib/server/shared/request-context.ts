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

/**
 * Runs `handler` under a request context.
 *
 * Nesting is a no-op: the proxy layer opens the context that covers the whole
 * turn, and route-level work that happens *before* it (auth, reading the body)
 * opens one too so those failures are correlatable as well. Keeping the
 * outermost id rather than minting a second one means one request stays one id
 * in the log — otherwise a rejected body would carry a different `reqId` than
 * the request it belongs to.
 */
export const runWithRequestContext = <T>(
  route: string,
  handler: () => Promise<T>,
): Promise<T> => {
  const existing = storage.getStore();

  if (existing) {
    return handler();
  }

  return storage.run({ id: nextRequestId(), route }, handler);
};

export const getRequestContext = (): RequestContext | undefined =>
  storage.getStore();
