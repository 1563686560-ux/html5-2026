/** PDF 文本层提取（pdf.js）。扫描版无文本层时返回空文本，调用方需提示粘贴兜底。 */
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import PdfJsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'
import { joinPdfText } from './pdfText'

let workerReady = false

function ensureWorker(): void {
  if (workerReady) return
  GlobalWorkerOptions.workerPort = new PdfJsWorker()
  workerReady = true
}

export interface PdfExtractResult {
  text: string
  pageCount: number
  hasText: boolean
}

export async function extractPdfText(
  data: ArrayBuffer,
  onProgress?: (done: number, total: number) => void
): Promise<PdfExtractResult> {
  ensureWorker()
  const loadingTask = getDocument({ data })
  const doc = await loadingTask.promise
  const pageCount = doc.numPages
  let text = ''

  try {
    for (let pageIndex = 1; pageIndex <= pageCount; pageIndex++) {
      const page = await doc.getPage(pageIndex)
      const content = await page.getTextContent()
      const pageText = joinPdfText(content.items.filter((item) => 'str' in item))
      text += pageText ? `${pageText}\n\n` : ''
      onProgress?.(pageIndex, pageCount)
    }
  } finally {
    await loadingTask.destroy()
  }

  const trimmed = text.trim()
  return { text: trimmed, pageCount, hasText: trimmed.length > 0 }
}
