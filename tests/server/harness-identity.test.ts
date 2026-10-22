import { afterEach, describe, expect, it } from 'vitest';

import {
  HARNESS_IDENTITY_PLACEHOLDER,
  hasBlockedHarnessIdentity,
  isHarnessIdentityRewriteEnabled,
  rewriteHarnessIdentity,
} from '@/lib/server/proxy/harness-identity';

afterEach(() => {
  delete process.env.CODEBUDDY_REWRITE_HARNESS_IDENTITY;
});

describe('hasBlockedHarnessIdentity', () => {
  it('detects the phrase regardless of case', () => {
    expect(hasBlockedHarnessIdentity('you are DeepSeek Harness')).toBe(true);
    expect(hasBlockedHarnessIdentity('you are deepseek harness')).toBe(true);
    expect(hasBlockedHarnessIdentity('you are DeepSeek')).toBe(false);
    expect(hasBlockedHarnessIdentity(undefined)).toBe(false);
  });
});

describe('rewriteHarnessIdentity', () => {
  it('replaces the phrase in a system string and leaves the rest intact', () => {
    const body = {
      messages: [
        {
          role: 'system',
          content: 'You are DeepSeek Harness, a coding agent.',
        },
        { role: 'user', content: 'hi' },
      ],
    };

    const rewritten = rewriteHarnessIdentity(body);

    expect(rewritten.messages[0]).toEqual({
      role: 'system',
      content: `You are ${HARNESS_IDENTITY_PLACEHOLDER}, a coding agent.`,
    });
    expect(rewritten.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('leaves a user message untouched, because the check only reads system', () => {
    const body = {
      messages: [{ role: 'user', content: 'DeepSeek Harness is a product' }],
    };

    expect(rewriteHarnessIdentity(body)).toBe(body);
  });

  it('rewrites text parts and keeps cache control markers', () => {
    const body = {
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: 'DeepSeek Harness',
              cache_control: { type: 'ephemeral' },
            },
            { type: 'text', text: 'unchanged' },
          ],
        },
      ],
    };

    const rewritten = rewriteHarnessIdentity(body);
    const content = rewritten.messages[0].content as Array<
      Record<string, unknown>
    >;

    expect(content[0]).toEqual({
      type: 'text',
      text: HARNESS_IDENTITY_PLACEHOLDER,
      cache_control: { type: 'ephemeral' },
    });
    expect(content[1]).toEqual({ type: 'text', text: 'unchanged' });
  });

  it('returns the same object when nothing matches', () => {
    const body = {
      messages: [{ role: 'system', content: 'You are a helpful assistant.' }],
      model: 'deepseek-v4.1-flash',
    };

    expect(rewriteHarnessIdentity(body)).toBe(body);
  });

  it('tolerates a body without messages', () => {
    const body = { model: 'deepseek-v4.1-flash' } as {
      model: string;
      messages?: unknown;
    };

    expect(rewriteHarnessIdentity(body)).toBe(body);
  });
});

describe('isHarnessIdentityRewriteEnabled', () => {
  it('is off unless the flag is set to a truthy value', () => {
    expect(isHarnessIdentityRewriteEnabled()).toBe(false);

    for (const value of ['true', '1', 'YES', ' on ']) {
      process.env.CODEBUDDY_REWRITE_HARNESS_IDENTITY = value;

      expect(isHarnessIdentityRewriteEnabled()).toBe(true);
    }

    process.env.CODEBUDDY_REWRITE_HARNESS_IDENTITY = 'false';

    expect(isHarnessIdentityRewriteEnabled()).toBe(false);
  });
});
