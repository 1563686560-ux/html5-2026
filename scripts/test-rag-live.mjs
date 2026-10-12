// 使用虚构资料验证当前检索、提示词与真实流式模型。不会读取用户知识库。
// node scripts/test-rag-live.mjs
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { createPinia, setActivePinia } from 'pinia'

const root = resolve(import.meta.dirname, '..')
// Node 原生剥离 TypeScript 类型，仅补齐应用的路径别名及无扩展名导入。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const path = resolve(root, 'src', specifier.slice(2))
      return nextResolve(
        pathToFileURL(existsSync(`${path}.ts`) ? `${path}.ts` : resolve(path, 'index.ts')).href,
        context
      )
    }
    if (specifier.startsWith('.') && context.parentURL?.endsWith('.ts')) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL)
      if (existsSync(candidate)) return nextResolve(candidate.href, context)
    }
    return nextResolve(specifier, context)
  }
})
const loadModule = (path) => import(pathToFileURL(resolve(root, path)).href)
const output = resolve(root, 'docs/验收记录/知识库真实问答.json')
const key = (await readFile(resolve(root, 'DeepSeekapikey.txt'), 'utf8')).trim()
if (!key) throw new Error('测试接口密钥为空')
console.log('正在加载应用的检索与模型客户端…')
const results = []
{
  const { chunkText } = await loadModule('src/rag/chunker.ts')
  const { useRagStore } = await loadModule('src/stores/rag.ts')
  const { useSettingsStore } = await loadModule('src/stores/settings.ts')
  const { buildReferences } = await loadModule('src/rag/references.ts')
  const { assembleMessages } = await loadModule('src/prompt/assembler.ts')
  const { getPersona, DEFAULT_PERSONA_ID } = await loadModule('src/data/personas.ts')
  const { streamChat } = await loadModule('src/api/llm.ts')
  globalThis.window = { setTimeout, clearTimeout }
  console.log('应用模块加载完成，开始验收。')
  setActivePinia(createPinia())
  const rag = useRagStore()
  const settings = useSettingsStore()
  settings.api.embed = { baseUrl: '', model: '', apiKey: '' }
  for (const [id, title] of [
    ['a', '星桥项目'],
    ['b', '海岚项目']
  ]) {
    const text = await readFile(resolve(root, `tests/fixtures/rag/${title}.txt`), 'utf8')
    rag.chunks.push(
      ...chunkText(text).map((chunk) => ({
        ...chunk,
        id: `${id}-${chunk.index}`,
        documentId: id,
        documentTitle: title,
        createdAt: 0
      }))
    )
  }
  const cases = [
    {
      id: 'A技术',
      scope: 'a',
      question: '星桥项目的网站使用什么前端框架、打包工具和数据库？',
      expected: 'Vue 3、Vite、本机 IndexedDB',
      required: ['Vue', 'Vite', 'IndexedDB'],
      forbidden: ['React', 'Webpack', 'PostgreSQL']
    },
    {
      id: 'B技术',
      scope: 'b',
      question: '海岚项目的网站使用什么前端框架、打包工具和数据库？',
      expected: 'React、Webpack、PostgreSQL',
      required: ['React', 'Webpack', 'PostgreSQL'],
      forbidden: ['Vue', 'Vite', 'IndexedDB']
    },
    {
      id: 'A报名',
      scope: 'a',
      question: '星桥项目报名截止日期、团队人数和报名费分别是什么？',
      expected: '2026年10月28日；3至5人；不收费',
      required: ['10月28', '3', '5'],
      forbidden: ['11月20', '80元']
    },
    {
      id: 'A经费',
      scope: 'a',
      question: '星桥项目的物料经费上限是多少，获奖后有没有现金奖金？',
      expected: '1200元；只有证书，没有现金奖金',
      required: ['1200', '证书'],
      forbidden: ['3600', '300元']
    },
    {
      id: 'B经费',
      scope: 'b',
      question: '海岚项目的物料经费和奖项奖金各是多少？',
      expected: '经费上限3600元；每个获奖团队300元及证书',
      required: ['3600', '300', '证书'],
      forbidden: ['1200']
    },
    {
      id: '资料不足',
      scope: 'a',
      question: '星桥项目评委的姓名和联系电话是什么？',
      expected: '明确资料未提供，不能编造',
      required: [],
      forbidden: []
    },
    {
      id: '无关问题',
      expectedModelCall: false,
      scope: 'a',
      question: '冥王星的卫星轨道周期是多少？',
      expected: '无命中，停止调用模型并说明资料不足',
      required: [],
      forbidden: []
    },
    {
      id: '综合解释',
      scope: 'a',
      question: '请用通顺的一段话说明，星桥项目为什么不能在断网时生成新的智能回答，以及如何判断回答有没有资料依据。',
      expected: '智能问答依赖外部模型；核对编号对应原文是否支持结论',
      required: ['模型', '原文'],
      forbidden: []
    },
    {
      id: '全部资料对比',
      question: '比较星桥与海岚两个项目的前端框架和资料存储方式，不要混用。',
      expected: '分别对应 Vue 3/本机IndexedDB 和 React/服务器PostgreSQL',
      required: ['星桥', '海岚', 'Vue', 'React', 'IndexedDB', 'PostgreSQL'],
      forbidden: []
    }
  ]
  for (const test of cases) {
    const start = Date.now()
    const hits = await rag.search(test.question, 4, test.scope)
    const references = buildReferences(hits)
    const row = { ...test, references, modelCalled: false, answer: '', checks: {}, elapsedMs: 0 }
    try {
      if (test.scope && !hits.length)
        row.answer = '在所选资料中没有检索到足够相关的内容。请换一种问法，或检查是否选对了资料。'
      else {
        row.modelCalled = true
        row.answer = await streamChat(
          { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: key },
          assembleMessages(getPersona(DEFAULT_PERSONA_ID), [{ role: 'user', content: test.question }], {
            references,
            strictReferences: Boolean(test.scope)
          }),
          {
            temperature: hits.length ? 0.3 : 0.8,
            retries: 0,
            timeoutMs: 60000,
            signal: AbortSignal.timeout(90000),
            onFinish: (info) => {
              row.truncated = info.truncated
            }
          }
        )
      }
      const citations = [...row.answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]))
      row.checks = {
        expectedModelCall: test.expectedModelCall === undefined || row.modelCalled === test.expectedModelCall,
        selectedScopeOnly: !test.scope || references.every((ref) => ref.documentId === test.scope),
        requiredTerms: test.required.every((term) => row.answer.includes(term)),
        noForbiddenTerms: test.forbidden.every((term) => !row.answer.includes(term)),
        citationNumbersValid: citations.every((n) => n >= 1 && n <= references.length),
        hasCitation: !row.modelCalled || citations.length > 0,
        completeStream: !row.truncated
      }
    } catch (error) {
      row.error = String(error.message).split(key).join('[redacted]')
    }
    row.elapsedMs = Date.now() - start
    results.push(row)
    await mkdir(resolve(root, 'docs/验收记录'), { recursive: true })
    await writeFile(
      output,
      JSON.stringify(
        {
          runAt: new Date().toISOString(),
          model: 'deepseek-chat',
          mode: '真实模型、关键词检索、虚构资料；未覆盖浏览器导入和向量检索',
          results
        },
        null,
        2
      )
    )
    console.log(
      `${test.id}: ${row.error ? row.error : Object.values(row.checks).every(Boolean) ? '规则检查通过' : '需要人工复核'} (${Math.round(row.elapsedMs / 1000)}s)`
    )
    // 接口故障时停止，避免连续无效请求。
    if (row.error) break
  }
}
console.log('结果已保存：docs/验收记录/知识库真实问答.json')
if (results.some((row) => row.error || Object.values(row.checks).some((value) => !value))) process.exitCode = 1
