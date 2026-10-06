/**
 * Incremental Markdown rendering for a growing answer.
 *
 * Why this exists: the live page rendered the whole reply through
 * `renderMarkdown` on every update — and the answer arrives in hundreds of
 * deltas. Each update therefore re-parsed every character received so far and
 * handed `<rich-text>` a completely new node tree, which on the App runtime
 * re-lays out the entire block. Watching a long answer meant the text visibly
 * reflowed on every poll, and cost grew with the square of the answer length.
 *
 * The fix is to exploit the fact that an answer only ever grows at the end and
 * that Markdown's block boundaries are stable: a blank line ends a paragraph,
 * heading, list or quote. Everything before the last blank line can be rendered
 * once and never touched again; only the trailing block — the one still being
 * written — is re-rendered. The concatenated HTML is keyed by the prefix it was
 * built from, so an unchanged prefix is not recomputed at all.
 *
 * This deliberately does not track partial fenced code blocks as a special case:
 * the split is by blank line, and a code fence that spans blank lines is common,
 * so the trailing-block re-render is what keeps it correct. The cost of that is
 * re-parsing one block, not the whole answer.
 */

import { renderMarkdown } from './markdown'

export interface IncrementalRenderResult {
  /** HTML for the whole source, assembled from cached and freshly rendered parts. */
  html: string
  /**
   * True when the cached prefix was reused without re-parsing it. Exposed for
   * the verification script, which asserts that updates past the first do not
   * re-render the settled prefix.
   */
  reusedPrefix: boolean
}

/** Where the trailing (still-growing) block starts, and the settled prefix before it. */
interface Split {
  /** Offset in the source at which the unstable tail begins. */
  tailStart: number
}

const isBlank = (line: string): boolean => line.trim().length === 0

/**
 * Finds the offset where the still-growing tail begins.
 *
 * The boundary is the start of the last block, where blocks are separated by one
 * or more blank lines. Only the last block is treated as unstable: it is the one
 * the model is currently writing. Everything before it cannot change because
 * nothing is ever inserted into the middle of a streamed answer.
 *
 * A fence that is still open is handled by walking backwards: if the text after
 * the candidate boundary contains an odd number of fences, the boundary is moved
 * further back to before the fence opened, so a half-written code block is
 * re-rendered from its start rather than as a broken fragment.
 */
function findTailStart(source: string): Split {
  const lines = source.split('\n')

  // Walk from the end to the last blank line that has non-blank content after it.
  let boundaryLine = -1

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (isBlank(lines[i] ?? '')) {
      // A blank line at the very end means the tail is empty; the prefix is the
      // whole document and there is nothing unstable to render.
      if (i === lines.length - 1) {
        continue
      }

      boundaryLine = i + 1
      break
    }
  }

  let tailStart = 0

  if (boundaryLine > 0) {
    let offset = 0

    for (let i = 0; i < boundaryLine; i += 1) {
      offset += (lines[i] ?? '').length + 1
    }

    tailStart = offset
  }

  return { tailStart: expandForOpenFence(source, tailStart) }
}

/**
 * Moves the boundary back so an unterminated fenced code block is re-rendered
 * whole rather than split across the cache boundary.
 *
 * Counting is done on the suffix only: an even number of fence markers there
 * means every code block in the tail is closed.
 */
function expandForOpenFence(source: string, tailStart: number): number {
  if (tailStart <= 0) {
    return 0
  }

  const suffix = source.slice(tailStart)

  if (countFences(suffix) % 2 === 0) {
    return tailStart
  }

  // Find the start of the line that opened the fence and return the previous
  // stable boundary before it.
  const before = source.slice(0, tailStart)
  const lines = before.split('\n')
  let seen = 0

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^ {0,3}`{3,}/.test(lines[i] ?? '')) {
      seen += 1

      if (seen % 2 === 1) {
        // `i` is the opening fence line; drop the whole block by ending the
        // prefix at the line before it.
        let offset = 0

        for (let j = 0; j < Math.max(i - 1, 0); j += 1) {
          offset += (lines[j] ?? '').length + 1
        }

        return offset
      }
    }
  }

  return 0
}

const FENCE_LINE = /^ {0,3}`{3,}/

function countFences(text: string): number {
  return text.split('\n').filter(line => FENCE_LINE.test(line)).length
}

/** Cached render of one settled prefix, keyed by the exact source it came from. */
let cachedPrefixSource = ''
let cachedPrefixHtml = ''
/**
 * Offset of the unstable tail in the source the cache was built from.
 *
 * Monotonic: never moved backwards while the source only grows. A boundary that
 * moves back and forth is what made reuse unreliable — mid-stream a blank line
 * appears and disappears as deltas land between `\n` characters, so
 * recomputing the boundary per update invalidated the cache on roughly half of
 * them even though nothing in the settled region had changed.
 */
let cachedTailStart = -1

/**
 * Renders `source`, reusing the previous result when only the tail changed.
 *
 * State is module-local and single-slot: the live page renders one growing
 * answer at a time. A slot rather than a map is enough and keeps the cache from
 * holding on to whole answers after the user leaves.
 *
 * Callers that render unrelated documents (for example a list of finished
 * answers) should pass `reset: true` on the first call of that sequence so the
 * cache is not consulted across documents.
 */
export function renderIncremental(
  source: string,
  options: { reset?: boolean } = {},
): IncrementalRenderResult {
  if (options.reset) {
    cachedPrefixSource = ''
    cachedPrefixHtml = ''
    cachedTailStart = -1
  }

  const { tailStart } = findTailStart(source)

  // Reuse is possible whenever the cache still describes a prefix of the current
  // source. The cache is deliberately **not** invalidated when the freshly
  // computed boundary sits earlier than the cached one: that happens constantly
  // mid-stream (a delta can land between two `\n` characters, making a completed
  // paragraph look unfinished for one update). Re-rendering an already-settled
  // region is harmless — the output is identical — so the boundary is simply
  // clamped to the cached position and the cache survives.
  const canReuse
    = cachedPrefixSource.length > 0
      && cachedTailStart >= 0
      && source.startsWith(cachedPrefixSource)

  if (canReuse) {
    // Never let the boundary move backwards. A boundary that regresses would
    // mean re-settling text already folded into the cache, which would append a
    // second copy of it.
    const settledEnd = Math.max(tailStart, cachedTailStart)
    const newlySettled = source.slice(cachedPrefixSource.length, settledEnd)
    const tail = source.slice(settledEnd)

    const settledHtml = newlySettled ? renderMarkdown(newlySettled) : ''
    const tailHtml = tail ? renderMarkdown(tail) : ''

    cachedPrefixSource = source.slice(0, settledEnd)
    cachedPrefixHtml += settledHtml
    cachedTailStart = settledEnd

    return { html: cachedPrefixHtml + tailHtml, reusedPrefix: true }
  }

  // Either the first render, a different document, or a boundary that moved
  // backwards (an open fence that has since closed differently). Render the
  // settled part once and cache it; only the tail is re-rendered afterwards.
  const prefix = source.slice(0, tailStart)
  const tail = source.slice(tailStart)

  cachedPrefixSource = prefix
  cachedPrefixHtml = prefix ? renderMarkdown(prefix) : ''
  cachedTailStart = tailStart

  return {
    html: cachedPrefixHtml + (tail ? renderMarkdown(tail) : ''),
    reusedPrefix: false,
  }
}

/** Drops the cache. Called when the page unloads or switches conversation. */
export function resetIncrementalRender(): void {
  cachedPrefixSource = ''
  cachedPrefixHtml = ''
  cachedTailStart = -1
}
