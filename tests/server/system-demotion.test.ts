import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CHANNEL_SYSTEM_PROMPT,
  HARNESS_IDENTITY_PLACEHOLDER,
  demoteSystemPrompt,
  isSystemPromptDemotionEnabled,
  rewriteHarnessIdentity,
} from '@/lib/server/proxy/harness-identity';

afterEach(() => {
  delete process.env.CODEBUDDY_DEMOTE_SYSTEM_PROMPT;
});

describe('isSystemPromptDemotionEnabled', () => {
  it('is on unless explicitly switched off', () => {
    // The shared setup disables it for suites that assert exact bodies.
    delete process.env.CODEBUDDY_DEMOTE_SYSTEM_PROMPT;

    expect(isSystemPromptDemotionEnabled()).toBe(true);

    for (const value of ['0', 'false', 'no', 'off', ' OFF ']) {
      process.env.CODEBUDDY_DEMOTE_SYSTEM_PROMPT = value;
      expect(isSystemPromptDemotionEnabled()).toBe(false);
    }
  });
});

describe('demoteSystemPrompt', () => {
  it('moves a string system message into the first user turn', () => {
    const body = {
      messages: [
        { role: 'system', content: 'You are a coding agent.' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    };

    expect(demoteSystemPrompt(body, true)).toEqual({
      messages: [
        { role: 'system', content: DEFAULT_CHANNEL_SYSTEM_PROMPT },
        { role: 'user', content: 'You are a coding agent.\n\nhi' },
        { role: 'assistant', content: 'hello' },
      ],
    });
  });

  it('reads a content-block system message and keeps the blocks in order', () => {
    const body = {
      messages: [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'First instruction.' },
            { type: 'text', text: 'Second instruction.' },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
    };

    expect(demoteSystemPrompt(body, true)).toEqual({
      messages: [
        { role: 'system', content: DEFAULT_CHANNEL_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'First instruction.\n\nSecond instruction.' },
            { type: 'text', text: 'hi' },
          ],
        },
      ],
    });
  });

  it('adds the official preamble to a body that had no system message', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }] };

    expect(demoteSystemPrompt(body, true)).toEqual({
      messages: [
        { role: 'system', content: DEFAULT_CHANNEL_SYSTEM_PROMPT },
        { role: 'user', content: 'hi' },
      ],
    });
  });

  it('keeps a caller prompt that arrived without any user turn', () => {
    const body = { messages: [{ role: 'system', content: 'Only a prompt.' }] };

    expect(demoteSystemPrompt(body, true)).toEqual({
      messages: [
        { role: 'system', content: DEFAULT_CHANNEL_SYSTEM_PROMPT },
        { role: 'user', content: 'Only a prompt.' },
      ],
    });
  });

  it('leaves the body alone when switched off or without messages', () => {
    const body = {
      messages: [{ role: 'system', content: 'Keep me.' }],
    };

    expect(demoteSystemPrompt(body, false)).toBe(body);
    expect(demoteSystemPrompt({} as { messages?: unknown }, true)).toEqual({});
  });

  it('leaves the demoted prompt where the identity rewrite can reach it', () => {
    // The demotion moves the caller's text out of `system`, so a rewrite that
    // only scanned `system` would report nothing to do while the caller's
    // identity marker travelled in the user turn untouched.
    const demoted = demoteSystemPrompt(
      {
        messages: [
          { role: 'system', content: 'You are DeepSeek Harness.' },
          { role: 'user', content: 'hi' },
        ],
      },
      true,
    );

    const rewritten = rewriteHarnessIdentity(demoted);

    expect(rewritten).not.toBe(demoted);
    expect(rewritten.messages[1]).toEqual({
      role: 'user',
      content: `You are ${HARNESS_IDENTITY_PLACEHOLDER}.\n\nhi`,
    });
  });
});
