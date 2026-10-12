/** 纯 JS 关键词检索 + 向量余弦检索 */
import type { RagChunk, SearchHit } from './types'

/**
 * 查询单元。
 *
 * 中文没有空格，最省事的做法是把汉字拆成单字去比 —— 但单字几乎没有区分度：
 * 「这个项目用了什么技术」会命中任何含有「用」或「了」的片段，
 * 于是随便一段无关资料都能当上「参考资料」塞进提示词，
 * 模型只能照着它答或者答「资料里没有相关内容」，用户看到的就是「回答怪怪的」。
 *
 * 所以这里把单元分成两档：
 *   - 单字（弱）：只能说明「碰巧出现过」，权重低；
 *   - 二元词组 / 完整英文单词（强）：命中了才说明真的相关。
 * 一条强单元都没命中的片段直接淘汰。
 */
interface QueryUnit {
  text: string
  weight: number
  strong: boolean
}

/** 单字权重 */
const CHAR_WEIGHT = 1
/** 二元词组与英文单词的权重 */
const UNIT_WEIGHT = 3

/**
 * 关键词检索的最低相关度。
 * 低于它宁可什么都不给 —— 没有资料总比塞一堆噪声进提示词好。
 */
export const MIN_KEYWORD_SCORE = 0.15

/** 相对下限：与最佳命中差太远的也丢掉，绝对分数说明不了小语料里的相对质量 */
const RELATIVE_FLOOR = 0.5

/**
 * 先切掉问句套语，再生成二元词组，避免把「周期是多少」里的「期是」
 * 与「截止日期是」当成主题相关。使用分隔符而非空串，不能制造新的跨词组合。
 * 不直接删除「是」等单字，以保留「是非观」这样的实义词。
 */
const QUERY_FILLERS =
  /请问|请告诉我|告诉我|为什么|怎么样|怎么|如何|(?:是|为|有)?多少|(?:是|有)?什么|有哪些|哪些|是否|能否/g
// 通用谓语不能独自证明一个具体主题相关；直接搜索该词时仍允许命中。
const GENERIC_PAIRS = new Set(['运行', '使用', '进行', '可以', '需要', '相关'])

function queryUnits(query: string): QueryUnit[] {
  const units = new Map<string, QueryUnit>()
  const add = (text: string, weight: number, strong: boolean): void => {
    const existing = units.get(text)
    if (!existing || existing.weight < weight) units.set(text, { text, weight, strong })
  }

  const words =
    query
      .toLowerCase()
      .replace(QUERY_FILLERS, ' ')
      .match(/[\u4e00-\u9fff]+|[a-z0-9]+/g) ?? []
  for (const word of words) {
    if (/^[\u4e00-\u9fff]+$/.test(word)) {
      const chars = Array.from(word)
      for (const char of chars) add(char, CHAR_WEIGHT, false)
      for (let i = 0; i < chars.length - 1; i++) {
        const pair = chars[i] + chars[i + 1]
        // 「的关」「了什」等跨助词片段不应成为强相关证据。
        if (!/[的了呢吗啊]/.test(pair)) {
          const strong = !GENERIC_PAIRS.has(pair) || word === pair
          add(pair, strong ? UNIT_WEIGHT : CHAR_WEIGHT, strong)
        }
      }
    } else {
      // 英文单词、数字、中英混排的整串本身就是一个语义单位，不再往下拆
      add(word, UNIT_WEIGHT, true)
    }
  }

  return [...units.values()]
}

/** 两种分数尺度不同，按名次融合；未向量化的资料仍可通过关键词参与。 */
export function mergeSearchHits(keyword: SearchHit[], vector: SearchHit[], topK: number): SearchHit[] {
  const ranked = new Map<string, { hit: SearchHit; rankScore: number }>()
  for (const list of [keyword, vector]) {
    list.forEach((hit, index) => {
      const current = ranked.get(hit.chunk.id)
      if (current) current.rankScore += 1 / (60 + index + 1)
      else ranked.set(hit.chunk.id, { hit, rankScore: 1 / (60 + index + 1) })
    })
  }
  return [...ranked.values()]
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, topK)
    .map((item) => item.hit)
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0
}

export function keywordSearch(chunks: RagChunk[], query: string, topK = 5): SearchHit[] {
  const units = queryUnits(query)
  if (!units.length) return []

  const totalWeight = units.reduce((sum, unit) => sum + unit.weight, 0)
  const hasStrongUnit = units.some((unit) => unit.strong)

  const scored = chunks
    .map((chunk) => {
      const content = chunk.content.toLowerCase()
      let matched = 0
      let strongMatched = 0
      for (const unit of units) {
        if (!content.includes(unit.text)) continue
        matched += unit.weight
        if (unit.strong) strongMatched += 1
      }
      return { chunk, score: matched / totalWeight, strongMatched }
    })
    // 一条强单元都没命中，说明只是撞上了几个常用字，不算相关
    .filter((hit) => (hasStrongUnit ? hit.strongMatched > 0 : hit.score > 0))

  if (!scored.length) return []

  const best = Math.max(...scored.map((hit) => hit.score))
  const floor = Math.max(MIN_KEYWORD_SCORE, best * RELATIVE_FLOOR)

  return scored
    .filter((hit) => hit.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((hit) => ({ chunk: hit.chunk, score: hit.score, mode: 'keyword' as const }))
}

export function vectorSearch(chunks: RagChunk[], vector: number[], topK = 5): SearchHit[] {
  return chunks
    .filter((chunk) => chunk.vector && chunk.vector.length === vector.length)
    .map((chunk) => ({ chunk, score: cosineSimilarity(chunk.vector!, vector), mode: 'vector' as const }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}
