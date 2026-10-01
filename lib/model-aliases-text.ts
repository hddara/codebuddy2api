/**
 * Client-safe helpers for the admin access key editor.
 *
 * The text area uses one `alias=target` entry per line. Parsing is deliberately
 * lenient — the server re-normalizes whatever object it receives — so a stray
 * line never blocks saving the key.
 */
export type ModelAliasMap = Record<string, string>;

const MAX_ALIAS_LENGTH = 200;

export const parseModelAliasesText = (text: string): ModelAliasMap => {
  const aliases: ModelAliasMap = {};

  for (const line of text.split('\n')) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');

    if (separatorIndex <= 0) {
      continue;
    }

    const alias = trimmed.slice(0, separatorIndex).trim();
    const target = trimmed.slice(separatorIndex + 1).trim();

    if (!alias || !target || alias === target) {
      continue;
    }

    if (alias.length > MAX_ALIAS_LENGTH || target.length > MAX_ALIAS_LENGTH) {
      continue;
    }

    aliases[alias] = target;
  }

  return aliases;
};

export const formatModelAliasesText = (
  aliases: ModelAliasMap | undefined,
): string => {
  if (!aliases) {
    return '';
  }

  return Object.entries(aliases)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([alias, target]) => `${alias}=${target}`)
    .join('\n');
};
