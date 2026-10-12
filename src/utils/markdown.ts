/**
 * Markdown 渲染（增量 / 分块）
 * ------------------------------------------------------------------
 * 问题：流式输出时如果每帧都把整篇回答重新 parse 一遍，回答越长越卡。
 * 一篇 3000 字的回答，末尾每多一个字就重解析 3000 字 —— 接近 O(n²)。
 *
 * 方案：按「顶层块」切分，逐块渲染并缓存。
 * 流式过程中只有最后一块在变，前面的块全部命中缓存，
 * 于是每帧的工作量从"整篇"降到"最后一块"。
 *
 * 配合 MarkdownView 逐个块绑定 v-html，Vue 也只会 patch 变化的那一块 DOM，
 * 不会把整篇重建 —— 这是不掉帧的关键。
 *
 * 说明：真正意义上的「流式 Markdown 增量解析」（维护 parser 状态、
 * 只吐出新增 token 对应的 DOM）需要改 marked 的词法分析器，代价远大于收益。
 * 分块缓存拿到了绝大部分收益，代码量却只有几十行。
 *
 * 另外必须消毒：模型输出会直接变成 HTML，若被注入 <script> 或 onerror
 * 之类的属性就是 XSS 漏洞 —— 即使内容来自模型也不能信任。
 */

import DOMPurify from 'dompurify'
import { marked } from 'marked'

marked.setOptions({
  gfm: true,
  // 单个换行也当换行，更符合聊天场景的书写习惯
  breaks: true
})

// 不用 as const：DOMPurify 的 Config 要求可变数组，readonly 元组不兼容
const PURIFY_OPTIONS = {
  ADD_ATTR: ['target', 'rel'],
  FORBID_TAGS: ['script', 'style', 'iframe', 'form', 'input']
}

export interface MarkdownBlock {
  /** 块序号。内容只追加不回改，所以序号稳定，可直接用作 v-for 的 key */
  index: number
  html: string
}

/* ------------------------------------------------------------------ */
/* 分块                                                                */
/* ------------------------------------------------------------------ */

type Kind = 'blank' | 'fence' | 'heading' | 'hr' | 'quote' | 'list' | 'table' | 'text'

function kindOf(line: string): Kind {
  const t = line.trim()
  if (!t) return 'blank'
  if (/^(```|~~~)/.test(t)) return 'fence'
  if (/^#{1,6}\s/.test(t)) return 'heading'
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) return 'hr'
  if (/^>\s?/.test(t)) return 'quote'
  if (/^([-*+]|\d+[.)])\s/.test(t)) return 'list'
  if (/^\|.*\|$/.test(t)) return 'table'
  return 'text'
}

/**
 * 列表 / 引用 / 表格允许中间夹空行仍算同一块。
 * 否则一个「松散列表」会被拆成多块，渲染成一串各自独立的 <ul>，
 * 编号重新从头开始 —— 看起来就是 bug。
 */
function continues(prev: Kind, next: Kind): boolean {
  return prev === next && (prev === 'list' || prev === 'quote' || prev === 'table')
}

/** 把 Markdown 源码切成顶层块 */
export function splitMarkdownBlocks(source: string): string[] {
  const lines = source.split('\n')
  const blocks: string[] = []
  let current: string[] = []
  let inFence = false
  let fenceMarker = ''

  const flush = (): void => {
    const text = current.join('\n').trim()
    if (text) blocks.push(text)
    current = []
  }

  const lastKind = (): Kind => {
    for (let i = current.length - 1; i >= 0; i--) {
      const k = kindOf(current[i])
      if (k !== 'blank') return k
    }
    return 'blank'
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const t = line.trim()

    // 围栏代码块内部一律不切分：里面的 # 和 - 都不是 Markdown 语法
    if (inFence) {
      current.push(line)
      if (t.startsWith(fenceMarker)) {
        inFence = false
        flush()
      }
      continue
    }

    const kind = kindOf(line)

    if (kind === 'fence') {
      flush()
      inFence = true
      fenceMarker = t.slice(0, 3)
      current.push(line)
      continue
    }

    if (kind === 'blank') {
      const prev = lastKind()
      let j = i + 1
      while (j < lines.length && !lines[j].trim()) j++
      const next = j < lines.length ? kindOf(lines[j]) : 'blank'

      if (current.length > 0 && continues(prev, next)) {
        current.push(line)
        continue
      }
      flush()
      continue
    }

    // 标题与分割线自成一块，避免和正文粘在一起影响缓存命中
    if (kind === 'heading' || kind === 'hr') {
      flush()
      current.push(line)
      flush()
      continue
    }

    current.push(line)
  }

  // 流式进行到一半时，未闭合的围栏也会走到这里，内容照常成块
  flush()
  return blocks
}

/* ------------------------------------------------------------------ */
/* 渲染与缓存                                                          */
/* ------------------------------------------------------------------ */

function parseAndSanitize(source: string): string {
  const raw = marked.parse(source, { async: false }) as string
  return DOMPurify.sanitize(raw, PURIFY_OPTIONS)
}

/** 块源码 → HTML。用源码本身做 key，内容相同的块自然共享缓存 */
const cache = new Map<string, string>()
const CACHE_LIMIT = 500

function renderBlock(source: string): string {
  const hit = cache.get(source)
  if (hit !== undefined) return hit

  const clean = parseAndSanitize(source)

  if (cache.size >= CACHE_LIMIT) {
    // 简单淘汰：丢掉最早插入的一批。块内容重复率低，不值得上 LRU
    const keys = cache.keys()
    for (let i = 0; i < 100; i++) {
      const next = keys.next()
      if (next.done) break
      cache.delete(next.value)
    }
  }
  cache.set(source, clean)
  return clean
}

let lastSource = ''
let lastBlocks: MarkdownBlock[] = []

/**
 * 把 Markdown 渲染成块数组。
 *
 * @param streaming 流式进行中。此时最后一块每帧都在变，缓存它只会白白
 *                  挤掉历史块的位置，所以流式时不缓存末块。
 */
export function renderMarkdownBlocks(source: string, streaming = false): MarkdownBlock[] {
  if (!source) return []

  // 非流式场景下同一个源码常常被重复请求（例如用户上滑触发重渲染）
  const memoKey = streaming ? '' : source
  if (memoKey && memoKey === lastSource) return lastBlocks

  const raw = splitMarkdownBlocks(source)
  const blocks: MarkdownBlock[] = raw.map((block, index) => ({
    index,
    html: streaming && index === raw.length - 1 ? parseAndSanitize(block) : renderBlock(block)
  }))

  if (memoKey) {
    lastSource = memoKey
    lastBlocks = blocks
  }
  return blocks
}

/** 一次性渲染整篇（导出、预览等非流式场景） */
export function renderMarkdown(source: string): string {
  return source ? parseAndSanitize(source) : ''
}

/* ------------------------------------------------------------------ */
/* 纯文本降级                                                          */
/* ------------------------------------------------------------------ */

/**
 * Markdown 转纯文本。
 * 导出长图时 Canvas 画不了 HTML，只能先把 Markdown 退化成纯文本。
 * 这里不做完整的 Markdown 解析，只处理聊天场景里真正会出现的语法。
 */
export function markdownToPlainText(source: string): string {
  return source
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
