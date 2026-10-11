import { describe, expect, it } from 'vitest'

import { formatModelAliases, parseModelAliases } from '@/api/access-keys'

describe('parseModelAliases', () => {
  it('reads one alias per line', () => {
    expect(parseModelAliases('fast = deepseek-v4.1-flash\nsmart = claude-opus-4')).toEqual({
      fast: 'deepseek-v4.1-flash',
      smart: 'claude-opus-4',
    })
  })

  it('tolerates the spacing a person actually types', () => {
    expect(parseModelAliases('  fast=deepseek  \n\nsmart   =   claude  ')).toEqual({
      fast: 'deepseek',
      smart: 'claude',
    })
  })

  it('skips comments and blank lines', () => {
    // A long list gets annotated; those lines must not become aliases.
    expect(
      parseModelAliases('# 常用\nfast = a\n\n# 备用\nsmart = b'),
    ).toEqual({ fast: 'a', smart: 'b' })
  })

  it('ignores a line with no separator instead of inventing a mapping', () => {
    expect(parseModelAliases('fast = a\njust-a-model\nsmart = b')).toEqual({
      fast: 'a',
      smart: 'b',
    })
  })

  it('drops an alias that maps to itself', () => {
    // It would do nothing, and the server discards it anyway — keeping it would
    // show the user a row that silently is not there after a save.
    expect(parseModelAliases('a = a\nb = c')).toEqual({ b: 'c' })
  })

  it('keeps a model id that contains an equals sign', () => {
    // Only the first separator splits, so a value with `=` survives intact.
    expect(parseModelAliases('weird = model=2')).toEqual({ weird: 'model=2' })
  })

  it('reports nothing for empty input', () => {
    expect(parseModelAliases('')).toEqual({})
    expect(parseModelAliases('\n\n')).toEqual({})
  })
})

describe('formatModelAliases', () => {
  it('renders back into the form the parser reads', () => {
    const aliases = { fast: 'deepseek-v4.1-flash', smart: 'claude-opus-4' }

    expect(parseModelAliases(formatModelAliases(aliases))).toEqual(aliases)
  })

  it('reports nothing for a missing map', () => {
    expect(formatModelAliases(undefined)).toBe('')
    expect(formatModelAliases({})).toBe('')
  })
})
