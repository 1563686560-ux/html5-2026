/** 显式启用 GUESS_LIVE=1 才调用真实接口；普通测试不联网、不消耗额度。
 * 运行：$env:GUESS_LIVE='1'; npm test -- src/stores/guess.live.test.ts
 * 回答模型只是测试辅助，不代表真人准确率；最终确认必须精确匹配目标。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createPinia, setActivePinia } from 'pinia'
import { expect, it, vi } from 'vitest'
import { streamChat } from '@/api/llm'
import * as llm from '@/api/llm'
import { useGuessStore } from './guess'
import { useSettingsStore } from './settings'
import { extractGuessCandidate, MAX_ROUNDS, parseJsonLoose } from '@/prompt/guess'
import { useRagStore } from './rag'
import { normalizeGuessName } from '@/prompt/guessReasoning'

// 真实模型与真实知识库检索；仅把浏览器 IndexedDB 换成内存事务。
const { testDatabase } = vi.hoisted(() => ({ testDatabase: new Map<string, Map<string, unknown>>() }))
vi.mock('@/db', () => ({
  STORE: { documents: 'documents', chunks: 'chunks', kv: 'kv' },
  kvGet: async (key: string) => (testDatabase.get('kv')?.get(key) as { value: unknown } | undefined)?.value,
  kvSet: async () => undefined,
  dbGetAllByIndex: async (store: string) => [...(testDatabase.get(store)?.values() ?? [])],
  dbPut: async () => undefined,
  dbWriteTransaction: async (_stores: string[], write: (tx: unknown) => void) => {
    write({
      objectStore: (store: string) => ({
        put: (value: { id?: string; key?: string }) => {
          if (!testDatabase.has(store)) testDatabase.set(store, new Map())
          testDatabase.get(store)!.set((value.id ?? value.key)!, value)
        }
      })
    })
  }
}))

it.skipIf(process.env.GUESS_LIVE !== '1').each([
  ['奶龙', '测试设定：黄色、圆胖的国产虚构动画角色，恐龙形象。目标是角色本身，不是玩具、周边商品或现实动物。'],
  ['微波炉', '测试设定：现实厨房中的电器，用微波加热食物。不是品牌或某个特定型号。'],
  [
    '大熊猫',
    '测试设定：现实动物，黑白毛色，哺乳动物，主要吃竹子，不是动画角色或玩偶。问食性按主要食物回答，不把食肉目分类等同于主要吃肉。'
  ],
  ['皮卡丘', '测试设定：宝可梦中的虚构角色，黄色、电属性，红色脸颊、尖耳朵，老鼠般的形象，不是真实动物。'],
  ['孙悟空', '测试设定：中国古典小说《西游记》中的虚构神话人物，猴子形象，会七十二变，使用金箍棒。不是龙珠同名人物。'],
  ['电风扇', '测试设定：现实家用电器，用电机驱动扇叶产生气流，通常用于夏天吹风降温。不是空调或特定品牌型号。'],
  ['月亮', '测试设定：地球唯一的天然卫星，现实存在的天体，反射太阳光，不是恒星，不是神话角色。'],
  ['埃菲尔铁塔', '测试设定：位于法国巴黎的现实铁制塔状建筑地标，不是动画角色、模型或交通工具。'],
  ['雨伞', '测试设定：现实生活中手持的雨伞，用伞面遮雨，可撑开和收拢，不是遮阳棚或特定品牌。'],
  ['吉他', '测试设定：现实中常见的六弦木吉他，拨弦发声的乐器，不是电吉他或特定品牌型号。'],
  ['长城', '测试设定：中国的现实历史建筑群，绵延的防御城墙，不是长城汽车品牌或模型。']
])(
  '真实 deepseek-flash：%s 从零开始猜',
  async (target, description) => {
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    const requests: { stage: string; response: string; referenceCount: number }[] = []
    const playerAnswers: { round: number; question: string; answer: string; basis: string }[] = []
    const started = Date.now()
    const originalStreamChat = llm.streamChat
    const streamSpy = vi.spyOn(llm, 'streamChat').mockImplementation(async (...args) => {
      const response = await originalStreamChat(...args)
      requests.push({
        stage: args[1][0]?.content.split('\n')[0] ?? '',
        response,
        referenceCount: args[1].filter((message) => message.content.startsWith('知识库检索参考')).length
      })
      return response
    })
    let game: ReturnType<typeof useGuessStore> | undefined
    try {
      const key = readFileSync(new URL('../../DeepSeekapikey.txt', import.meta.url), 'utf8').trim()
      setActivePinia(createPinia())
      testDatabase.clear()
      const settings = useSettingsStore()
      settings.api.chat = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: key }
      await useRagStore().init()
      expect(useRagStore().documents.some((doc) => doc.title.includes('奶龙'))).toBe(true)
      game = useGuessStore()
      const aliases: Record<string, string[]> = {
        月亮: ['月球'],
        电风扇: ['风扇'],
        大熊猫: ['熊猫'],
        埃菲尔铁塔: ['巴黎铁塔', '埃菲尔塔'],
        吉他: ['木吉他', '原声吉他'],
        长城: ['万里长城'],
        雨伞: ['伞']
      }
      const isCorrect = (name: string) =>
        [target, ...(aliases[target] ?? [])].some(
          (candidate) => normalizeGuessName(candidate) === normalizeGuessName(name)
        )
      await game.start()
      for (let step = 0; step < MAX_ROUNDS && game.result === null; step++) {
        expect(game.phase, `${target} 第 ${game.round} 轮：${game.failureText}`).not.toBe('error')
        const candidate = game.candidateAnswer
        if (candidate) {
          const exact = isCorrect(candidate)
          console.log(`${target} 第 ${game.round} 轮猜测：${candidate}，${exact ? '确认' : '否定'}`)
          await game.confirmCandidate(exact)
          if (exact || game.phase !== 'waiting') continue
        }
        if (game.result !== null) break
        const direct = extractGuessCandidate(game.question)
        let answer: 'yes' | 'no' | 'unsure'
        if (direct && game.currentTurn?.action !== 'ask') answer = isCorrect(direct) ? 'yes' : 'no'
        else {
          const text = await streamChat(
            settings.api.chat,
            [
              {
                role: 'system',
                content: `你是猜心测试中的玩家，始终判断秘密目标「${target}」本身的属性。${description}按常识回答，不知道就不确定。不要迎合问句预设，不得把目标偷偷换成问题暗示的另一个对象。严格区分现实与虚构，若问现实可触摸实体，虚构角色回答否。用途问句（用于、用来、主要、通常）按典型主要用途回答，不因偶尔能做到就肯定它专门用于此事；明确问「能不能」时才按能力回答。含义有歧义、依赖特定型号或不明前提时回答不确定。只返回 JSON：{"target":"${target}","basis":"关于该目标的一句简短事实依据","answer":"yes或no或unsure"}。依据仅用于测试审查，猜测模型只会收到 answer，不会收到 target 或 basis。`
              },
              { role: 'user', content: `判断目标「${target}」是否符合这个问题：${game.question}` }
            ],
            { thinking: { type: 'disabled' }, temperature: 0, retries: 0, timeoutMs: 25_000 }
          )
          const player = parseJsonLoose(text)
          expect(player?.target, '模拟玩家必须保持本局秘密目标').toBe(target)
          expect(['yes', 'no', 'unsure'], '模拟玩家必须返回有效回答').toContain(player?.answer)
          expect(typeof player?.basis, '模拟玩家需提供可审查的简短事实依据').toBe('string')
          answer = player!.answer as 'yes' | 'no' | 'unsure'
          playerAnswers.push({round: game.round, question: game.question, answer, basis: player!.basis as string})
        }
        console.log(`${target} 第 ${game.round} 轮：${game.question} → ${answer}`)
        console.log(
          `提问计划：${JSON.stringify({ key: game.currentTurn?.questionKey, candidates: game.currentTurn?.candidates })}`
        )
        await game.submitAnswer(answer)
      }
      console.log(`${target} 结果：${game.result ?? `${MAX_ROUNDS} 轮测试预算内未猜中`}，已出题 ${game.round} 轮`)
      mkdirSync('output/guess', { recursive: true })
      expect(game.result, `${target} 未在测试预算内猜中`).toBe('guessed')
      expect(isCorrect(game.guess)).toBe(true)
    } finally {
      streamSpy.mockRestore()
      mkdirSync('output/guess', { recursive: true })
      writeFileSync(
        `output/guess/${target}.json`,
        JSON.stringify(
          {
            target,
            model: 'deepseek-flash',
            testedAt: new Date(started).toISOString(),
            durationMs: Date.now() - started,
            maxRounds: MAX_ROUNDS,
            referenceDocuments: useRagStore().documents.map((doc) => ({ id: doc.id, title: doc.title })),
            result: game?.result,
            rounds: game?.round,
            failure: game?.failureText,
            turns: game?.turns,
            playerAnswers,
            requests
          },
          null,
          2
        ),
        'utf8'
      )
      vi.unstubAllGlobals()
    }
  },
  600_000
)
