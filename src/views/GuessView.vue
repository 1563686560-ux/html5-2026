<script setup lang="ts">
/**
 * 猜心 · 选做玩法（§2.2-D）
 * ------------------------------------------------------------------
 * 心里想好一个东西不说，App 每轮只问一个「是 / 否 / 不确定」的问题，
 * 直到猜出来。这一页只做展示与交互，规则与状态机分别在
 * prompt/guess.ts 与 stores/guess.ts 里，方便单独测试。
 *
 * 四个界面共用一套状态机：开局 → 对局 → 结算 → 历史回看。
 */
import { computed, onMounted, ref } from 'vue'
import AppIcon from '@/components/AppIcon.vue'
import EmptyState from '@/components/EmptyState.vue'
import { answerLabel, MAX_ROUNDS, type GuessAnswer } from '@/prompt/guess'
import { useGuessStore, type GuessRecord, type GuessTurn } from '@/stores/guess'
import { useSettingsStore } from '@/stores/settings'

const guess = useGuessStore()
const settings = useSettingsStore()

/** 展开的历史对局 id */
const expandedId = ref<string | null>(null)
/** 已问过的问题折叠列表 */
const showAsked = ref(false)

onMounted(() => {
  void guess.loadHistory().then(() => guess.restoreGame())
})

/** 只展示校验通过的问题，避免闪出 JSON 和随后被判重复的题。 */
const asking = computed(() => guess.phase === 'asking')
const waitingText = computed(() => {
  if (guess.requestStage === 'checking') return '正在核对候选与已有线索…'
  if (guess.requestStage === 'replanning') return '正在重新整理线索…'
  return '正在分析你的回答…'
})

/** 每轮都显示轮数与模型自报的把握 */
const confidencePercent = computed(() => Math.round(guess.confidence * 100))
const confidenceHint = computed(() => {
  if (!guess.guess) return ''
  return `模型当前猜的是「${guess.guess}」，把握约 ${confidencePercent.value}%`
})

/**
 * 候选答案的文案。
 * 两种来路语气不同：用户刚答了「是」，就说「那我猜是……」；
 * 模型自己报出高置信度，就说「我觉得答案就是……」。
 */
const candidateTitle = computed(() => {
  if (!guess.candidateAnswer) return ''
  return guess.phase === 'confirming'
    ? `那我猜是「${guess.candidateAnswer}」——对吗？`
    : `我觉得答案就是「${guess.candidateAnswer}」`
})

const candidateHint = computed(() =>
  guess.phase === 'confirming' ? '点「猜对了」结束这一局，点「不是」我接着问。' : '也可以先回答下面的问题。'
)

const resultTitle = computed(() => {
  if (guess.result === 'guessed') return '猜中了！'
  if (guess.result === 'gaveup') return '这局先到这里'
  return '这局还没有猜出来'
})

const resultDesc = computed(() => {
  if (guess.result === 'guessed') return `第 ${guess.turns.length} 轮猜中，用时 ${guess.elapsedSeconds} 秒。`
  if (guess.result === 'gaveup')
    return `你主动结束了这一局，共用 ${guess.turns.length} 轮、${guess.elapsedSeconds} 秒。`
  return `用时 ${guess.elapsedSeconds} 秒。可以再来一局。`
})

async function start(): Promise<void> {
  expandedId.value = null
  showAsked.value = false
  await guess.start()
}

function answer(value: GuessAnswer): void {
  // 请求进行中会忽略点击；这里守卫是为了防止连点产生第二轮提交
  if (guess.busy || guess.phase !== 'waiting') return
  void guess.submitAnswer(value)
}

function toggleAsked(): void {
  showAsked.value = !showAsked.value
}

function toggleRecord(record: GuessRecord): void {
  expandedId.value = expandedId.value === record.id ? null : record.id
}

/**
 * 历史记录里的轮次。
 * 走 store.replay 拿一份克隆，而不是直接渲染 record.turns ——
 * IndexedDB 读出来的对象虽然今天是普通对象，但一旦有人把历史改成响应式数组，
 * 回看时就会直接改到存档本身。
 */
function recordTurns(record: GuessRecord): GuessTurn[] {
  return guess.replay(record)
}

function formatDate(at: number): string {
  return new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

function resultLabel(value: GuessRecord['result']): string {
  if (value === 'guessed') return '猜中'
  if (value === 'gaveup') return '放弃'
  return '未猜中'
}
</script>

<template>
  <div class="page scroll-y guess-page">
    <header class="head safe-x">
      <RouterLink to="/" class="back" aria-label="返回广场"><AppIcon name="close" /></RouterLink>
      <div>
        <h1 class="title">猜心空间</h1>
        <p class="subtitle">心中藏一个答案，让 AI 循着线索来猜</p>
      </div>
    </header>

    <!-- 未配置接口：没有 Key 一局都跑不起来 -->
    <section v-if="settings.ready && !settings.chatConfigured" class="section safe-x">
      <RouterLink to="/me" class="warn">尚未配置 API Key，点此前往设置</RouterLink>
    </section>

    <!-- 开局屏（FR-G1） -->
    <section v-if="guess.restoring" class="section safe-x">正在恢复对局…</section>
    <template v-else-if="guess.phase === 'idle'">
      <section class="section safe-x">
        <div class="rules">
          <div class="mind-emblem" aria-hidden="true"><AppIcon name="sparkle" /></div>
          <p class="mind-label">大模型驱动 · 最多 {{ MAX_ROUNDS }} 轮</p>
          <p class="rules-lead">心里想好一个东西，先别告诉我。</p>
          <ul class="rules-list">
            <li>选一个人物、动物、物品或概念。</li>
            <li>根据心中的答案，回答「是」「否」或「不确定」。</li>
          </ul>
          <details class="game-details">
            <summary>了解猜心原理与进度保存</summary>
            <p class="rules-note">进度自动保存在本机，刷新后可以继续。不会写进长期记忆或对话列表。</p>
            <p class="rules-note">模型根据回答逐步缩小范围，并非读取想法；把握数值是模型自评，最终由你确认是否猜中。</p>
          </details>
        </div>
        <button class="start-btn" :disabled="!settings.chatConfigured" @click="start">
          <AppIcon name="sparkle" /> 开始猜心
        </button>
      </section>
    </template>

    <!-- 对局屏（FR-G2 / FR-G3）：请求中 / 等回答 / 等确认候选 / 请求失败待重试 -->
    <template v-else-if="guess.phase !== 'guessed' && guess.phase !== 'finished'">
      <section class="section safe-x">
        <div class="round-row">
          <span class="round">第 {{ guess.round }} 轮</span>
          <span class="round-max">最多 {{ MAX_ROUNDS }} 轮</span>
        </div>
        <div
          class="round-progress"
          role="progressbar"
          aria-label="已使用轮数"
          :aria-valuenow="guess.round"
          :aria-valuemax="MAX_ROUNDS"
          aria-valuemin="0"
        >
          <span :style="{ width: `${Math.min(100, (guess.round / MAX_ROUNDS) * 100)}%` }" />
        </div>

        <!-- 请求失败：整局进度保留，只把这一轮标成失败 -->
        <div v-if="guess.phase === 'error'" class="failure">
          <p class="failure-title">线索已保留，稍后继续</p>
          <p class="failure-desc">{{ guess.failureText }}</p>
          <p class="failure-note">已经问过的 {{ guess.turns.length }} 轮都还在，点下面的按钮接着玩，不用从头开始。</p>
          <button class="start-btn" :disabled="guess.busy" @click="guess.retryRound()">
            <AppIcon name="sparkle" /> 重试这一轮
          </button>
        </div>

        <template v-else>
          <!-- :key 绑在轮数上：换一轮就重建卡片，入场动画才会重新播一次 -->
          <div :key="guess.round" class="question-card" :class="{ processing: asking }" aria-live="polite">
            <div class="mind-emblem compact" aria-hidden="true"><AppIcon name="sparkle" /></div>
            <p class="mind-label">
              {{ guess.candidateAnswer ? '等待你确认答案' : asking ? '正在整理你的线索' : '根据心中的答案选择' }}
            </p>
            <p v-if="asking" class="question thinking" role="status"><i class="caret" />{{ waitingText }}</p>
            <p v-else class="question">{{ guess.currentTurn?.question ?? '' }}</p>
          </div>

          <!-- 候选答案：只有用户点了「猜对了」才算猜中 -->
          <div v-if="guess.candidateAnswer" class="candidate">
            <p class="reveal-label">我的猜测</p>
            <p class="candidate-name">{{ guess.candidateAnswer }}</p>
            <p class="candidate-text">{{ candidateTitle }}</p>
            <p class="candidate-hint">{{ candidateHint }}</p>
            <div class="candidate-actions">
              <button class="answer yes" @click="guess.confirmCandidate(true)">猜对了</button>
              <button class="answer" @click="guess.confirmCandidate(false)">不是</button>
            </div>
          </div>

          <p v-if="asking" class="status">这一轮最多等待 30 秒，你也可以暂停后重试。</p>
          <p v-else-if="confidenceHint && !guess.candidateAnswer" class="status">{{ confidenceHint }}</p>

          <div v-if="!guess.awaitingConfirm" class="answers">
            <button class="answer yes" :disabled="asking" @click="answer('yes')">是的</button>
            <button class="answer" :disabled="asking" @click="answer('no')">不是</button>
            <button class="answer" :disabled="asking" @click="answer('unsure')">不确定</button>
          </div>
        </template>

        <button v-if="asking" class="giveup" @click="guess.cancelRound()">暂停等待</button>
        <button v-if="guess.canUndo" class="giveup" @click="guess.undoAnswer()">撤回上个回答</button>
        <button class="giveup" @click="guess.abandon()"><AppIcon name="stop" /> 放弃这一局</button>
      </section>

      <!-- 已问过的问题：默认折叠，需要回看时再展开 -->
      <section v-if="guess.turns.length" class="section safe-x">
        <button class="asked-toggle" @click="toggleAsked">
          <span>已问过的问题（{{ guess.turns.length }}）</span>
          <AppIcon name="chevron" :class="['chevron', { open: showAsked }]" />
        </button>
        <ol v-if="showAsked" class="asked-list">
          <li v-for="(turn, index) in guess.turns" :key="index" class="asked-item">
            <span class="asked-q">{{ turn.question }}</span>
            <span class="asked-a" :class="{ pending: !turn.answer }">
              {{ turn.answer ? answerLabel(turn.answer) : '待回答' }}
            </span>
          </li>
        </ol>
      </section>
    </template>

    <!-- 结算屏（FR-G4） -->
    <template v-else>
      <section class="section safe-x">
        <div class="result" :class="guess.result === 'guessed' ? 'win' : 'lose'">
          <span class="result-icon" aria-hidden="true"
            ><AppIcon :name="guess.result === 'guessed' ? 'sparkle' : 'history'"
          /></span>
          <p class="result-title">{{ resultTitle }}</p>
          <p v-if="guess.result === 'guessed'" class="result-answer">{{ guess.guess }}</p>
          <p class="result-desc">{{ resultDesc }}</p>
          <div class="stats">
            <div>
              <strong>{{ guess.turns.length }}</strong
              ><small>轮数</small>
            </div>
            <div>
              <strong>{{ formatDuration(guess.durationMs) }}</strong
              ><small>用时</small>
            </div>
          </div>
        </div>

        <button class="start-btn" :disabled="!settings.chatConfigured" @click="start">
          <AppIcon name="sparkle" /> 再来一局
        </button>

        <button class="asked-toggle" @click="toggleAsked">
          <span>这一局的问答（{{ guess.turns.length }}）</span>
          <AppIcon name="chevron" :class="['chevron', { open: showAsked }]" />
        </button>
        <ol v-if="showAsked" class="asked-list">
          <li v-for="(turn, index) in guess.turns" :key="index" class="asked-item">
            <span class="asked-q">{{ turn.question }}</span>
            <span class="asked-a">{{ turn.answer ? answerLabel(turn.answer) : '未回答' }}</span>
          </li>
        </ol>
      </section>
    </template>

    <!-- 历史对局（FR-G5） -->
    <section class="section safe-x">
      <div class="section-head">
        <h2 class="section-title">历史对局</h2>
        <button v-if="guess.hasHistory" class="clear" @click="guess.clearHistory()">清空</button>
      </div>

      <EmptyState v-if="!guess.hasHistory" icon="history" title="还没有对局记录" description="完成一局后可回看问答。" />

      <div v-else class="records">
        <article v-for="record in guess.history" :key="record.id" class="record">
          <button class="record-main" @click="toggleRecord(record)">
            <span class="record-result" :class="record.result">{{ resultLabel(record.result) }}</span>
            <span class="record-body">
              <span class="record-title">
                {{
                  record.result === 'guessed'
                    ? `猜中：${record.answer}`
                    : `${record.rounds} 轮 · ${formatDuration(record.durationMs)}`
                }}
              </span>
              <span class="record-meta">{{ formatDate(record.startedAt) }} · {{ record.rounds }} 轮</span>
            </span>
            <AppIcon name="chevron" :class="['chevron', { open: expandedId === record.id }]" />
          </button>

          <ol v-if="expandedId === record.id" class="asked-list">
            <li v-for="(turn, index) in recordTurns(record)" :key="index" class="asked-item">
              <span class="asked-q">{{ turn.question }}</span>
              <span class="asked-a">{{ turn.answer ? answerLabel(turn.answer) : '未回答' }}</span>
            </li>
          </ol>
        </article>
      </div>
    </section>

    <p v-if="guess.storageWarning" class="warning safe-x">{{ guess.storageWarning }}</p>
    <p v-if="guess.errorText" class="game-hint safe-x">{{ guess.errorText }}</p>

    <div class="tail" />
  </div>
</template>

<style scoped>
.eyebrow {
  margin: 0 0 4px;
  font-size: 11px;
  letter-spacing: 0.14em;
  color: var(--brand);
}
.mind-emblem {
  display: grid;
  place-items: center;
  width: 86px;
  height: 86px;
  margin: 0 auto 18px;
  font-size: 36px;
  color: var(--brand);
  border: 1px solid var(--border);
  border-radius: 28px;
  background: radial-gradient(circle, var(--bg-glow), var(--surface-1));
  box-shadow: 0 0 30px color-mix(in srgb, var(--brand) 9%, transparent);
}
.mind-emblem.compact {
  width: 64px;
  height: 64px;
  font-size: 28px;
  border-radius: 22px;
}
.mind-label {
  margin: 0 0 14px;
  color: var(--brand);
  font-size: var(--fs-xs);
  text-align: center;
}
.game-details {
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
  color: var(--text-3);
  font-size: var(--fs-xs);
}
.game-details summary {
  padding: 8px 0;
  cursor: pointer;
}
.round-progress {
  height: 4px;
  background: var(--surface-2);
  border-radius: 4px;
  margin: 12px 0 22px;
  overflow: hidden;
}
.round-progress span {
  display: block;
  height: 100%;
  background: var(--brand);
  transition: width var(--dur) var(--ease);
}
:global(html[data-theme='light'] .guess-page .rules) {
  background: var(--surface-1);
  border-top: 3px solid var(--brand);
}
.page {
  height: 100%;
  padding-top: var(--safe-top);
}

/* ---- 顶栏 ---- */
.head {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-5) var(--sp-5) var(--sp-3);
}

.back {
  flex: none;
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: var(--r-full);
  font-size: 1.0625rem;
  color: var(--text-2);
  background: var(--surface-1);
  border: 1px solid var(--border);
}

.title {
  margin: 0;
  font-size: var(--fs-xl);
  font-weight: 700;
}

.subtitle {
  margin: 6px 0 0;
  font-size: var(--fs-sm);
  color: var(--text-2);
}

.tag {
  margin-left: auto;
  flex: none;
  padding: 3px 8px;
  border-radius: var(--r-full);
  font-size: 0.625rem;
  letter-spacing: 0.04em;
  color: var(--text-3);
  background: var(--surface-2);
}

.section {
  padding: 0 var(--sp-5);
  margin-bottom: var(--sp-5);
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.section-title {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-2);
  letter-spacing: 0.06em;
}

.clear {
  margin-bottom: var(--sp-3);
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.warn {
  display: block;
  text-align: center;
  padding: 11px;
  border-radius: var(--r-md);
  font-size: var(--fs-sm);
  color: var(--warning);
  background: rgba(255, 196, 107, 0.1);
  border: 1px solid rgba(255, 196, 107, 0.26);
}

/* ---- 开局屏 ---- */
.rules {
  padding: 24px 20px;
  border-radius: var(--r-lg);
  background: linear-gradient(145deg, var(--bg-glow), var(--surface-1) 65%);
  border: 1px solid var(--border);
}

.rules-lead {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: 680;
}

.rules-list {
  margin: var(--sp-3) 0 0;
  padding-left: 1.125rem;
  font-size: var(--fs-sm);
  line-height: 1.9;
  color: var(--text-2);
}

.rules-note {
  margin: var(--sp-3) 0 0;
  font-size: var(--fs-xs);
  line-height: 1.7;
  color: var(--text-3);
}

/* ---- 对局屏 ---- */
.round-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--sp-2);
}

.round {
  font-size: var(--fs-md);
  font-weight: 680;
}

.round-max {
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.question-card {
  position: relative;
  padding: var(--sp-5) var(--sp-4) 30px;
  text-align: center;
  box-shadow: var(--tech-shadow);
  border-radius: var(--r-lg);
  background: var(--surface-1);
  border: 1px solid var(--border);
  overflow: hidden;
  animation: card-in var(--dur) var(--ease);
}

@keyframes card-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.question-card::before {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 2px;
  background: linear-gradient(90deg, var(--brand), var(--brand-2));
}

.question {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: 600;
  line-height: 1.6;
  min-height: 1.6em;
}

.question.thinking {
  font-size: var(--fs-md);
  font-weight: 500;
  color: var(--text-2);
}

.caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 3px;
  vertical-align: -0.12em;
  background: var(--brand-action);
  animation: blink 1s steps(2, start) infinite;
}

@keyframes blink {
  to {
    opacity: 0;
  }
}

.status {
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-xs);
  color: var(--text-3);
}

/* ---- 候选答案确认 ---- */
.candidate {
  margin-top: var(--sp-3);
  padding: var(--sp-4);
  border-radius: var(--r-lg);
  background: var(--brand-soft);
  border: 1px solid var(--border);
}

.candidate-text {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: 660;
  line-height: 1.6;
}

.candidate-hint {
  margin: 6px 0 0;
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-3);
}

.candidate-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--sp-2);
  margin-top: var(--sp-3);
}

.answer.yes {
  color: var(--brand-on);
  background: var(--brand-action);
  border-color: transparent;
}

/* ---- 请求失败：进度保留，等用户重试 ---- */
.failure {
  padding: var(--sp-5) var(--sp-4);
  border-radius: var(--r-lg);
  background: var(--surface-1);
  border: 1px solid var(--border);
}

.failure-title {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: 660;
}

.failure-desc {
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-sm);
  line-height: 1.7;
  color: var(--text-2);
  word-break: break-word;
}

.failure-note {
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-xs);
  line-height: 1.7;
  color: var(--text-3);
}

.answers {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--sp-2);
  margin-top: var(--sp-4);
}

.answer {
  padding: 15px 0;
  border-radius: var(--r-md);
  font-size: var(--fs-md);
  font-weight: 620;
  color: var(--text-1);
  background: var(--surface-1);
  border: 1px solid var(--border);
  transition:
    transform var(--dur-fast) var(--ease),
    background var(--dur) var(--ease);
}

.answer:active {
  transform: scale(0.96);
  background: var(--surface-3);
}
.answer.yes:active {
  background: var(--brand-action);
  filter: brightness(0.94);
}

.answer:disabled {
  opacity: 0.4;
}

.giveup {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  margin-top: var(--sp-3);
  padding: 11px;
  border-radius: var(--r-md);
  font-size: var(--fs-xs);
  color: var(--text-3);
  background: var(--surface-1);
  border: 1px solid var(--border);
}

.giveup:active {
  color: var(--danger);
  background: rgba(255, 107, 129, 0.1);
}

/* ---- 已问过的问题 ---- */
.asked-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 11px var(--sp-4);
  border-radius: var(--r-md);
  font-size: var(--fs-sm);
  color: var(--text-2);
  background: var(--surface-1);
  border: 1px solid var(--border);
}

.asked-toggle + .asked-list {
  margin-top: var(--sp-2);
}

.chevron {
  font-size: 1rem;
  transition: transform var(--dur) var(--ease);
}

.chevron.open {
  transform: rotate(180deg);
}

.asked-list {
  margin: var(--sp-2) 0 0;
  padding: var(--sp-2) var(--sp-3);
  list-style: none;
  border-radius: var(--r-md);
  background: var(--surface-1);
  border: 1px solid var(--border);
}

.asked-item {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-xs);
  line-height: 1.6;
}

.asked-item:last-child {
  border-bottom: none;
}

.asked-q {
  flex: 1;
  min-width: 0;
  color: var(--text-2);
}

.asked-a {
  flex: none;
  padding: 2px 8px;
  border-radius: var(--r-full);
  color: var(--brand);
  background: var(--brand-soft);
}

.asked-a.pending {
  color: var(--text-3);
  background: var(--surface-2);
}

/* ---- 结算屏 ---- */
.result {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: var(--sp-6) var(--sp-4);
  border-radius: var(--r-lg);
  background: var(--surface-1);
  border: 1px solid var(--border);
}

.result.win {
  border-color: rgba(79, 209, 165, 0.36);
}

.result-icon {
  font-size: 2rem;
  line-height: 1;
}

.result-title {
  margin: var(--sp-3) 0 0;
  font-size: var(--fs-lg);
  font-weight: 680;
}

.result-answer {
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-xl);
  font-weight: 700;
  color: var(--success);
  animation: answer-in var(--dur-slow) var(--ease);
}

@keyframes answer-in {
  from {
    opacity: 0;
    transform: scale(0.88);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.result-desc {
  margin: var(--sp-2) 0 0;
  max-width: 30ch;
  font-size: var(--fs-sm);
  line-height: 1.7;
  color: var(--text-2);
}

.stats {
  display: flex;
  gap: var(--sp-6);
  margin-top: var(--sp-4);
}

.stats div {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.stats strong {
  font-size: var(--fs-lg);
  font-weight: 680;
}

.stats small {
  font-size: 0.625rem;
  color: var(--text-3);
  letter-spacing: 0.06em;
}

.start-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  width: 100%;
  margin-top: var(--sp-4);
  padding: 14px;
  border-radius: var(--r-md);
  font-size: var(--fs-md);
  font-weight: 620;
  color: var(--brand-on);
  background: var(--brand-action);
  transition:
    transform var(--dur-fast) var(--ease),
    opacity var(--dur) var(--ease);
}

.start-btn:active {
  transform: scale(0.98);
}

.start-btn:disabled {
  opacity: 0.4;
}

/* ---- 历史记录 ---- */
.records {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.record {
  border-radius: var(--r-md);
  background: var(--surface-1);
  border: 1px solid var(--border);
  overflow: hidden;
}

.record-main {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  padding: var(--sp-3) var(--sp-4);
  text-align: left;
}

.record-result {
  flex: none;
  padding: 3px 8px;
  border-radius: var(--r-full);
  font-size: 0.625rem;
  letter-spacing: 0.04em;
  color: var(--text-3);
  background: var(--surface-2);
}

.record-result.guessed {
  color: var(--success);
  background: rgba(79, 209, 165, 0.14);
}

.record-result.gaveup {
  color: var(--warning);
  background: rgba(255, 196, 107, 0.14);
}

.record-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.record-title {
  font-size: var(--fs-sm);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.record-meta {
  font-size: 0.625rem;
  color: var(--text-3);
}

.record .asked-list {
  margin: 0 var(--sp-3) var(--sp-3);
}

/* ---- 提示 ---- */
.warning {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--warning);
}

.game-hint {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-3);
}

.tail {
  height: var(--sp-6);
}

/* Focus the question and give confirmed answers a distinct reveal. */
.question-card {
  padding: 24px 20px 28px;
  min-height: 210px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.question {
  font-size: clamp(21px, 5.6vw, 25px);
  overflow-wrap: anywhere;
}
.question-card .mind-emblem.compact {
  width: 46px;
  height: 46px;
  font-size: 22px;
  margin-bottom: 12px;
  border-radius: 16px;
}
.processing .mind-emblem {
  animation: thinking-glow 1.8s ease-in-out infinite alternate;
}
@keyframes thinking-glow {
  to {
    box-shadow: 0 0 28px var(--brand-soft);
    border-color: var(--brand);
  }
}
.candidate {
  text-align: center;
  padding: 22px 16px;
  background: linear-gradient(145deg, var(--brand-soft), var(--surface-1));
}
.reveal-label {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--brand);
}
.candidate-name {
  margin: 10px 0;
  font-size: 28px;
  font-weight: 750;
  color: var(--text-1);
  overflow-wrap: anywhere;
}
.candidate-text {
  font-size: var(--fs-xs);
  font-weight: 400;
  color: var(--text-2);
}
.result {
  position: relative;
  overflow: hidden;
  animation: card-in 300ms var(--ease);
}
.result.win {
  background: radial-gradient(ellipse at top, var(--brand-soft), var(--surface-1) 75%);
  border-color: var(--brand);
  box-shadow: var(--tech-shadow);
}
.result-icon {
  display: grid;
  place-items: center;
  width: 70px;
  height: 70px;
  border-radius: 24px;
  background: var(--brand-soft);
  color: var(--brand);
}
.result-answer {
  font-size: clamp(28px, 8vw, 36px);
  overflow-wrap: anywhere;
  max-width: 100%;
}
@media (prefers-reduced-motion: reduce) {
  .processing .mind-emblem,
  .result,
  .question-card {
    animation: none;
  }
}
</style>
