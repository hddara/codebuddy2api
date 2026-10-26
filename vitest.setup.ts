import '@testing-library/jest-dom';

class ResizeObserverMock {
  disconnect = () => undefined;

  observe = () => undefined;

  unobserve = () => undefined;
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock);

// The proxy adds a system prompt to bodies that have none. Most suites assert
// the exact message array the upstream receives, so they would all have to
// re-state that sentence; harness-identity.test.ts covers the behaviour
// directly and proxy tests opt in where it matters.
process.env.CODEBUDDY_INJECT_SYSTEM_PROMPT = '0';

vi.stubGlobal(
  'fetch',
  vi.fn(async (input: RequestInfo | URL) => {
    throw new Error(`Unexpected network request in test: ${String(input)}`);
  }),
);
