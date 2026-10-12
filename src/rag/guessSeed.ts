import type { RagChunk, RagDocument } from './types'

export const GUESS_REFERENCE_SEED_KEY = 'guess-reference-seed-v1'
export const GUESS_REFERENCE_ID = 'guess-reference-nailoong-v1'
export const GUESS_REFERENCE_TEXT = `奶龙（Nailoong）角色参考资料
奶龙是第七印象创作的中国原创3D动漫形象，是《奶龙》系列动画的主角。它是虚构的外星幼龙，常被称作黄色小恐龙形象，并非现实动物或现实中可触摸的生物；角色本身也不等于毛绒玩具。
外形特征：黄色皮肤、大脑袋、圆眼睛、圆胖的身体和大肚子。性格呆萌、乐观，喜欢吃东西。它来到地球后与少年小七成为朋友。
检索标签：虚构角色 动画角色 国产动画 恐龙 龙 黄色 圆胖 大肚子 短视频。
本资料只描述角色知识，不说明用户本局心里想的答案。
来源：第七印象官方网站「奶龙」角色介绍 https://www.nailoong.com/ipStar/Nailong/ 及首页 https://www.nailoong.com/ 。核对日期：2026-10-08。`

export function createGuessReference(now = Date.now()): { document: RagDocument; chunks: RagChunk[] } {
  const title = '猜心参考：奶龙（官方角色资料）'
  return {
    document: {
      id: GUESS_REFERENCE_ID,
      title,
      source: 'text',
      charCount: GUESS_REFERENCE_TEXT.length,
      chunkCount: 1,
      createdAt: now,
      updatedAt: now
    },
    chunks: [
      {
        id: `${GUESS_REFERENCE_ID}-0`,
        documentId: GUESS_REFERENCE_ID,
        documentTitle: title,
        index: 0,
        content: GUESS_REFERENCE_TEXT,
        start: 0,
        end: GUESS_REFERENCE_TEXT.length,
        createdAt: now
      }
    ]
  }
}
