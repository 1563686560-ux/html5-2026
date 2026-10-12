<script setup lang="ts">
/**
 * 问理 · 多智能体辩论（P5）
 * ------------------------------------------------------------------
 * 选两位先贤、一个辩题，双方轮流流式发言、逐轮回应。你当裁判。
 */
import { ref } from 'vue'
import AppIcon from '@/components/AppIcon.vue'
import MarkdownView from '@/components/MarkdownView.vue'
import EmptyState from '@/components/EmptyState.vue'
import { SAGES } from '@/data/personas'
import { useDebateStore } from '@/stores/debate'

const debate = useDebateStore()
const draftTopic = ref('')

const sampleTopics = ['成大事者是否应当不拘小节', '人工智能能否真正理解人类情感', '读书贵精还是贵博']

function start(): void {
  debate.topic = draftTopic.value.trim()
  void debate.run()
}

function useSample(topic: string): void {
  draftTopic.value = topic
}
</script>

<template>
  <div class="page scroll-y">
    <header class="head safe-x">
      <RouterLink to="/" class="back" aria-label="返回广场"><AppIcon name="close" /></RouterLink>
      <div>
        <h1 class="title">问理</h1>
        <p class="subtitle">两位思想家同屏对辩，你来裁判</p>
      </div>
    </header>

    <section class="section safe-x">
      <h2 class="section-title">辩手</h2>
      <div class="speakers">
        <div class="speaker">
          <span class="side">正方</span>
          <select
            v-model="debate.aId"
            class="select"
            aria-label="正方辩手"
            :disabled="debate.running || debate.canResume"
          >
            <option v-for="sage in SAGES" :key="sage.id" :value="sage.id" :disabled="sage.id === debate.bId">
              {{ sage.avatar }} {{ sage.name }}
            </option>
          </select>
        </div>
        <span class="vs">VS</span>
        <div class="speaker">
          <span class="side">反方</span>
          <select
            v-model="debate.bId"
            class="select"
            aria-label="反方辩手"
            :disabled="debate.running || debate.canResume"
          >
            <option v-for="sage in SAGES" :key="sage.id" :value="sage.id" :disabled="sage.id === debate.aId">
              {{ sage.avatar }} {{ sage.name }}
            </option>
          </select>
        </div>
      </div>
    </section>

    <section class="section safe-x">
      <h2 class="section-title">辩题</h2>
      <textarea
        v-model="draftTopic"
        class="topic-input"
        rows="2"
        :disabled="debate.running || debate.canResume"
        maxlength="300"
        placeholder="输入一个辩题，例如：人工智能能否真正理解人类情感？"
      />
      <div class="samples">
        <button
          v-for="topic in sampleTopics"
          :key="topic"
          class="sample"
          :disabled="debate.running || debate.canResume"
          @click="useSample(topic)"
        >
          {{ topic }}
        </button>
      </div>
      <div class="rounds">
        <span>轮数</span>
        <div class="round-pills" role="group" aria-label="辩论轮数">
          <button
            v-for="n in [1, 2, 3]"
            :key="n"
            class="round"
            :class="{ on: debate.rounds === n }"
            :disabled="debate.running || debate.canResume"
            :aria-label="`${n} 轮`"
            :aria-pressed="debate.rounds === n"
            @click="debate.rounds = n"
          >
            {{ n }}
          </button>
        </div>
      </div>
    </section>

    <section class="section safe-x">
      <button
        v-if="!debate.running && !debate.canResume"
        class="start-btn"
        :disabled="!draftTopic.trim() || debate.aId === debate.bId"
        @click="start"
      >
        <AppIcon name="send" /> 开始辩论
      </button>
      <button v-if="debate.canResume" class="start-btn" @click="debate.run(true)">
        <AppIcon name="send" />继续当前轮
      </button>
      <button v-if="debate.canResume" class="restart-btn" @click="debate.reset()">重新设置辩论</button>
      <button v-if="debate.running" class="stop-btn" @click="debate.stop"><AppIcon name="stop" /> 停止</button>
      <p v-if="debate.errorText" class="error">{{ debate.errorText }}</p>
    </section>

    <section class="section safe-x">
      <h2 class="section-title">
        辩论现场 <small v-if="debate.turns.length">{{ debate.completedCount }} / {{ debate.rounds * 2 }} 次发言</small>
      </h2>
      <EmptyState
        v-if="!debate.turns.length && !debate.running"
        icon="chat"
        title="还没开始"
        description="选定辩手与辩题，点击「开始辩论」。"
      />
      <div v-else class="turns">
        <article
          v-for="turn in debate.turns"
          :key="turn.id"
          class="turn"
          :class="[turn.side, { speaking: debate.currentSpeakerId === turn.personaId && !turn.content.trim() }]"
        >
          <div class="turn-head">
            <span class="avatar">{{ turn.avatar }}</span>
            <div class="turn-meta">
              <strong>{{ turn.side === 'positive' ? '正方' : '反方' }} · {{ turn.personaName }}</strong>
              <small>第 {{ turn.round + 1 }} 轮 · {{ turn.role === 'opening' ? '开场' : '反驳' }}</small>
            </div>
            <span v-if="debate.currentSpeakerId === turn.personaId && debate.running" class="live">正在发言…</span>
          </div>
          <MarkdownView
            :content="turn.content || '…'"
            :streaming="debate.currentSpeakerId === turn.personaId && debate.running"
          />
        </article>
      </div>

      <div v-if="debate.finished" class="viewpoint-summary">
        <h3>双方观点回看</h3>
        <div v-for="side in ['positive', 'negative']" :key="side" :class="side">
          <strong>{{ side === 'positive' ? '正方 · 支持' : '反方 · 反对' }}</strong>
          <p>
            {{
              debate.turns
                .filter((turn) => turn.side === side)
                .at(-1)
                ?.content.slice(0, 180)
            }}{{ (debate.turns.filter((turn) => turn.side === side).at(-1)?.content.length ?? 0) > 180 ? '…' : '' }}
          </p>
        </div>
        <p class="verdict">以上摘自末轮发言，你觉得谁更有道理？</p>
      </div>
    </section>

    <div class="tail" />
  </div>
</template>

<style scoped>
.page {
  height: 100%;
  padding-top: var(--safe-top);
}
.head {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: var(--sp-5) var(--sp-5) var(--sp-4);
}
.back {
  flex: none;
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border-radius: var(--r-full);
  color: var(--text-2);
  background: var(--surface-1);
  border: 1px solid var(--border);
  font-size: 1.125rem;
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
.section {
  margin-bottom: var(--sp-5);
}
.section-title {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-sm);
  color: var(--text-2);
  letter-spacing: 0.06em;
}
.speakers {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.speaker {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.side {
  font-size: 0.625rem;
  color: var(--text-3);
}
.select {
  width: 100%;
  padding: 11px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-1);
  color: var(--text-1);
  font-size: var(--fs-sm);
}
.vs {
  flex: none;
  padding: 0 4px;
  font-size: var(--fs-sm);
  font-weight: 700;
  color: var(--brand);
}
.topic-input {
  width: 100%;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-sm);
  line-height: 1.6;
  resize: vertical;
  outline: none;
}
.topic-input:focus {
  border-color: var(--brand);
}
.samples {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: var(--sp-2);
}
.sample {
  padding: 6px 10px;
  border-radius: var(--r-full);
  font-size: 0.625rem;
  color: var(--brand);
  background: var(--brand-soft);
}
.rounds {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: var(--sp-3);
  font-size: var(--fs-xs);
  color: var(--text-2);
}
.round-pills {
  display: flex;
  gap: 6px;
}
.round {
  width: 34px;
  height: 34px;
  border-radius: var(--r-full);
  border: 1px solid var(--border);
  color: var(--text-2);
}
.round.on {
  color: var(--brand-on);
  background: var(--brand-action);
  border-color: var(--brand);
}
.round:disabled {
  opacity: 0.5;
}
.start-btn,
.stop-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: 13px;
  border-radius: var(--r-md);
  font-size: var(--fs-sm);
  font-weight: 600;
  color: #fff;
}
.start-btn {
  color: var(--brand-on);
  background: var(--brand-action);
}
.start-btn:disabled {
  opacity: 0.45;
}
.stop-btn {
  color: var(--bg);
  background: var(--danger);
}
.error {
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-xs);
  color: var(--danger);
}
.turns {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.turn {
  padding: var(--sp-3);
  border-radius: var(--r-lg);
  background: var(--surface-1);
  border: 1px solid var(--border);
}
.turn.speaking {
  border-color: var(--brand);
  box-shadow: 0 0 0 3px var(--brand-soft);
}
.turn-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
}
.avatar {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: var(--r-full);
  background: var(--brand-soft);
  font-size: 1.125rem;
}
.turn-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.turn-meta strong {
  font-size: var(--fs-sm);
}
.turn-meta small {
  font-size: 0.625rem;
  color: var(--text-3);
}
.live {
  padding: 3px 8px;
  border-radius: var(--r-full);
  font-size: 0.625rem;
  color: var(--brand);
  background: var(--brand-soft);
  animation: pulse 1.2s ease-in-out infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.4;
  }
}
.verdict {
  padding: var(--sp-3);
  border-radius: var(--r-md);
  background: var(--brand-soft);
  border: 1px solid var(--border);
  color: var(--brand);
  font-size: var(--fs-sm);
  text-align: center;
}
.tail {
  height: var(--sp-6);
}

.turn.positive {
  border-left: 3px solid var(--brand);
}
.turn.negative {
  border-left: 3px solid var(--warning);
}
.section-title small {
  margin-left: 8px;
  color: var(--text-3);
  font-size: var(--fs-xs);
  font-weight: 400;
}
.restart-btn {
  display: block;
  margin: 12px auto 0;
  min-height: 44px;
  color: var(--text-2);
  font-size: var(--fs-sm);
}
.viewpoint-summary {
  margin-top: 20px;
  padding: 18px;
  border-radius: var(--r-lg);
  background: var(--surface-1);
  border: 1px solid var(--border);
}
.viewpoint-summary h3 {
  margin: 0 0 16px;
  font-size: var(--fs-md);
}
.viewpoint-summary > div {
  padding: 12px;
  margin: 10px 0;
  border-radius: var(--r-sm);
  background: var(--surface-2);
}
.viewpoint-summary strong {
  color: var(--brand);
  font-size: var(--fs-sm);
}
.viewpoint-summary .negative strong {
  color: var(--warning);
}
.viewpoint-summary p {
  font-size: var(--fs-xs);
  line-height: 1.7;
  color: var(--text-2);
  overflow-wrap: anywhere;
}
</style>
