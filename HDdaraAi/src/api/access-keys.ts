import {
  consoleDelete,
  consoleGet,
  consolePatch,
  consolePost,
} from './core/console'

/**
 * Gateway access keys — the `cb2_...` tokens a client presents to `/v1/*`.
 *
 * Separate from an upstream credential on purpose. A credential is a real
 * account the gateway signs into; an access key is what *this* app shows the
 * gateway, carrying its own name, its own subset of credentials, and its own
 * model aliases. Deleting one does not touch the accounts behind it.
 */

/** Alias → real model id. Used to offer a short name for a long one. */
export type ModelAliases = Record<string, string>

/** An access key as listed. The secret is masked; see `fetchAccessKeySecret`. */
export interface AccessKeySummary {
  createdAt: string
  /** Credentials this key may use. An empty list means none are bound. */
  credentialFilenames: string[]
  id: string
  /** Masked form safe to display, e.g. `cb2_1234****abcd`. */
  maskedSecret: string
  modelAliases: ModelAliases
  name: string
  updatedAt: string
}

export async function fetchAccessKeys(): Promise<AccessKeySummary[]> {
  const payload = await consoleGet<{ access_keys?: AccessKeySummary[] }>(
    '/admin-api/access-keys',
  )

  return payload.access_keys ?? []
}

export interface CreateAccessKeyInput {
  credential_filenames: string[]
  model_aliases?: ModelAliases
  name: string
}

/**
 * Creates a key and returns its secret **once**.
 *
 * The server never sends the plaintext again — later reads return the masked
 * form — so the screen must show it for copying before dismissing. There is no
 * second chance to read it.
 */
export async function createAccessKey(
  input: CreateAccessKeyInput,
): Promise<{ access_key: AccessKeySummary, secret: string }> {
  return consolePost<{ access_key: AccessKeySummary, secret: string }>(
    '/admin-api/access-keys',
    input,
  )
}

/**
 * Updates a key.
 *
 * `credential_filenames` replaces the existing set rather than adding to it, so
 * callers must send the full list they intend the key to have.
 */
export async function updateAccessKey(
  id: string,
  input: Partial<CreateAccessKeyInput>,
): Promise<{ access_key: AccessKeySummary }> {
  return consolePatch<{ access_key: AccessKeySummary }>(
    `/admin-api/access-keys/${encodeURIComponent(id)}`,
    input,
  )
}

/** Deletes a key. The credentials it referenced are left alone. */
export async function deleteAccessKey(id: string): Promise<{ success: boolean }> {
  return consoleDelete<{ success: boolean }>(
    `/admin-api/access-keys/${encodeURIComponent(id)}`,
  )
}

/**
 * Reads a key's plaintext secret.
 *
 * Fetched on demand rather than with the list, so the secrets are only in memory
 * while a user is actually looking at one — the list keeps them masked.
 */
export async function fetchAccessKeySecret(
  id: string,
): Promise<{ id: string, name: string, secret: string }> {
  return consoleGet<{ id: string, name: string, secret: string }>(
    `/admin-api/access-keys/${encodeURIComponent(id)}/secret`,
  )
}

/**
 * Parses the alias editor's text into a map.
 *
 * One `alias = model` per line, which is what the console's own editor uses.
 * Blank lines and `#` comments are skipped so a user can annotate a long list;
 * an alias mapped to itself is dropped because it would do nothing.
 */
export function parseModelAliases(text: string): ModelAliases {
  const aliases: ModelAliases = {}

  for (const line of text.split('\n')) {
    const trimmed = line.trim()

    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const separator = trimmed.indexOf('=')

    if (separator < 0) {
      continue
    }

    const alias = trimmed.slice(0, separator).trim()
    const model = trimmed.slice(separator + 1).trim()

    if (alias && model && alias !== model) {
      aliases[alias] = model
    }
  }

  return aliases
}

/** Renders a map back into the editor's text form. */
export function formatModelAliases(aliases: ModelAliases | undefined): string {
  return Object.entries(aliases ?? {})
    .map(([alias, model]) => `${alias} = ${model}`)
    .join('\n')
}
