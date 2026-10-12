import type { ChatMessage } from '@/api/types'

const FOLLOW_UP_MARKERS = /^(?:那|那么|然后|还有|另外|它|他|她|这|这个|该|其中)|(?:呢|吗|嘛|又如何)[？?]?$/
const GENERIC_FOLLOW_UP = /什么时候|哪一天|几点|多久|多少|怎么退|如何退|谁负责|在哪里|什么条件|什么要求/

/** Detect a short continuation, while leaving explicitly named new topics independent. */
function isFollowUp(query: string): boolean {
  const compact = query.replace(/[\s，。！？、,.!?]/g, '')
  const genericMatch = compact.match(GENERIC_FOLLOW_UP)
  const genericPrefix = genericMatch ? compact.slice(0, genericMatch.index).replace(/[的是有要还]/g, '') : ''
  return compact.length <= 18 && (FOLLOW_UP_MARKERS.test(query) || Boolean(genericMatch && genericPrefix.length <= 2))
}

/** Carry the last explicit topic plus its follow-up chain. No additional model request. */
export function buildRetrievalQuery(current: string, history: ChatMessage[]): string {
  const query = current.trim()
  if (!isFollowUp(query)) return query
  const previous = history.filter((message) => message.role === 'user' && message.content.trim()).slice(-8)
  const context: string[] = []
  for (let index = previous.length - 1; index >= 0; index--) {
    const text = previous[index]!.content.trim()
    context.unshift(text.slice(0, 400))
    if (!isFollowUp(text)) break
  }
  if (!context.length) return query
  // Preserve the topic and the nearest continuations without allowing retrieval input to grow indefinitely.
  const recent = context.length > 4 ? [context[0]!, ...context.slice(-3)] : context
  return [...recent, query].join('\n')
}
