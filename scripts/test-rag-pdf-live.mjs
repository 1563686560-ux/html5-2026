// 用复杂 PDF 的提取文本验证表格、跨页规则、资料不足和连续追问。
// 先执行：pdftotext -layout output/pdf/知识库复杂PDF验收样本.pdf tmp/pdfs/知识库复杂PDF验收样本.txt
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { createPinia, setActivePinia } from 'pinia'

const root = resolve(import.meta.dirname, '..')
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const path = resolve(root, 'src', specifier.slice(2))
      return nextResolve(pathToFileURL(existsSync(`${path}.ts`) ? `${path}.ts` : resolve(path, 'index.ts')).href, context)
    }
    if (specifier.startsWith('.') && context.parentURL?.endsWith('.ts')) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL)
      if (existsSync(candidate)) return nextResolve(candidate.href, context)
    }
    return nextResolve(specifier, context)
  }
})
const load = (path) => import(pathToFileURL(resolve(root, path)).href)
const key = (await readFile(resolve(root, 'DeepSeekapikey.txt'), 'utf8')).trim()
const extracted = await readFile(resolve(root, 'tmp/pdfs/知识库复杂PDF验收样本.txt'), 'utf8')
const output = resolve(root, 'docs/验收记录/复杂PDF真实问答.json')
const { chunkText } = await load('src/rag/chunker.ts')
const { keywordSearch } = await load('src/rag/search.ts')
const { buildReferences } = await load('src/rag/references.ts')
const { buildRetrievalQuery } = await load('src/rag/queryContext.ts')
const { assembleMessages } = await load('src/prompt/assembler.ts')
const { getPersona, DEFAULT_PERSONA_ID } = await load('src/data/personas.ts')
const { streamChat } = await load('src/api/llm.ts')
globalThis.window = { setTimeout, clearTimeout }
setActivePinia(createPinia())

const chunks = chunkText(extracted).map((chunk) => ({
  ...chunk,
  id: `pdf-${chunk.index}`,
  documentId: 'pdf',
  documentTitle: '知识库复杂PDF验收样本',
  createdAt: 0
}))
const endpoint = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: key }
const history = []
const results = []
const cases = [
  { id: '表格', question: '云镜展示屏的可用时段、每队上限、押金和负责人分别是什么？', required: ['全天', '60', '500', '顾言'] },
  { id: '追问', question: '什么时候退回？', required: ['关机', '断电', '线缆归位', '验收', '原路'] },
  { id: '跨页', question: '仅关闭屏幕能不能算完成设备归还？还需要哪些步骤？', required: ['不能', '关机', '断电', '线缆归位', '验收'] },
  { id: '资料不足', question: '顾言的电话号码和停车费用分别是多少？', required: [], requiredAny: ['未提供', '没有提供', '资料不足'] }
]

for (const test of cases) {
  const retrievalQuery = buildRetrievalQuery(test.question, history)
  const hits = keywordSearch(chunks, retrievalQuery, 4)
  const references = buildReferences(hits)
  const row = { ...test, retrievalQuery, references, answer: '', checks: {} }
  row.answer = hits.length
    ? await streamChat(
        endpoint,
        assembleMessages(getPersona(DEFAULT_PERSONA_ID), [...history, { role: 'user', content: test.question }], {
          references,
          strictReferences: true
        }),
        { temperature: 0.3, retries: 0, timeoutMs: 60000, signal: AbortSignal.timeout(90000) }
      )
    : '在所选资料中没有检索到足够相关的内容。'
  const citations = [...row.answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]))
  row.checks = {
    hasHits: hits.length > 0,
    requiredTerms:
      test.required.every((term) => row.answer.includes(term)) &&
      (!test.requiredAny || test.requiredAny.some((term) => row.answer.includes(term))),
    hasValidCitation: citations.length > 0 && citations.every((n) => n >= 1 && n <= references.length),
    contextualRetrieval: test.id !== '追问' || retrievalQuery.includes('云镜展示屏')
  }
  history.push({ role: 'user', content: test.question }, { role: 'assistant', content: row.answer })
  results.push(row)
  console.log(`${test.id}: ${Object.values(row.checks).every(Boolean) ? '通过' : '需复核'}`)
}

await mkdir(resolve(root, 'docs/验收记录'), { recursive: true })
await writeFile(output, JSON.stringify({ runAt: new Date().toISOString(), model: 'deepseek-chat', chunkCount: chunks.length, results }, null, 2))
if (results.some((row) => Object.values(row.checks).some((value) => !value))) process.exitCode = 1
