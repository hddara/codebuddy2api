import { describe, expect, it } from 'vitest';

import { getAvatarColor } from '@/app/avatar';

const palette = [
  '#0ea5e9',
  '#8b5cf6',
  '#f59e0b',
  '#10b981',
  '#ef4444',
  '#6366f1',
];

describe('avatar helpers', () => {
  it('returns a stable color for the same seed', () => {
    expect(getAvatarColor('owner')).toBe(getAvatarColor('owner'));
    expect(getAvatarColor('admin')).toBe(getAvatarColor('admin'));
  });

  it('always resolves to a palette color', () => {
    const seeds = ['', 'a', 'admin', '用户', 'ünicode', 'x'.repeat(64), '0'];

    for (const seed of seeds) {
      expect(palette, seed).toContain(getAvatarColor(seed));
    }
  });

  it('spreads different seeds across more than one color', () => {
    const colors = new Set(
      ['admin', 'alice', 'bob', 'carol', 'dave'].map((seed) =>
        getAvatarColor(seed),
      ),
    );

    expect(colors.size).toBeGreaterThan(1);
  });
});
