import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CHANNEL_SYSTEM_PROMPT,
  HARNESS_IDENTITY_PLACEHOLDER,
  collectIdentityClaims,
  ensureSystemPrompt,
  hasBlockedHarnessIdentity,
  isHarnessIdentityRewriteEnabled,
  isSystemPromptInjectionEnabled,
  rewriteHarnessIdentity,
} from '@/lib/server/proxy/harness-identity';

afterEach(() => {
  delete process.env.CODEBUDDY_REWRITE_HARNESS_IDENTITY;
  delete process.env.CODEBUDDY_INJECT_SYSTEM_PROMPT;
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

describe('collectIdentityClaims', () => {
  it('finds an identity sentence and ignores ordinary instructions', () => {
    const claims = collectIdentityClaims({
      messages: [
        {
          role: 'system',
          content:
            'You are DeepSeek Harness, a coding agent. Follow the repository rules.',
        },
        { role: 'user', content: 'Please explain the build script.' },
      ],
    });

    expect(claims).toContain('You are DeepSeek Harness');
    expect(claims.join('|')).not.toContain('repository rules');
    expect(claims.join('|')).not.toContain('build script');
  });

  it('reads text parts as well as plain content', () => {
    const claims = collectIdentityClaims({
      messages: [
        {
          role: 'system',
          content: [
            {
              text: 'You are CodeBuddy. This service is running on Vercel.',
              type: 'text',
            },
          ],
        },
      ],
    });

    expect(claims.join('|')).toContain('You are CodeBuddy');
    expect(claims.join('|')).toContain('running on Vercel');
  });

  it('returns nothing when there is no system message', () => {
    expect(
      collectIdentityClaims({
        messages: [{ role: 'user', content: 'You are a' }],
      }),
    ).toEqual([]);
    expect(collectIdentityClaims({})).toEqual([]);
  });
});

describe('ensureSystemPrompt', () => {
  it('prepends a system message when the body has none', () => {
    const body = {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    };

    const shaped = ensureSystemPrompt(body, true);

    expect(shaped.messages).toEqual([
      { content: DEFAULT_CHANNEL_SYSTEM_PROMPT, role: 'system' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
    expect(body.messages).toHaveLength(2);
  });

  it('returns the same object when a system message is already present', () => {
    const body = {
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hello' },
      ],
    };

    expect(ensureSystemPrompt(body, true)).toBe(body);
  });

  it('leaves a body with no messages alone', () => {
    const body = { model: 'gpt' } as { messages?: unknown };

    expect(ensureSystemPrompt(body, true)).toBe(body);
  });

  it('does nothing when the behaviour is switched off', () => {
    const body = { messages: [{ role: 'user', content: 'hello' }] };

    expect(ensureSystemPrompt(body, false)).toBe(body);
  });
});

describe('isSystemPromptInjectionEnabled', () => {
  it('defaults to true', () => {
    expect(isSystemPromptInjectionEnabled()).toBe(true);
  });

  it('can be switched off', () => {
    for (const value of ['0', 'false', 'no', 'off', ' OFF ']) {
      process.env.CODEBUDDY_INJECT_SYSTEM_PROMPT = value;
      expect(isSystemPromptInjectionEnabled()).toBe(false);
    }
  });
});
