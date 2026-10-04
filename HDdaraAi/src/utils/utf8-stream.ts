/**
 * Incremental UTF-8 decoder for chunked HTTP responses.
 *
 * Two hazards that only show up on a real device, both of which this removes:
 *
 *  - A multi-byte character (every Chinese glyph) that straddles two chunks
 *    decodes to replacement characters when each chunk is decoded on its own.
 *    The decoder therefore carries the trailing partial sequence into the next
 *    call instead of dropping it.
 *  - `TextDecoder` is not guaranteed to exist in every App or mini-program JS
 *    runtime, so a pure-JS path is used when the global is missing.
 *
 * Prefer `TextDecoder` when present: it is native, faster, and already
 * implements exactly this streaming contract.
 */

/** Continuation byte count implied by a lead byte, or -1 when it is invalid. */
function continuationLength(byte: number): number {
  if (byte < 0x80)
    return 0
  if ((byte & 0xE0) === 0xC0)
    return 1
  if ((byte & 0xF0) === 0xE0)
    return 2
  if ((byte & 0xF8) === 0xF0)
    return 3

  return -1
}

/** Falls back to a strict-enough decoder so text never silently turns to mojibake. */
function createManualDecoder(): (chunk: ArrayBuffer) => string {
  let pending: number[] = []

  return (chunk: ArrayBuffer): string => {
    const incoming = Array.from(new Uint8Array(chunk))
    const bytes = pending.length ? pending.concat(incoming) : incoming

    let result = ''
    let index = 0

    while (index < bytes.length) {
      const lead = bytes[index] as number
      const need = continuationLength(lead)

      if (need < 0) {
        // Invalid lead byte: skip it rather than emitting a replacement char,
        // which keeps payload JSON parseable across a corrupt frame.
        index += 1
        continue
      }

      if (index + need >= bytes.length) {
        // Incomplete sequence at the tail: hold it for the next chunk.
        break
      }

      let codePoint = 0

      if (need === 0) {
        codePoint = lead
      }
      else {
        codePoint = lead & (0x7F >> need)

        for (let offset = 1; offset <= need; offset += 1) {
          const next = bytes[index + offset] as number

          if ((next & 0xC0) !== 0x80) {
            codePoint = -1
            break
          }

          codePoint = (codePoint << 6) | (next & 0x3F)
        }

        if (codePoint < 0) {
          index += 1
          continue
        }
      }

      if (codePoint > 0xFFFF) {
        const adjusted = codePoint - 0x1_0000

        result += String.fromCharCode(
          0xD800 + (adjusted >> 10),
          0xDC00 + (adjusted & 0x3FF),
        )
      }
      else {
        result += String.fromCharCode(codePoint)
      }

      index += need + 1
    }

    pending = bytes.slice(index)

    return result
  }
}

/**
 * Returns a stateful `chunk -> text` function. Call it with consecutive chunks
 * of one response; create a new one per stream.
 */
export function createUtf8Decoder(): (chunk: ArrayBuffer) => string {
  if (typeof TextDecoder === 'function') {
    const decoder = new TextDecoder('utf-8')

    return (chunk: ArrayBuffer): string =>
      decoder.decode(new Uint8Array(chunk), { stream: true })
  }

  return createManualDecoder()
}
