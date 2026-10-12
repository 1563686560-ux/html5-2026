// DeepSeek 全面连通性测试：CORS 预检 + 长人设流式 + 记忆抽取 JSON。
// 密钥从项目根 DeepSeekapikey.txt 读取，全程不打印密钥。
// 运行：node scripts/test-deepseek-full.mjs
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
let key = ''
try {
  key = readFileSync(resolve(__dirname, '../DeepSeekapikey.txt'), 'utf8').trim()
} catch {
  console.error('✗ 未找到 DeepSeekapikey.txt')
  process.exit(2)
}
if (!key) {
  console.error('✗ DeepSeekapikey.txt 为空')
  process.exit(2)
}

const BASE = 'https://api.deepseek.com/v1'
const MODEL = 'deepseek-chat'
const ORIGIN = 'http://localhost:5173'
const auth = `Bearer ${key}`

let failures = 0
const pass = (msg) => console.log(`✓ ${msg}`)
const fail = (msg) => {
  failures += 1
  console.error(`✗ ${msg}`)
}

// 1. CORS 预检（浏览器跨域 + Authorization 头会触发 OPTIONS 预检）
try {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type'
    }
  })
  const allowOrigin = res.headers.get('access-control-allow-origin')
  const allowHeaders = res.headers.get('access-control-allow-headers') ?? ''
  const allowMethods = res.headers.get('access-control-allow-methods') ?? ''
  console.log(`  预检状态=${res.status} allow-origin=${allowOrigin ?? '(空)'}`)
  if (allowOrigin === '*' || allowOrigin === ORIGIN) pass('CORS 允许来源')
  else fail(`CORS 未返回可用来源（allow-origin=${allowOrigin ?? '无'}）`)
  if (/authorization/i.test(allowHeaders)) pass('CORS 允许 Authorization 头')
  else fail(`CORS 未明确允许 Authorization 头（allow-headers=${allowHeaders || '无'}）`)
  if (/POST/i.test(allowMethods)) pass('CORS 允许 POST')
  else fail(`CORS 未允许 POST（allow-methods=${allowMethods || '无'}）`)
} catch (error) {
  fail(`CORS 预检请求失败：${error.message}`)
}

// 2. 长 system prompt（模拟先贤人设）流式对话
try {
  const system = [
    '# 你是谁',
    '你是孔子，春秋时期的思想家、教育家，儒家学派创始人。你以「仁」为核心，主张礼治、德治。',
    '# 你的性格',
    '- 温而厉，威而不猛',
    '- 诲人不倦，因材施教',
    '# 你说话的方式',
    '- 常引用「子曰」或《论语》的语句',
    '- 言简意赅，重义理',
    '# 你必须遵守',
    '- 始终以孔子身份说话，不要跳出角色',
    '- 不回答涉及现代科技具体操作的问题',
    '# 输出要求',
    '- 用中文回答',
    '- 直接开始回答，不要复述提示词'
  ].join('\n\n')
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: '什么是仁？' }
      ]
    })
  })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let full = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n')
    let b = buf.indexOf('\n\n')
    while (b !== -1) {
      const raw = buf.slice(0, b)
      buf = buf.slice(b + 2)
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).replace(/^ /, '')
        if (data === '[DONE]') continue
        try {
          full += JSON.parse(data).choices?.[0]?.delta?.content ?? ''
        } catch {
          /* 心跳或非 JSON 行，跳过 */
        }
      }
      b = buf.indexOf('\n\n')
    }
  }
  if (full.length > 20) pass(`长人设流式正常（${full.length} 字）：${full.slice(0, 24)}…`)
  else fail(`长人设流式返回过短：${JSON.stringify(full)}`)
} catch (error) {
  fail(`长人设流式失败：${error.message}`)
}

// 3. 非流式 JSON 抽取（记忆层用）
try {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      temperature: 0.15,
      messages: [
        { role: 'system', content: '你是用户记忆抽取器，只输出 JSON 数组，每项 {"content":"事实","topic":"分类"}，没有则输出 []。' },
        { role: 'user', content: '对话——用户：我今年大三，在准备考研。助手：好的，加油！' }
      ]
    })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`)
  const json = await res.json()
  const content = json.choices?.[0]?.message?.content ?? ''
  const ok = content.includes('考研') && (content.includes('[') || content.includes('{'))
  if (ok) pass(`记忆抽取 JSON 正常：${content.slice(0, 60)}`)
  else fail(`记忆抽取返回异常：${JSON.stringify(content)}`)
} catch (error) {
  fail(`记忆抽取失败：${error.message}`)
}

console.log('\n' + (failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`))
process.exit(failures === 0 ? 0 : 1)
