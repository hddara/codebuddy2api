export type ModelAliases = Record<string, string>;

const MAX_ALIAS_ENTRIES = 50;
const MAX_ALIAS_LENGTH = 200;

const asTrimmedString = (value: unknown): string => {
  return typeof value === 'string' ? value.trim() : '';
};

/**
 * Normalizes a raw alias map into a bounded, trimmed map.
 *
 * Invalid entries (empty alias/target, self mapping, oversized value, non-string
 * value) are dropped instead of throwing so that a partially broken store can
 * still serve requests.
 */
export const normalizeModelAliases = (value: unknown): ModelAliases => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const aliases: ModelAliases = {};

  for (const [rawAlias, rawTarget] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (Object.keys(aliases).length >= MAX_ALIAS_ENTRIES) {
      break;
    }

    const alias = asTrimmedString(rawAlias);
    const target = asTrimmedString(rawTarget);

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

export const areModelAliasesEqual = (
  left: ModelAliases,
  right: ModelAliases,
): boolean => {
  const leftKeys = Object.keys(left);

  if (leftKeys.length !== Object.keys(right).length) {
    return false;
  }

  return leftKeys.every((key) => right[key] === left[key]);
};

/**
 * Maps a requested model name through the alias table.
 *
 * Returns `undefined` when the caller did not request a model (the credential
 * picker then skips model filtering), and otherwise returns the target model or
 * the requested model untouched when no alias matches.
 */
export const resolveModelAlias = (
  aliases: ModelAliases | undefined,
  model?: string | null,
): string | undefined => {
  if (typeof model !== 'string' || !model.trim()) {
    return undefined;
  }

  return aliases?.[model.trim()] ?? model;
};

/**
 * Ensures every alias target is a model some bound credential can actually
 * serve, so a typo surfaces while saving instead of as a 400 at request time.
 * Credentials without a `supported_models` list are treated as “any model”.
 */
export const assertModelAliasTargets = (
  aliases: ModelAliases,
  supportedModels: string[],
): void => {
  if (!supportedModels.length) {
    return;
  }

  const supported = new Set(supportedModels);

  for (const [alias, target] of Object.entries(aliases)) {
    if (!supported.has(target)) {
      throw new Error(
        `Model alias "${alias}" points to "${target}", which is not supported by the bound credentials`,
      );
    }
  }
};
