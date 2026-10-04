/**
 * 颜色对比度工具。
 *
 * 装修配置里的文字色是运营在后台自由填的，很容易出现「白字 + 浅色底」这类不可见组合
 * （首页装修就是 titleColor=#ffffff + bgColor=#f5f6fa）。这里按 WCAG 相对亮度做兜底，
 * 对比度不足时自动退到可读的深色 / 浅色，避免标题「看起来没渲染」。
 */

/** 解析 #RGB / #RRGGBB / rgb(r,g,b) 为 [r,g,b]，解析失败返回 null */
function parseColor(input?: string): [number, number, number] | null {
  if (!input) {
    return null
  }
  const value = String(input).trim().toLowerCase()
  const hex = value.replace(/^#/, '')
  if (/^[0-9a-f]{3}$/.test(hex)) {
    return [
      Number.parseInt(hex[0] + hex[0], 16),
      Number.parseInt(hex[1] + hex[1], 16),
      Number.parseInt(hex[2] + hex[2], 16),
    ]
  }
  if (/^[0-9a-f]{6}$/.test(hex)) {
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
    ]
  }
  const rgb = value.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/)
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  }
  return null
}

/** WCAG 相对亮度（0 最暗 ~ 1 最亮） */
function relativeLuminance(color: [number, number, number]) {
  const [r, g, b] = color.map((c) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * 两色对比度（1 ~ 21）。任一颜色无法解析时返回 21（视为达标，不做兜底）
 */
export function contrastRatio(foreground?: string, background?: string) {
  const fg = parseColor(foreground)
  const bg = parseColor(background)
  if (!fg || !bg) {
    return 21
  }
  const l1 = relativeLuminance(fg)
  const l2 = relativeLuminance(bg)
  const [light, dark] = l1 >= l2 ? [l1, l2] : [l2, l1]
  return (light + 0.05) / (dark + 0.05)
}

/**
 * 取可读的文字色：配置色与底色的对比度达标就原样使用，否则按底色明暗退到深色 / 浅色。
 *
 * @param textColor 配置的文字色（缺失时用深色）
 * @param backgroundColor 文字背后的底色
 * @param minRatio 最低对比度，默认 3（WCAG AA 对大字号的阈值）
 */
export function pickReadableTextColor(textColor?: string, backgroundColor?: string, minRatio = 3) {
  const fallbackDark = '#111827'
  const fallbackLight = '#FFFFFF'
  if (!textColor) {
    return fallbackDark
  }
  if (contrastRatio(textColor, backgroundColor) >= minRatio) {
    return textColor
  }
  const bg = parseColor(backgroundColor)
  // 底色解析不出来（例如是配图）时按浅色底处理，深色字更稳妥
  if (bg && relativeLuminance(bg) < 0.5) {
    return fallbackLight
  }
  return fallbackDark
}

/**
 * 不看配置，直接按底色明暗给可读文字色：浅底给深色、深底给浅色。
 *
 * 用于「配置色与底色几乎同色（完全看不见）」的兜底：这类组合属配置失误而非设计意图，
 * 不能原样透传（例：首页 pageBase 就是 titleColor=#ffffff + bgColor=#f5f6fa，标题整条看不见）。
 */
export function pickReadableByBackground(backgroundColor?: string) {
  const bg = parseColor(backgroundColor)
  if (bg && relativeLuminance(bg) < 0.5) {
    return '#FFFFFF'
  }
  return '#111827'
}

/**
 * 「几乎同色」阈值：对比度低于此值即视为标题完全看不见（配置失误）。
 *
 * 取 1.5 是为了只拦真正不可见的极端组合（白配白 1.0、白配 #f5f6fa 1.1），
 * 而运营有意配的低对比度色仍在阈值之上（红字浅底 3.6、白字深底 ≥ 8），不会被误伤。
 */
export const INVISIBLE_CONTRAST_RATIO = 1.5
