import { expect, it } from 'vitest'
import { joinPdfText } from './pdfText'

it('保留中文词语及 PDF 行边界，不把下一行串入上一句', () => {
  expect(joinPdfText([{ str: '人工' }, { str: '智能', hasEOL: true }, { str: '应用范围' }])).toBe('人工智能\n应用范围')
})
it('保留英文词间距及空文本的行尾', () => {
  expect(joinPdfText([{ str: 'Machine' }, { str: 'learning' }, { str: '', hasEOL: true }, { str: '技术' }])).toBe(
    'Machine learning\n技术'
  )
})
