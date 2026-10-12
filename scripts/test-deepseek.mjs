// DeepSeek 端到端连通性测试。
// 密钥从项目根目录 DeepSeekapikey.txt 读取（该文件已被 .gitignore 排除），
// 全程不打印密钥内容。运行：node scripts/test-deepseek.mjs
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const keyFile = resolve(__dirname, '../DeepSeekapikey.txt')

let key = ''
try {
  key = readFileSync(keyFile, 'utf8').trim()
} catch {
  console.error('✗ 未找到 DeepSeekapikey.txt，跳过端到端测试（该文件不提交仓库）')
  process.exit(2)
}
if (!key) {
  console.error('✗ DeepSeekapikey.txt 为空')
  process.exit(2)
}

const BASE = 'https://api.deepseek.com/v1'
const MODEL = 'deepseek-chat'
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }

async function testStreaming() {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      messages: [{ role: 'user', content: '请只回复四个字：测试成功' }]
    })
  })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    buffer = buffer.replace(/\r\n?/g, '\n')
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).replace(/^ /, '')
        if (data === '[DONE]') continue
        try {
          full += JSON.parse(data).choices?.[0]?.delta?.content ?? ''
        } catch {
          /* 忽略无法解析的分片 */
        }
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
  return full
}

async function testNonStreaming() {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      temperature: 0,
      messages: [{ role: 'user', content: '回复：OK' }]
    })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = await res.json()
  return json.choices?.[0]?.message?.content ?? ''
}

let failed = false
try {
  const streamText = await testStreaming()
  console.log(`✓ 流式对话接口正常，收到 ${streamText.length} 字符：${streamText.slice(0, 40)}`)
} catch (error) {
  failed = true
  console.error('✗ 流式对话接口失败：', error.message)
}

try {
  const plainText = await testNonStreaming()
  console.log(`✓ 非流式补全接口正常（记忆抽取用）：${plainText.slice(0, 40)}`)
} catch (error) {
  failed = true
  console.error('✗ 非流式补全接口失败：', error.message)
}

process.exit(failed ? 1 : 0)
