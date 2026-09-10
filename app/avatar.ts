const avatarColors = [
  '#0ea5e9',
  '#8b5cf6',
  '#f59e0b',
  '#10b981',
  '#ef4444',
  '#6366f1',
] as const;

// Stable per-identity color so the same user always gets the same avatar tint.
export const getAvatarColor = (seed: string): string => {
  let hash = 0;

  for (const char of seed) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 2147483647;
  }

  return avatarColors[Math.abs(hash) % avatarColors.length] ?? avatarColors[0];
};
