interface PdfTextItem {
  str?: string
  hasEOL?: boolean
}

/** 按 PDF 提供的行尾标记保留行；汉字之间不强行加空格，英文词保留分隔。 */
export function joinPdfText(items: PdfTextItem[]): string {
  let result = ''
  for (const item of items) {
    if (typeof item.str !== 'string') continue
    const value = item.str
    if (value) {
      const needsSpace = /[A-Za-z0-9]$/.test(result) && /^[A-Za-z0-9]/.test(value)
      result += `${needsSpace ? ' ' : ''}${value}`
    }
    if (item.hasEOL) result += '\n'
  }
  return result.trim()
}
