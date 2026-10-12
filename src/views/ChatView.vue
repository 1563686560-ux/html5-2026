<script setup lang="ts">
/**
 * 对话页
 * ------------------------------------------------------------------
 * 移动端交互上的几个关键细节都集中在这一页：
 *   - 输入框自适应高度
 *   - 上滑到顶自动加载更早的消息，并且**保持视觉位置不跳动**
 *   - 流式输出时跟随到底，但用户上翻回看时绝不强行拽回
 *   - 长按复制、会话下拉刷新、导出成长图分享
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from '@/components/AppIcon.vue'
import EmptyState from '@/components/EmptyState.vue'
import MessageBubble from '@/components/MessageBubble.vue'
import SkeletonBlock from '@/components/SkeletonBlock.vue'
import { useAutoScroll } from '@/composables/useAutoScroll'
import { usePullToRefresh } from '@/composables/usePullToRefresh'
import { useSwipeNav } from '@/composables/useSwipeNav'
import { useToast } from '@/composables/useToast'
import { useViewport } from '@/composables/useViewport'
import { useVirtualList } from '@/composables/useVirtualList'
import { useChatStore } from '@/stores/chat'
import { useSettingsStore } from '@/stores/settings'
import { useRagStore } from '@/stores/rag'
import { shareConversationImage } from '@/utils/exportImage'
import { normalizeKeyword } from '@/utils/search'
import type { SearchHit } from '@/utils/search'

const chat = useChatStore()
const settings = useSettingsStore()
const rag = useRagStore()
const router = useRouter()
const { show: toast } = useToast()

const scroller = ref<HTMLElement | null>(null)
const sheetBody = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLTextAreaElement | null>(null)
const draft = ref('')
const showSessions = ref(false)
const showDocumentScope = ref(false)
const exporting = ref(false)
const renamingId = ref<string | null>(null)
const renameDraft = ref('')
const retrying = ref(false)
const lastMessage = computed(() => chat.messages.at(-1))
const canRetry = computed(() => !chat.loadingSession && !chat.streaming && !retrying.value &&
  (lastMessage.value?.role === 'user' || lastMessage.value?.status === 'incomplete'))
const generationLabel = computed(() =>
  lastMessage.value?.role === 'assistant' && lastMessage.value.content ? '正在回复' : '正在思考'
)
async function handleRetry(): Promise<void> {
  if (!canRetry.value) return
  retrying.value = true
  try { await chat.retryLastMessage() } finally { retrying.value = false }
}

/** 内容签名：长度 + 末条消息长度，任一变化都代表需要跟随滚动 */
const signature = computed(
  () => `${chat.messages.length}:${chat.messages[chat.messages.length - 1]?.content.length ?? 0}`
)
const { pinned, updatePinned, scrollToBottom } = useAutoScroll(scroller, () => signature.value)

/**
 * 旋转屏幕后可视高度变了。
 * 分量一次「是否贴底」再决定要不要滚：原本在回看历史的人不该被硬拽到底，
 * 而原本贴底的人如果不重新滚，会停在半空中看着错位的内容。
 */
const { isLandscape } = useViewport()
watch(isLandscape, () => {
  void nextTick(() => {
    updatePinned()
    if (pinned.value) scrollToBottom()
  })
})

const canSend = computed(() => draft.value.trim().length > 0 && !chat.streaming && !chat.loadingSession && !retrying.value)
const headerTitle = computed(() => chat.currentSession?.title ?? '新对话')
/** 选中资料时优先展示适合答辩的知识库问题，否则跟随角色展示推荐提问。 */
const suggestions = computed(() =>
  chat.selectedDocumentId
    ? ['请概括这份资料的核心内容，并标注出处', '验收要求有哪些？请逐条引用原文', '资料不足以回答哪些问题？']
    : chat.currentPersona.suggestions
)

/** 触摸设备上回车用于换行，桌面端回车直接发送 */
const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false

/* ---- 会话列表下拉刷新 ---- */
const pull = usePullToRefresh(sheetBody, {
  onRefresh: async () => {
    await chat.reloadSessions()
    toast('会话列表已刷新', 'success')
  }
})

/* ---- 跨会话搜索（标题 + 历史消息正文） ---- */
const searchKeyword = ref('')
const searchResults = ref<SearchHit[]>([])
/** 本次搜索实际扫描过的消息条数，用于如实说明搜索范围 */
const searchScanned = ref(0)
/** 结果是否被上限截断：为 true 时界面必须说明"只显示了前 N 条" */
const searchTruncated = ref(false)
const searching = ref(false)
/** 刚从搜索结果跳过来的那条消息，短暂闪一下做定位提示 */
const flashMessageId = ref<string | null>(null)

/** 归一化后的关键词。空串 = 不处于搜索态，会话列表照常显示 */
const searchTerm = computed(() => normalizeKeyword(searchKeyword.value))
const searchMode = computed(() => searchTerm.value.length > 0)

/** 必须与 CSS 里 .search-row 的高度一致，否则虚拟滚动会错位 */
const SEARCH_ROW_HEIGHT = 76

// 解构出来用：模板里只有顶层的 ref 会自动解包，挂在对象上的 ref 不会
const {
  scroller: searchScroller,
  visible: visibleResults,
  onScroll: onSearchScroll,
  scrollToTop: scrollResultsToTop,
  padTop: searchPadTop,
  padBottom: searchPadBottom
} = useVirtualList<SearchHit>({
  items: () => searchResults.value,
  rowHeight: SEARCH_ROW_HEIGHT,
  // 结果列表上方还有一行状态文字，它会把 scrollTop 整体推高一点。
  // 加大 overscan 让可见区间多渲染几行，这点偏移就落不到画面上（不会出现空行）
  overscan: 6
})

/**
 * 输入即搜，但要防抖。
 * 300ms 是手感与代价的折中：每次搜索都要走一遍 messages 表的游标扫描，
 * 每敲一个字就发一次等于自己给自己制造卡顿；再长又会让人觉得"没反应"。
 */
const SEARCH_DEBOUNCE_MS = 300
let searchTimer: number | undefined
/**
 * 请求序号：搜索是异步的，先发的请求可能后返回。
 * 只有序号最新的那次结果才允许写进界面，否则用户会看到上一个关键词的答案。
 */
let searchSeq = 0

watch(searchTerm, (keyword) => {
  window.clearTimeout(searchTimer)
  if (!keyword) {
    searchSeq += 1
    searchResults.value = []
    searchScanned.value = 0
    searchTruncated.value = false
    searching.value = false
    return
  }

  // 立刻进入「搜索中」而不是等防抖结束再显示：输入框里已经有字了，
  // 界面却毫无反应会让人以为坏掉了
  searching.value = true
  searchTimer = window.setTimeout(() => void runSearch(keyword), SEARCH_DEBOUNCE_MS)
})

async function runSearch(keyword: string): Promise<void> {
  const seq = ++searchSeq
  try {
    const result = await chat.searchHistory(keyword)
    if (seq !== searchSeq) return
    searchResults.value = result.hits
    searchScanned.value = result.scanned
    searchTruncated.value = result.truncated
    // 换关键词就回到顶部，否则会停在上一次结果的位置看着一堆无关的行
    scrollResultsToTop()
  } catch (error) {
    if (seq !== searchSeq) return
    console.warn('[chat] 搜索历史失败', error)
    searchResults.value = []
    searchScanned.value = 0
    searchTruncated.value = false
    toast(`搜索失败：${(error as Error).message}`, 'error')
  } finally {
    if (seq === searchSeq) searching.value = false
  }
}

function closeSessions(): void {
  showSessions.value = false
  // 面板关了就作废在途请求，也别再发起没人看的扫描
  window.clearTimeout(searchTimer)
  searchSeq += 1
  searching.value = false
  searchKeyword.value = ''
}

/** 命中项所属会话的标题。会话可能已经被删掉而消息还在库里，这时明说比留空好 */
function sessionTitleOf(sessionId: string): string {
  return chat.sessions.find((session) => session.id === sessionId)?.title ?? '（会话已删除）'
}

function hitTime(hit: SearchHit): number {
  return hit.kind === 'title' ? hit.updatedAt : hit.createdAt
}

function hitKey(hit: SearchHit): string {
  return hit.kind === 'title' ? `title:${hit.sessionId}` : `message:${hit.messageId}`
}

/** 今天的命中只显示时分，更早的显示日期 —— 搜索结果里"多久以前"比具体时刻更有用 */
function formatHitTime(timestamp: number): string {
  const date = new Date(timestamp)
  const sameDay = date.toDateString() === new Date().toDateString()
  return sameDay
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('zh-CN')
}

async function openSearchResult(hit: SearchHit): Promise<void> {
  closeSessions()
  await chat.selectSession(hit.sessionId)
  if (hit.kind !== 'message') return
  const found = await chat.revealMessage(hit.messageId, hit.createdAt)
  await nextTick()
  if (found) focusMessage(hit.messageId)
  else toast('这条消息已不存在，可能已被删除')
}

/**
 * 尽力把命中的那条消息滚到视野中间并闪一下。
 *
 * openSearchResult 会先按命中时间补载附近一页，因此这里通常能直接定位。
 */
function focusMessage(messageId: string): void {
  const container = scroller.value
  const target = container?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)
  if (!container || !target) {
    toast('已跳到该会话，这条消息在更早的历史里')
    return
  }

  // 先解除贴底，否则自动滚动会在下一帧把我们拉回底部
  pinned.value = false
  const box = container.getBoundingClientRect()
  const rect = target.getBoundingClientRect()
  container.scrollTop += rect.top - box.top - (box.height - rect.height) / 2

  flashMessageId.value = messageId
  window.setTimeout(() => {
    // 期间又点了别的结果就别把闪光状态清掉
    if (flashMessageId.value === messageId) flashMessageId.value = null
  }, 1400)
}

/* ---- 左右滑动切换会话 ---- */
/**
 * 会话顺序与会话列表一致：最近更新的在前。
 * 滑到头不做循环 —— 循环切换会让用户分不清自己到底在哪一条，
 * 明确提示「已经是最新/最后一条」更清楚。
 */
function switchSession(step: -1 | 1): void {
  const list = chat.sessions
  if (list.length < 2) return
  const current = list.findIndex((item) => item.id === chat.currentSessionId)
  if (current < 0) return

  const target = current + step
  if (target < 0 || target >= list.length) {
    toast(step < 0 ? '已经是最新的一条会话' : '已经是最后一条会话')
    return
  }

  const next = list[target]
  void chat.selectSession(next.id).then(() => {
    toast(`已切到「${next.title}」`)
  })
}

const swipe = useSwipeNav({
  onPrev: () => switchSession(-1),
  onNext: () => switchSession(1)
})

function resizeInput(): void {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  // 最多长到 120px，再多就内部滚动
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`
}

function fillSuggestion(text: string): void {
  draft.value = text
  void nextTick(() => {
    resizeInput()
    inputEl.value?.focus()
  })
}

async function handleSend(): Promise<void> {
  if (!canSend.value) return
  const text = draft.value
  draft.value = ''
  void nextTick(resizeInput)
  await chat.sendMessage(text)
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey) return
  if (coarsePointer || event.isComposing) return
  event.preventDefault()
  void handleSend()
}

async function newSession(): Promise<void> {
  closeSessions()
  await chat.createSession()
  draft.value = ''
}

async function pickSession(id: string): Promise<void> {
  closeSessions()
  await chat.selectSession(id)
}

async function removeSession(id: string): Promise<void> {
  await chat.deleteSession(id)
}

/**
 * 消息区滚动。
 * 除了维护"是否贴底"，还要判断是否该加载更早的历史。
 */
async function onMessagesScroll(): Promise<void> {
  updatePinned()
  await maybeLoadOlder()
}

/**
 * 上滑到顶时加载更早的一页。
 *
 * 关键在插入旧消息之后补偿 scrollTop：新内容插在顶部会把已有内容整体
 * 往下推，如果不补偿，用户眼前的段落会突然跳一下。
 * 补偿量正好是内容增加的高度，于是视觉位置纹丝不动。
 */
async function maybeLoadOlder(): Promise<void> {
  const el = scroller.value
  if (!el) return
  if (!chat.hasMoreHistory || chat.loadingOlder || chat.streaming) return
  if (el.scrollTop > 48) return

  // 先解除"贴底"状态，否则新消息到达时自动滚动会跟我们对拉
  pinned.value = false
  const prevHeight = el.scrollHeight

  await chat.loadOlderMessages()
  await nextTick()

  const target = scroller.value
  if (target) target.scrollTop += target.scrollHeight - prevHeight
}

/** 换角色：进入角色广场的「切换」模式，对话记录保留 */
function openPersonaPicker(): void {
  void router.push({ path: '/personas', query: { mode: 'switch' } })
}

/** 导出当前会话为长图，优先走系统分享，不支持则下载 */
async function handleExport(): Promise<void> {
  const usable = chat.messages.filter((m) => m.content.trim().length > 0)
  if (usable.length === 0) {
    toast('这一段还没有内容可以导出', 'error')
    return
  }

  exporting.value = true
  try {
    const outcome = await shareConversationImage({
      title: headerTitle.value,
      personaName: chat.currentPersona.name,
      personaAvatar: chat.currentPersona.avatar,
      // 长图有高度上限，只取最近 60 条，宁可截断也不能生成一张空白图
      messages: usable.slice(-60).map((m) => ({ role: m.role, content: m.content }))
    })
    if (outcome === 'shared') toast('已分享', 'success')
    else if (outcome === 'downloaded') toast('长图已保存', 'success')
  } catch (error) {
    toast(`导出失败：${(error as Error).message}`, 'error')
  } finally {
    exporting.value = false
  }
}

function startRename(id: string, title: string): void {
  renamingId.value = id
  renameDraft.value = title
}

async function commitRename(): Promise<void> {
  const id = renamingId.value
  renamingId.value = null
  if (!id) return
  await chat.renameSession(id, renameDraft.value)
}
</script>

<template>
  <div class="page">
    <!-- 顶栏 -->
    <header class="header safe-x">
      <div class="header-left">
        <!-- 头像本身就是"换一位角色"的入口：点头像换人，比塞一个按钮更直观 -->
        <button class="avatar" aria-label="换一位角色" @click="openPersonaPicker">
          {{ chat.currentPersona.name.slice(0, 1) }}
        </button>
        <div class="header-text">
          <p class="header-title">{{ headerTitle }}</p>
          <p class="header-sub">{{ chat.currentPersona.name }}</p>
        </div>
      </div>

      <div class="header-actions">
        <button
          class="icon-btn"
          aria-label="导出为长图"
          :disabled="exporting || chat.messages.length === 0"
          @click="handleExport"
        >
          <AppIcon name="share" />
        </button>
        <button class="icon-btn" aria-label="历史会话" @click="showSessions = true">
          <AppIcon name="history" />
        </button>
      </div>
    </header>

    <!-- 消息区 -->
    <div
      ref="scroller"
      class="messages scroll-y"
      @scroll.passive="onMessagesScroll"
      @touchstart.passive="swipe.onTouchStart"
      @touchend="swipe.onTouchEnd"
      @touchcancel="swipe.onTouchCancel"
    >
      <SkeletonBlock v-if="!chat.ready || chat.loadingSession" :lines="4" />

      <template v-else>
        <!-- 欢迎屏：跟着角色变，开口有抓手 -->
        <div v-if="chat.messages.length === 0" class="welcome">
          <div class="welcome-avatar" aria-hidden="true">{{ chat.currentPersona.name.slice(0, 1) }}</div>
          <p class="welcome-name">{{ chat.currentPersona.name }}</p>
          <p class="welcome-line">{{ chat.currentPersona.greeting }}</p>

          <div class="chips">
            <button v-for="item in suggestions" :key="item" class="chip" @click="fillSuggestion(item)">
              {{ item }}
            </button>
          </div>

          <button class="welcome-switch" @click="openPersonaPicker">
            <AppIcon name="sparkle" />
            换一位角色
          </button>
        </div>

        <template v-else>
          <!-- 上滑加载更早消息的指示器与占位 -->
          <div v-if="chat.loadingOlder" class="loading-older">
            <SkeletonBlock :lines="2" compact />
          </div>
          <p v-else-if="chat.hasMoreHistory" class="load-hint">上滑查看更早的消息</p>

          <MessageBubble
            v-for="message in chat.messages"
            :key="message.id"
            :data-message-id="message.id"
            :class="{ 'flash-on': flashMessageId === message.id }"
            :message="message"
            :persona="chat.currentPersona"
            :live="chat.streamingMessageId === message.id"
          />
        </template>
      </template>
    </div>

    <!-- 不在底部时提供回到最新位置的入口 -->
    <Transition name="fade">
      <button v-if="!pinned" class="to-bottom" aria-label="回到最新" @click="scrollToBottom('smooth')">
        <AppIcon name="send" />
      </button>
    </Transition>

    <!-- 错误提示 -->
    <div v-if="chat.errorText" class="error safe-x" role="alert">
      <AppIcon name="alert" class="error-icon" />
      <p class="error-text">{{ chat.errorText }}</p>
      <button v-if="canRetry || retrying" class="error-retry" :disabled="!canRetry" @click="handleRetry">{{ retrying ? '重试中' : '重新生成' }}</button>
      <button class="error-close" aria-label="关闭提示" @click="chat.clearError()">
        <AppIcon name="close" />
      </button>
    </div>

    <!-- 输入区 -->
    <footer class="composer safe-x">
      <div v-if="chat.streaming || retrying || (canRetry && !chat.errorText)" class="generation-state" role="status" aria-live="polite">
        <span>{{ chat.streaming ? generationLabel : retrying ? '正在重试' : '回复未完成' }}</span>
        <button v-if="canRetry && !chat.errorText" @click="handleRetry">重新生成</button>
      </div>
      <button
        v-if="rag.documents.length || chat.selectedDocumentId"
        class="scope-toggle"
        :aria-expanded="showDocumentScope"
        @click="showDocumentScope = !showDocumentScope"
      >
        <AppIcon name="library" />
        <span>{{
          chat.selectedDocumentId
            ? rag.documents.find((doc) => doc.id === chat.selectedDocumentId)?.title || '所选资料已删除'
            : '资料范围'
        }}</span>
        <AppIcon name="chevron" :class="{ expanded: showDocumentScope }" />
      </button>
      <label v-if="showDocumentScope" class="document-scope">
        问答资料
        <select v-model="chat.selectedDocumentId" :disabled="chat.streaming || retrying || chat.loadingSession || !rag.ready" aria-label="问答资料范围">
          <option value="">全部资料</option>
          <option v-for="doc in rag.documents" :key="doc.id" :value="doc.id">仅：{{ doc.title }}</option>
          <option
            v-if="chat.selectedDocumentId && !rag.documents.some((doc) => doc.id === chat.selectedDocumentId)"
            :value="chat.selectedDocumentId"
          >
            所选资料已删除，请重新选择
          </option>
        </select>
      </label>
      <RouterLink v-if="!settings.chatConfigured" to="/me" class="composer-warn">
        尚未配置 API Key，点此前往设置
      </RouterLink>

      <div v-else class="composer-row">
        <textarea
          ref="inputEl"
          v-model="draft"
          class="input"
          rows="1"
          placeholder="说点什么…"
          enterkeyhint="send"
          @input="resizeInput"
          @keydown="handleKeydown"
        />
        <button v-if="chat.streaming" class="send-btn stop" aria-label="停止生成" @click="chat.stop()">
          <AppIcon name="stop" />
        </button>
        <button v-else class="send-btn" :disabled="!canSend" aria-label="发送" @click="handleSend">
          <AppIcon name="send" />
        </button>
      </div>
    </footer>

    <!-- 会话列表浮层 -->
    <Transition name="sheet">
      <div v-if="showSessions" class="sheet-mask" @click.self="closeSessions">
        <div class="sheet">
          <div class="sheet-head">
            <h2 class="sheet-title">历史会话</h2>
            <button class="icon-btn" aria-label="关闭" @click="closeSessions">
              <AppIcon name="close" />
            </button>
          </div>

          <!-- 跨会话搜索：标题与历史消息正文都会被搜到 -->
          <div class="search-bar">
            <AppIcon name="search" class="search-bar-icon" />
            <input
              v-model="searchKeyword"
              class="search-input"
              type="search"
              placeholder="搜索历史消息"
              aria-label="搜索历史消息"
            />
            <button v-if="searchKeyword" class="search-bar-clear" aria-label="清空搜索" @click="searchKeyword = ''">
              <AppIcon name="close" />
            </button>
          </div>

          <!-- 搜索态：结果列表自己就是滚动容器，虚拟滚动只渲染可见的几行 -->
          <template v-if="searchMode">
            <!-- 状态行放在滚动容器外面：列表的 scrollTop 才能严格等于"第几行 × 行高" -->
            <p class="search-status">
              <template v-if="searching">搜索中…</template>
              <template v-else-if="searchTruncated">只显示了前 {{ searchResults.length }} 条</template>
              <template v-else>找到 {{ searchResults.length }} 条</template>
              <span v-if="!searching && searchResults.length > 0" class="search-scanned">
                · 已扫描 {{ searchScanned }} 条消息
              </span>
            </p>

            <div ref="searchScroller" class="search-body scroll-y" @scroll.passive="onSearchScroll">
              <div v-if="!searching && searchResults.length === 0" class="search-empty">
                <EmptyState
                  icon="search"
                  title="没有找到相关内容"
                  description="换个关键词试试，会话标题和消息正文都会被搜到"
                />
              </div>

              <div
                v-else
                class="search-list"
                :style="{ paddingTop: `${searchPadTop}px`, paddingBottom: `${searchPadBottom}px` }"
              >
                <button
                  v-for="hit in visibleResults"
                  :key="hitKey(hit)"
                  type="button"
                  class="search-row"
                  @click="openSearchResult(hit)"
                >
                  <span class="search-line">
                    <span v-if="hit.kind === 'title'" class="search-tag">标题</span>
                    <span v-if="hit.snippet.clippedHead">…</span>
                    <span>{{ hit.snippet.before }}</span>
                    <em class="search-hit">{{ hit.snippet.match }}</em>
                    <span>{{ hit.snippet.after }}</span>
                    <span v-if="hit.snippet.clippedTail">…</span>
                  </span>
                  <span class="search-meta">
                    <span class="search-session">{{ sessionTitleOf(hit.sessionId) }}</span>
                    <span class="search-time">{{ formatHitTime(hitTime(hit)) }}</span>
                  </span>
                </button>
              </div>
            </div>
          </template>

          <!-- 非搜索态：原来的会话列表，下拉刷新与新建对话都不受影响 -->
          <template v-else>
            <!-- 下拉刷新：重新从 IndexedDB 读会话列表 -->
            <div
              class="pull-wrap"
              :style="{ transform: `translateY(${pull.distance.value}px)` }"
              @touchstart.passive="pull.handlers.onTouchStart"
              @touchmove="pull.handlers.onTouchMove"
              @touchend="pull.handlers.onTouchEnd"
              @touchcancel="pull.handlers.onTouchEnd"
            >
              <div
                class="pull-indicator"
                :class="{ active: pull.distance.value > 0 || pull.refreshing.value }"
                :style="{ opacity: Math.min(pull.distance.value / pull.threshold, 1) }"
              >
                {{ pull.refreshing.value ? '正在刷新…' : '下拉刷新' }}
              </div>

              <div ref="sheetBody" class="sheet-body scroll-y">
                <EmptyState v-if="chat.sessions.length === 0" title="还没有会话" />

                <div
                  v-for="session in chat.sessions"
                  :key="session.id"
                  class="session"
                  :class="{ active: session.id === chat.currentSessionId }"
                >
                  <!-- 重命名态：直接在原位变成输入框，不做二次弹窗 -->
                  <template v-if="renamingId === session.id">
                    <input
                      v-model="renameDraft"
                      class="rename-input"
                      maxlength="30"
                      autofocus
                      @keydown.enter="commitRename"
                      @keydown.esc="renamingId = null"
                    />
                    <button class="session-act" aria-label="确认重命名" @click="commitRename">
                      <AppIcon name="check" />
                    </button>
                  </template>

                  <template v-else>
                    <button class="session-main" @click="pickSession(session.id)">
                      <span class="session-title">{{ session.title }}</span>
                      <span class="session-time">
                        {{ new Date(session.updatedAt).toLocaleDateString('zh-CN') }}
                      </span>
                    </button>
                    <button class="session-act" aria-label="重命名" @click="startRename(session.id, session.title)">
                      <AppIcon name="edit" />
                    </button>
                    <button class="session-act danger" aria-label="删除会话" @click="removeSession(session.id)">
                      <AppIcon name="trash" />
                    </button>
                  </template>
                </div>
              </div>
            </div>

            <button class="sheet-new" @click="newSession">
              <AppIcon name="plus" />
              新建对话
            </button>
          </template>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding-top: var(--safe-top);
  position: relative;
  background: var(--bg);
}

/* ---- 顶栏 ---- */
.header {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  min-height: var(--header-h);
  padding: 12px var(--sp-4);
  border-bottom: 1px solid var(--border);
  background: var(--surface-1);
  z-index: 5;
}

.header-left {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-width: 0;
}

.avatar {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: var(--r-sm);
  display: grid;
  place-items: center;
  font-size: 1rem;
  font-weight: 700;
  color: var(--brand);
  background: var(--brand-soft);
  border: 1px solid var(--border);
  transition:
    transform var(--dur-fast) var(--ease),
    border-color var(--dur) var(--ease);
}

.avatar:active {
  transform: scale(0.9);
  border-color: var(--brand);
}

.icon-btn:disabled {
  opacity: 0.35;
}

.header-text {
  min-width: 0;
}

.header-title {
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: 620;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 46vw;
}

.header-sub {
  margin: 0;
  font-size: 0.625rem;
  color: var(--text-3);
  letter-spacing: 0.05em;
}

.header-actions {
  display: flex;
  gap: 2px;
  flex: none;
}

.icon-btn {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border-radius: var(--r-full);
  color: var(--text-2);
  font-size: 1.1875rem;
  transition: background var(--dur-fast) var(--ease);
}

.icon-btn:active {
  background: var(--surface-2);
}

/* ---- 消息区 ---- */
.messages {
  flex: 1;
  min-height: 0;
  padding: var(--sp-4) var(--sp-4) var(--sp-2);
  /* 上滑加载历史时不要触发浏览器的下拉刷新/滚动穿透 */
  overscroll-behavior-y: contain;
}

/* ---- 欢迎屏（跟着角色变） ---- */
.welcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: var(--sp-6) var(--sp-4);
}

.welcome-avatar {
  width: 68px;
  height: 68px;
  border-radius: var(--r-lg);
  display: grid;
  place-items: center;
  font-size: 1.8rem;
  font-weight: 700;
  color: var(--brand);
  background: var(--brand-soft);
  border: 1px solid var(--border);
  animation: welcome-in var(--dur-slow) var(--ease);
}

@keyframes welcome-in {
  from {
    opacity: 0;
    transform: scale(0.82);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.welcome-name {
  margin: var(--sp-3) 0 0;
  font-size: var(--fs-lg);
  font-weight: 680;
}

.welcome-line {
  margin: var(--sp-2) 0 0;
  max-width: 30ch;
  font-size: var(--fs-sm);
  line-height: 1.75;
  color: var(--text-2);
}

.welcome-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: var(--sp-5);
  padding: 9px 16px;
  border-radius: var(--r-full);
  font-size: var(--fs-xs);
  color: var(--brand);
  background: var(--brand-soft);
  border: 1px solid transparent;
  transition: transform var(--dur-fast) var(--ease);
}

.welcome-switch:active {
  transform: scale(0.96);
}

/* ---- 上滑加载更早的消息 ---- */
.load-hint {
  margin: 0 0 var(--sp-4);
  text-align: center;
  font-size: 0.6875rem;
  letter-spacing: 0.08em;
  color: var(--text-3);
}

.loading-older {
  margin-bottom: var(--sp-2);
  border-radius: var(--r-md);
  background: var(--surface-1);
  border: 1px solid var(--border);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--sp-2);
  margin-top: var(--sp-4);
}

.chip {
  padding: 8px 13px;
  border-radius: var(--r-full);
  font-size: var(--fs-xs);
  color: var(--text-2);
  background: var(--surface-1);
  border: 1px solid var(--border);
  transition:
    transform var(--dur-fast) var(--ease),
    background var(--dur) var(--ease);
}

.chip:active {
  transform: scale(0.96);
  background: var(--surface-2);
}

.to-bottom {
  position: absolute;
  right: var(--sp-4);
  bottom: 108px;
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: var(--r-full);
  color: var(--text-1);
  font-size: 1.125rem;
  background: color-mix(in srgb, var(--bg) 72%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--border-strong);
  transform: rotate(180deg);
  z-index: 6;
}

/* ---- 错误条 ---- */
.error {
  flex: none;
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  margin: 0 var(--sp-4) var(--sp-2);
  padding: 10px 12px;
  border-radius: var(--r-md);
  background: rgba(255, 107, 129, 0.1);
  border: 1px solid rgba(255, 107, 129, 0.3);
}

.error-icon {
  font-size: 1rem;
  color: var(--danger);
  margin-top: 2px;
}

.error-text {
  flex: 1;
  margin: 0;
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-1);
}

.error-close {
  color: var(--text-3);
  font-size: 0.9375rem;
  padding: 2px;
}
.error-retry {
  flex: none;
  padding: 6px 11px;
  border-radius: var(--r-full);
  color: var(--bg);
  background: var(--danger);
  font-size: var(--fs-xs);
  font-weight: 650;
}
.error-retry:disabled {
  opacity: 0.45;
}

/* ---- 输入区 ---- */
.composer {
  flex: none;
  padding: 8px var(--sp-4) var(--sp-3);
  border-top: 1px solid var(--border);
  background: var(--surface-1);
}
.generation-state {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  min-height: 28px;
  margin-bottom: 5px;
  color: var(--text-2);
  font-size: var(--fs-xs);
}
.generation-state button {
  color: var(--brand);
  padding: 7px 10px;
  border-radius: var(--r-full);
  background: var(--brand-soft);
}
.document-scope {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: var(--fs-sm);
  color: var(--text-2);
}
.document-scope select {
  min-width: 0;
  flex: 1;
  padding: 8px;
  color: var(--text-1);
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
}

.composer-warn {
  display: block;
  text-align: center;
  padding: 11px;
  border-radius: var(--r-md);
  font-size: var(--fs-sm);
  color: var(--warning);
  background: rgba(255, 196, 107, 0.1);
  border: 1px solid rgba(255, 196, 107, 0.26);
}

.composer-row {
  display: flex;
  align-items: flex-end;
  gap: var(--sp-2);
}

.input {
  flex: 1;
  min-height: 42px;
  max-height: 120px;
  padding: 10px 14px;
  border-radius: var(--r-lg);
  background: var(--surface-1);
  border: 1px solid var(--border);
  font-size: var(--fs-md);
  line-height: 1.5;
  resize: none;
  outline: none;
  transition: border-color var(--dur) var(--ease);
}

.input:focus {
  border-color: var(--brand);
}

.input::placeholder {
  color: var(--text-3);
}

.send-btn {
  flex: none;
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border-radius: var(--r-full);
  font-size: 1.1875rem;
  color: var(--bg);
  background: var(--brand);
  transition:
    transform var(--dur-fast) var(--ease),
    opacity var(--dur) var(--ease);
}

.send-btn:active {
  transform: scale(0.92);
}

.send-btn:disabled {
  opacity: 0.35;
}

.send-btn.stop {
  background: var(--surface-3);
  color: var(--text-1);
}

/* ---- 从搜索结果跳过来时闪一下 ----
   只加一层背景淡出，不改尺寸与内边距：定位到某条消息时画面绝不能因为高亮而抖一下 */
.flash-on {
  border-radius: var(--r-md);
  animation: message-flash 1.4s var(--ease);
}

@keyframes message-flash {
  from {
    background-color: var(--brand-soft);
  }
  to {
    background-color: transparent;
  }
}

/* ---- 会话浮层 ---- */
.sheet-mask {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: flex-end;
  z-index: 20;
}

.sheet {
  width: 100%;
  max-height: 74%;
  display: flex;
  flex-direction: column;
  padding: 0 var(--sp-4) calc(var(--sp-4) + var(--safe-bottom));
  border-radius: var(--r-lg) var(--r-lg) 0 0;
  background: var(--bg-elev, #10121d);
  background: color-mix(in srgb, var(--bg) 92%, white 8%);
  border-top: 1px solid var(--border-strong);
}

.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-4) 0 var(--sp-2);
}

.sheet-title {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: 620;
}

/* ---- 跨会话搜索 ---- */
.search-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
  padding: 0 var(--sp-3);
  min-height: 40px;
  border-radius: var(--r-md);
  background: var(--surface-1);
  border: 1px solid var(--border);
  transition: border-color var(--dur) var(--ease);
}

.search-bar:focus-within {
  border-color: var(--brand);
}

.search-bar-icon {
  flex: none;
  font-size: 0.9375rem;
  color: var(--text-3);
}

.search-input {
  flex: 1;
  min-width: 0;
  padding: 10px 0;
  border: none;
  outline: none;
  background: none;
  font-size: var(--fs-sm);
}

.search-input::placeholder {
  color: var(--text-3);
}

/* iOS 会给 type=search 挂一个原生小叉，和右边的清空按钮重复 */
.search-input::-webkit-search-cancel-button {
  display: none;
}

.search-bar-clear {
  flex: none;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: var(--r-full);
  font-size: 0.875rem;
  color: var(--text-3);
}

.search-bar-clear:active {
  background: var(--surface-3);
}

/* 状态行在滚动容器之外，列表的 scrollTop 才严格等于「第几行 × 行高」 */
.search-status {
  flex: none;
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.search-scanned {
  color: var(--text-3);
}

.search-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.search-empty {
  padding-top: var(--sp-4);
}

/*
 * 搜索结果行：高度固定 76px。
 * 必须与脚本里的 SEARCH_ROW_HEIGHT 完全一致 —— 虚拟滚动靠「scrollTop ÷ 行高」
 * 反推可见区间，行高对不上就会整片错位（要么留白，要么盖住内容）。
 */
.search-row {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  width: 100%;
  height: 76px;
  padding: 0 var(--sp-2);
  text-align: left;
  border-radius: var(--r-md);
  transition: background var(--dur-fast) var(--ease);
}

.search-row:active {
  background: var(--surface-2);
}

.search-line {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  /* 片段最多两行，超出的部分裁掉：行高固定，内容就不能想长多长 */
  -webkit-line-clamp: 2;
  overflow: hidden;
  font-size: var(--fs-sm);
  line-height: 1.45;
  color: var(--text-1);
  word-break: break-word;
}

.search-hit {
  font-style: normal;
  font-weight: 620;
  color: var(--brand);
  background: var(--brand-soft);
  border-radius: 4px;
}

.search-tag {
  display: inline-block;
  margin-right: 5px;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: var(--fs-xs);
  color: var(--brand);
  background: var(--brand-soft);
}

.search-meta {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.search-session {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.search-time {
  flex: none;
}

/* 下拉刷新容器：整个列表跟随手指位移 */
.pull-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  transition: transform var(--dur) var(--ease);
}

.pull-indicator {
  flex: none;
  height: 0;
  display: grid;
  place-items: center;
  font-size: var(--fs-xs);
  color: var(--text-3);
  /* 指示器占 0 高度，靠上方的 translateY 把它带到可见位置 */
  overflow: visible;
  white-space: nowrap;
  margin-top: -22px;
  padding-bottom: 22px;
}

.pull-indicator.active {
  color: var(--brand);
}

.sheet-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* 下拉手势由外层接管，这里禁掉 overscroll 联动避免和刷新打架 */
  overscroll-behavior: contain;
}

.session {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px var(--sp-2) 4px 0;
  border-radius: var(--r-md);
  transition: background var(--dur-fast) var(--ease);
}

.session.active {
  background: var(--brand-soft);
}

.session-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: 12px var(--sp-3);
  text-align: left;
  border-radius: var(--r-md);
}

.session-main:active {
  background: var(--surface-2);
}

.session-title {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-sm);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-time {
  flex: none;
  font-size: 0.625rem;
  color: var(--text-3);
}

.session-act {
  flex: none;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: var(--r-full);
  font-size: 0.9375rem;
  color: var(--text-3);
}

.session-act:active {
  background: var(--surface-3);
}

.session-act.danger:active {
  color: var(--danger);
  background: rgba(255, 107, 129, 0.12);
}

/* 原位重命名：直接变成输入框，不弹二次对话框 */
.rename-input {
  flex: 1;
  min-width: 0;
  margin: 8px var(--sp-2) 8px var(--sp-3);
  padding: 8px 11px;
  border-radius: var(--r-sm);
  background: var(--surface-1);
  border: 1px solid var(--brand);
  font-size: var(--fs-sm);
  outline: none;
}

.sheet-new {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
  padding: 12px;
  border-radius: var(--r-md);
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--brand);
  background: var(--brand-soft);
}

/* ---- 过渡 ---- */
.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--dur) var(--ease);
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.sheet-enter-active,
.sheet-leave-active {
  transition: opacity var(--dur) var(--ease);
}

.sheet-enter-active .sheet,
.sheet-leave-active .sheet {
  transition: transform var(--dur) var(--ease);
}

.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}

.sheet-enter-from .sheet,
.sheet-leave-to .sheet {
  transform: translateY(100%);
}

.scope-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  min-height: 32px;
  margin-bottom: 6px;
  color: var(--text-3);
  font-size: var(--fs-xs);
}
.scope-toggle span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scope-toggle .expanded {
  transform: rotate(180deg);
}
</style>
