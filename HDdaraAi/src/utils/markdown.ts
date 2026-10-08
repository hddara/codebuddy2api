/**
 * Minimal Markdown → HTML renderer for the in-app transcript view.
 *
 * Why hand-rolled instead of pulling in `marked` + `highlight.js`:
 *
 *  - The App runtime has no DOM, so a browser-oriented renderer is no use; the
 *    output has to be HTML for `<rich-text>`, which only understands a small,
 *    documented subset of tags.
 *  - The content is model output, i.e. trusted in the sense that it must be
 *    displayed*, but it still arrives as arbitrary text — so everything is
 *    escaped first and only the tags this module emits survive. That is the
 *    whole safety story: no raw model text ever reaches the markup.
 *  - A full parser costs size on every cold start for syntax this app will
 *    realistically never see.
 *
 * Coverage is deliberately limited to what shows up in practice: headings,
 * fenced code, lists, blockquotes, horizontal rules, and inline emphasis/code.
 */

/** HTML-escape, so no model-provided text can introduce a tag. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Inline rules: code spans first, so `a*b*` inside backticks is left alone. */
function renderInline(text: string): string {
  let out = escapeHtml(text)

  // Inline code: `x`
  out = out.replace(/`([^`]+)`/g, '<span class="md-code">$1</span>')

  // Bold before italic, otherwise `**a**` would be eaten by the `*` rule.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')

  // Links render as their text plus the URL: `<rich-text>` cannot open a
  // browser reliably across platforms, so showing the target is more useful
  // than a dead tap target.
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<strong>$1</strong> <span class="md-link">$2</span>',
  )

  return out
}

/**
 * Splits one line into a list marker and its text, or `null` if it is not a
 * list item.
 *
 * Scanned character by character rather than matched with a regex: the natural
 * pattern (`^( *)([-*+]|\d+[.)])\s+(.*)$`) has quantifiers that can trade
 * characters with each other, and eslint's ReDoS rule rejects it — correctly,
 * since the input is arbitrary model output that may be 100k characters long.
 */
function parseListItem(
  line: string,
): { marker: string, ordered: boolean, text: string } | null {
  let cursor = 0

  while (cursor < line.length && line[cursor] === ' ') {
    cursor += 1
    // Deeper indentation is a nested list; treating it as top level keeps the
    // output flat, which reads better on a phone than deep nesting anyway.
    if (cursor >= 4)
      break
  }

  const rest = line.slice(cursor)

  // Bullet marker.
  if (rest.length > 1 && '-*+'.includes(rest[0] ?? '')) {
    const afterMarker = rest.slice(1)
    if (afterMarker[0] === ' ' || afterMarker[0] === '\t') {
      return { marker: rest[0] ?? '-', ordered: false, text: afterMarker.trim() }
    }
    return null
  }

  // Ordered marker: digits followed by `.` or `)` then whitespace.
  let digits = 0
  while (digits < rest.length && rest[digits] !== undefined && /\d/.test(rest[digits] ?? '')) {
    digits += 1
  }

  if (digits > 0 && digits < rest.length) {
    const separator = rest[digits]
    const afterMarker = rest.slice(digits + 1)

    if (
      (separator === '.' || separator === ')')
      && (afterMarker[0] === ' ' || afterMarker[0] === '\t' || afterMarker === '')
    ) {
      return { marker: rest.slice(0, digits + 1), ordered: true, text: afterMarker.trim() }
    }
  }

  return null
}

interface RenderOptions {
  /** Applied to fenced code blocks; used to keep long code from dominating. */
  codeMaxHeight?: number
}

/**
 * Renders Markdown to the HTML subset `<rich-text>` accepts.
 *
 * `<rich-text>` only supports tag-level styling (no class-based CSS in some
 * runtimes), which is why styles are inlined rather than left to a stylesheet.
 */
export function renderMarkdown(
  source: string,
  options: RenderOptions = {},
): string {
  const codeMaxHeight = options.codeMaxHeight ?? 420
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const html: string[] = []

  let index = 0
  let inCode = false
  let codeLines: string[] = []
  let codeLang = ''

  const flushCode = (): void => {
    if (!codeLines.length && !codeLang)
      return

    const body = escapeHtml(codeLines.join('\n'))
    const label = codeLang
      ? `<div style="font-size:11px;color:#8a8f99;margin-bottom:6px;">${escapeHtml(codeLang)}</div>`
      : ''

    html.push(
      `<div style="background:#1f2329;border-radius:8px;padding:12px;margin:10px 0;">`
      + `${label}<pre style="margin:0;white-space:pre-wrap;word-break:break-all;`
      + `font-family:monospace;font-size:13px;line-height:1.55;color:#e6e8eb;`
      + `max-height:${codeMaxHeight}px;overflow:auto;">${body}</pre></div>`,
    )

    codeLines = []
    codeLang = ''
  }

  while (index < lines.length) {
    const line = lines[index] ?? ''

    // ---- fenced code ------------------------------------------------
    // Ambiguous quantifiers are avoided throughout this file. The obvious
    // `^\s*```+\s*(\S*)\s*$` lets the leading and trailing spaces trade
    // characters, which backtracks polynomially on a long non-matching line —
    // and the input here is a model answer that can be 100k characters.
    // (`regexp/no-super-linear-backtracking` flagged exactly that.)
    // Written without a capture-heavy regex: overlapping quantifiers here let
    // the matcher trade characters between the fence and the language token,
    // which backtracks on a long line that merely starts with backticks.
    //
    // A fence may carry a language (` ```js `), so the *whole* line must not be
    // required to equal the backticks — comparing only the backtick run and
    // then treating whatever follows as the language is what makes both forms
    // work.
    const fenceMatch = /^ {0,3}(`{3,})/.exec(line)
    const fence = fenceMatch
      ? ([fenceMatch[1], line.trim().slice(fenceMatch[1].length).trim()] as const)
      : null
    if (fence) {
      if (inCode) {
        flushCode()
        inCode = false
      }
      else {
        inCode = true
        codeLang = fence[1] ?? ''
      }
      index += 1
      continue
    }

    if (inCode) {
      codeLines.push(line)
      index += 1
      continue
    }

    // ---- blank line -------------------------------------------------
    if (!line.trim()) {
      index += 1
      continue
    }

    // ---- horizontal rule --------------------------------------------
    if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) {
      html.push('<div style="height:1px;background:#e6e8eb;margin:14px 0;"></div>')
      index += 1
      continue
    }

    // ---- heading ----------------------------------------------------
    const headingMatch = /^(#{1,6})/.exec(line)
    // A heading needs a space after the hashes; `#tag` is not a heading.
    const heading = headingMatch && /^ {0,3}#{1,6}[ \t]/.test(line)
      ? [headingMatch[1], line.slice(headingMatch[1].length).trim()] as const
      : null
    if (heading) {
      const level = heading[0].length
      // Sizes shrink with depth but stay readable on a phone; weight carries
      // most of the hierarchy rather than extreme size differences.
      const size = [19, 17, 16, 15, 15, 15][level - 1] ?? 15
      html.push(
        `<div style="font-size:${size}px;font-weight:600;color:#1f2329;`
        + `margin:14px 0 6px;">${renderInline(heading[1])}</div>`,
      )
      index += 1
      continue
    }

    // ---- blockquote -------------------------------------------------
    if (/^ {0,3}> ?/.test(line)) {
      const quote: string[] = []

      while (index < lines.length && /^ {0,3}> ?/.test(lines[index] ?? '')) {
        quote.push((lines[index] ?? '').replace(/^ {0,3}> ?/, ''))
        index += 1
      }

      html.push(
        `<div style="border-left:3px solid #d0d4da;padding:2px 0 2px 10px;`
        + `margin:10px 0;color:#4a4f57;font-size:14px;line-height:1.7;">`
        + `${renderInline(quote.join('\n')).replace(/\n/g, '<br/>')}</div>`,
      )
      continue
    }

    // ---- lists ------------------------------------------------------
    const bullet = parseListItem(line)
    if (bullet) {
      const items: string[] = []
      const ordered = bullet.ordered

      while (index < lines.length) {
        const current = lines[index] ?? ''
        const match = parseListItem(current)

        if (!match) {
          // A wrapped continuation line belongs to the previous item.
          if (items.length && current.trim() && current.trim().length > 0) {
            items[items.length - 1] += ` ${current.trim()}`
            index += 1
            continue
          }
          break
        }

        items.push(match.text)
        index += 1
      }

      const rendered = items
        .map((item, position) => {
          const marker = ordered ? `${position + 1}.` : '•'
          return (
            `<div style="display:flex;margin:3px 0;">`
            + `<div style="width:22px;flex:none;color:#8a8f99;font-size:14px;">${marker}</div>`
            + `<div style="flex:1;font-size:14px;line-height:1.7;color:#1f2329;">`
            + `${renderInline(item)}</div></div>`
          )
        })
        .join('')

      html.push(`<div style="margin:8px 0;">${rendered}</div>`)
      continue
    }

    // ---- paragraph ---------------------------------------------------
    // Consecutive non-blank lines join into one paragraph, matching how the
    // text was written; a hard break inside it still becomes a line break.
    const paragraph: string[] = []

    while (index < lines.length) {
      const current = lines[index] ?? ''

      if (
        !current.trim()
        || /^ {0,3}`{3,}/.test(current)
        || /^#{1,6}[ \t]/.test(current)
        || /^\s*>\s?/.test(current)
        || parseListItem(current) !== null
        || /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(current)
      ) {
        break
      }

      paragraph.push(current)
      index += 1
    }

    html.push(
      `<div style="font-size:15px;line-height:1.75;color:#1f2329;margin:8px 0;">`
      + `${renderInline(paragraph.join('\n')).replace(/\n/g, '<br/>')}</div>`,
    )
  }

  // An unterminated fence (the answer was cut off mid-code) still shows as code.
  if (inCode)
    flushCode()

  return html.join('')
}

/**
 * Reduces a stored prompt to what the user actually typed.
 *
 * The IDE sends its entire preamble as one user message, so the transcript was
 * rendering a wall of instructions with the real question buried inside
 * `<user_query>`. Everything outside that tag is scaffolding.
 *
 * Turns stored before the gateway read that tag first were cut off in the middle
 * of the preamble, so their text is scaffolding with no question in it at all.
 * Those report an empty string — the pages already have a "no question captured"
 * line — because `OS Version: darwin …` is not an answer to "what did I ask?".
 */
export function extractQuestion(raw: string): string {
  if (!raw)
    return ''

  const match = raw.match(/<user_query>([\s\S]*?)<\/user_query>/i)

  if (match?.[1]?.trim())
    return match[1].trim()

  // No tag: strip the known wrapper blocks so at least the rest is readable.
  const stripped = raw
    .replace(/<additional_data>[\s\S]*?<\/additional_data>/gi, '')
    .replace(/<system_reminder>[\s\S]*?<\/system_reminder>/gi, '')
    .replace(/<user_info>[\s\S]*?<\/user_info>/gi, '')
    .replace(/<artifact_directory_path>[\s\S]*?<\/artifact_directory_path>/gi, '')
    .replace(/<rules>[\s\S]*?<\/rules>/gi, '')
    .replace(/<user_query>[\s\S]*?<\/user_query>/gi, '')
    .trim()
    // A label some clients put in front of the input (`User's input is: uTools …`).
    // Anchored on a Chinese question following it, so an English prompt that
    // opens with its own label (`Note: …`) is left as written.
    .replace(/^[A-Z][A-Z'\u2019\s-]{2,30}[:：]\s*(?=[\s\S]{0,40}[\u4E00-\u9FFF])/i, '')

  // A scaffolding tag sits alone on its line, because each block is a section of
  // the preamble — and matched by that shape rather than by name: the block names
  // are neither exhaustive nor uniform, and two batches only surfaced one after
  // the other. A question that opens with markup keeps text on the same line
  // (`<div> 为什么不渲染`), which is what this preserves.
  if (!stripped || /^<[a-z]\w*>\s*\n/i.test(stripped))
    return ''

  return stripped
}

/** Single-line preview for list rows. */
export function toSnippet(raw: string, limit = 60): string {
  const text = extractQuestion(raw).replace(/\s+/g, ' ').trim()

  return text.length > limit ? `${text.slice(0, limit)}…` : text
}
