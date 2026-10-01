import {
  DEFAULT_FREQUENCY_COOLDOWN_MS,
  DEFAULT_MAX_RATE_LIMIT_COOLDOWN_MS,
  DEFAULT_QUOTA_COOLDOWN_MS,
  MAX_RATE_LIMIT_REASON_LENGTH,
  MIN_RATE_LIMIT_COOLDOWN_MS,
  parseRateLimitSignal,
} from '@/lib/server/shared/rate-limit';

const NOW = new Date('2026-09-30T09:18:51.000Z').getTime();

/** Captured from production on 2026-09-30 (HTTP 429, code 6004). */
const PRODUCTION_QUOTA_DETAIL = JSON.stringify({
  code: 6004,
  msg: '您的使用量已超出频率限制，将在 2026-10-01 00:36:46 UTC+8 重置，您也可以切换其他模型继续使用。',
  requestId: '213bf21bcb314451b5876ce7f6576ee5',
});

describe('rate limit signal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ignores non-429 statuses', () => {
    expect(parseRateLimitSignal({ detail: 'boom', status: 500 })).toBeNull();
    expect(parseRateLimitSignal({ detail: 'nope', status: 401 })).toBeNull();
  });

  it('classifies the observed quota payload and honors its reset instant', () => {
    const signal = parseRateLimitSignal({
      detail: PRODUCTION_QUOTA_DETAIL,
      status: 429,
    });

    expect(signal).toMatchObject({
      code: 6004,
      kind: 'quota',
      resumeAt: Date.parse('2026-10-01T00:36:46+08:00'),
    });
    expect(signal?.reason).toContain('使用量已超出频率限制');
  });

  it('falls back to a short cooldown for burst limits', () => {
    const signal = parseRateLimitSignal({
      detail: JSON.stringify({ error: { message: 'Too many requests' } }),
      status: 429,
    });

    expect(signal).toMatchObject({
      code: null,
      kind: 'frequency',
      reason: 'Too many requests',
      resumeAt: NOW + DEFAULT_FREQUENCY_COOLDOWN_MS,
    });
  });

  it('uses a longer default cooldown for quota wording without a reset time', () => {
    const signal = parseRateLimitSignal({
      detail: '{"msg":"当前账号额度已用尽","code":6003}',
      status: 429,
    });

    expect(signal).toMatchObject({
      code: 6003,
      kind: 'quota',
      resumeAt: NOW + DEFAULT_QUOTA_COOLDOWN_MS,
    });
  });

  it('parses retry-after seconds, HTTP dates, and structured reset fields', () => {
    expect(
      parseRateLimitSignal({ retryAfter: '120', status: 429 })?.resumeAt,
    ).toBe(NOW + 120_000);
    expect(
      parseRateLimitSignal({
        retryAfter: 'Wed, 30 Sep 2026 10:00:00 GMT',
        status: 429,
      })?.resumeAt,
    ).toBe(Date.parse('2026-09-30T10:00:00Z'));
    expect(
      parseRateLimitSignal({
        detail: JSON.stringify({ resetAt: 1_790_800_000 }),
        status: 429,
      })?.resumeAt,
    ).toBe(1_790_800_000_000);
    expect(
      parseRateLimitSignal({
        detail: JSON.stringify({ quota_reset_at: '2030-01-01T00:00:00Z' }),
        status: 429,
      })?.resumeAt,
    ).toBe(NOW + DEFAULT_MAX_RATE_LIMIT_COOLDOWN_MS);
  });

  it('honors a configured auto-release window over the reported reset', () => {
    const twoHours = 2 * 60 * 60 * 1000;
    const signal = parseRateLimitSignal({
      detail: PRODUCTION_QUOTA_DETAIL,
      maxCooldownMs: twoHours,
      status: 429,
    });

    // The upstream reports a reset ~15h out; the configured window wins.
    expect(signal?.resumeAt).toBe(NOW + twoHours);
    expect(
      parseRateLimitSignal({
        detail: '{"msg":"慢一点"}',
        maxCooldownMs: twoHours,
        status: 429,
      })?.resumeAt,
    ).toBe(NOW + DEFAULT_FREQUENCY_COOLDOWN_MS);
  });

  it('clamps cooldowns into the safe window', () => {
    expect(
      parseRateLimitSignal({ retryAfter: '5', status: 429 })?.resumeAt,
    ).toBe(NOW + MIN_RATE_LIMIT_COOLDOWN_MS);
    expect(
      parseRateLimitSignal({
        detail: '限流，将在 2020-01-01 00:00:00 UTC+8 重置',
        status: 429,
      })?.resumeAt,
    ).toBe(NOW + MIN_RATE_LIMIT_COOLDOWN_MS);
  });

  it('assumes UTC+8 when the reset instant carries no zone', () => {
    const signal = parseRateLimitSignal({
      detail: '频率限制，将于 2026-09-30 20:30:00 重置',
      status: 429,
    });

    expect(signal?.resumeAt).toBe(Date.parse('2026-09-30T20:30:00+08:00'));
  });

  it('truncates long plain-text reasons and keeps them as the reason', () => {
    const longText = `rate limit ${'x'.repeat(600)}`;
    const signal = parseRateLimitSignal({ detail: longText, status: 429 });
    const overflow = longText.length - MAX_RATE_LIMIT_REASON_LENGTH;

    expect(signal?.reason).toHaveLength(
      MAX_RATE_LIMIT_REASON_LENGTH + `...[truncated ${overflow} chars]`.length,
    );
    expect(signal?.reason).toContain('rate limit');
  });

  it('returns a null reason for empty details', () => {
    const signal = parseRateLimitSignal({ detail: null, status: 429 });

    expect(signal).toMatchObject({
      kind: 'frequency',
      reason: null,
      resumeAt: NOW + DEFAULT_FREQUENCY_COOLDOWN_MS,
    });
  });

  it('reads nested structured payloads', () => {
    const signal = parseRateLimitSignal({
      detail: JSON.stringify({
        error: { code: 429, message: 'quota exceeded', retry_after: '90' },
      }),
      status: 429,
    });

    expect(signal).toMatchObject({
      code: 429,
      kind: 'quota',
      reason: 'quota exceeded',
      resumeAt: NOW + 90_000,
    });
  });
});
