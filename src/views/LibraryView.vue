<script setup lang="ts">
/** 知识库：导入资料、关键词检索与带出处问答。 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useChatStore } from '@/stores/chat'
import AppIcon from '@/components/AppIcon.vue'
import { useToast } from '@/composables/useToast'
import { useVirtualList } from '@/composables/useVirtualList'
import { useRagStore } from '@/stores/rag'
import type { RagChunk, RagDocument } from '@/rag/types'

const rag = useRagStore()
const chat = useChatStore()
const router = useRouter()
function askDocument(id: string): void {
  chat.selectedDocumentId = id
  void router.push('/chat')
}
const { show } = useToast()
const title = ref('')
const text = ref('')
const query = ref('')
const hits = ref<Awaited<ReturnType<typeof rag.search>>>([])
const fileInput = ref<HTMLInputElement | null>(null)
const searching = ref(false)
const pdfParsing = ref(false)
const pdfProgress = ref(0)

const DEMO_TITLE = '智慧校园课程设计验收说明'
const DEMO_TEXT = `项目名称：AI 智囊团。项目目标是把角色对话、个人知识库与本地预测整合为一个移动端应用。

核心功能包括：多角色流式对话；资料导入、分块检索与带出处回答；在设备本地训练时间序列模型并展示预测指标。

验收要求：演示过程必须展示资料引用来源；预测指标必须来自按时间顺序划分的测试集，归一化参数只能使用训练段计算，避免数据泄漏。

隐私设计：API Key、聊天记录、用户记忆和导入资料都保存在用户设备本地。资料不足时，系统应明确说明无法从资料确认，不得编造结论。

答辩重点：说明统一记忆层如何连接各功能；说明知识库如何通过关键词检索为回答提供出处；说明预测模块为何采用时间顺序切分。`

function fillDemoDocument(): void {
  title.value = DEMO_TITLE
  text.value = DEMO_TEXT
  show('示例资料已填入，点击“导入资料”即可建立演示知识库', 'success')
}

/* ---- 分块浏览 ---- */
/**
 * 一份长资料可能切出几百个分块，一次性渲染出来会明显卡顿，
 * 所以这块列表走虚拟滚动：只渲染视口内的行。
 * 代价是行高必须固定，因此每块内容在列表里做行数截断，
 * 想看全文可以点开单块（面板里给一个展开）。
 */
const browsing = ref<RagDocument | null>(null)
/**
 * 正在看全文的那一块。
 * 之所以另起一层而不是「在列表里展开这一行」：虚拟滚动要求行高固定，
 * 行一旦被撑高，后面的行位置就全错了。单独一层还能保住列表的滚动位置。
 */
const viewingChunk = ref<RagChunk | null>(null)

const browseChunks = computed(() =>
  browsing.value ? rag.chunks.filter((chunk) => chunk.documentId === browsing.value?.id) : []
)

/** 必须与 CSS 里 .chunk-row 的高度一致，否则虚拟滚动会错位 */
const CHUNK_ROW_HEIGHT = 88

// 解构出来用：模板里只有顶层的 ref 会自动解包，挂在对象上的 ref 不会
const {
  scroller: chunkScroller,
  visible: visibleChunks,
  onScroll: onChunkScroll,
  scrollToTop: scrollChunksToTop,
  padTop: chunkPadTop,
  padBottom: chunkPadBottom,
  start: chunkStart,
  end: chunkEnd
} = useVirtualList({
  items: () => browseChunks.value,
  rowHeight: CHUNK_ROW_HEIGHT
})

function openChunks(doc: RagDocument): void {
  browsing.value = doc
  viewingChunk.value = null
  // 换一份资料要回到顶部，否则会沿用上一份的滚动位置
  scrollChunksToTop()
}

function closeChunks(): void {
  browsing.value = null
  viewingChunk.value = null
}

async function importText(): Promise<void> {
  if (!text.value.trim()) {
    show('请先粘贴一段资料', 'error')
    return
  }
  const doc = await rag.importText(title.value || '粘贴资料', 'text', text.value)
  if (doc) {
    title.value = ''
    text.value = ''
    show(`已导入 ${doc.chunkCount} 个片段`, 'success')
  }
}

function chooseFile(): void {
  fileInput.value?.click()
}

async function readFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const name = file.name.toLowerCase()
  input.value = ''

  if (name.endsWith('.txt')) {
    text.value = await file.text()
    title.value = file.name.replace(/\.txt$/i, '')
    return
  }

  if (name.endsWith('.pdf')) {
    pdfParsing.value = true
    pdfProgress.value = 0
    try {
      /**
       * 动态引入，不要提到文件顶部。
       * pdfjs 主库约 470 KB，一旦静态引入就会被打进本视图的分包，
       * 用户打开「问知」就立刻下载 —— 而多数人根本不会解析 PDF。
       * 推迟到真正选中 PDF 的那一刻，首屏代价直接归零。
       */
      const { extractPdfText } = await import('@/rag/pdf')
      const result = await extractPdfText(await file.arrayBuffer(), (done, total) => {
        pdfProgress.value = Math.round((done / total) * 100)
      })
      if (!result.hasText) {
        show('这份 PDF 没有文本层（可能是扫描件），请先 OCR 再粘贴文本', 'error')
        return
      }
      text.value = result.text
      title.value = file.name.replace(/\.pdf$/i, '')
      show(`已解析 ${result.pageCount} 页，确认内容后点「导入资料」`, 'success')
    } catch (error) {
      show(`PDF 解析失败：${(error as Error).message}`, 'error')
    } finally {
      pdfParsing.value = false
      pdfProgress.value = 0
    }
    return
  }

  show('仅支持 TXT 与 PDF 文件', 'error')
}

async function search(): Promise<void> {
  if (!query.value.trim()) return
  searching.value = true
  try {
    hits.value = await rag.search(query.value, 5)
  } finally {
    searching.value = false
  }
}

async function remove(id: string): Promise<void> {
  try {
    await rag.deleteDocument(id)
    hits.value = hits.value.filter((hit) => hit.chunk.documentId !== id)
    if (browsing.value?.id === id) closeChunks()
    show('资料已删除', 'success')
  } catch (error) {
    show(`删除失败：${(error as Error).message}`, 'error')
  }
}
</script>

<template>
  <div class="page scroll-y">
    <header class="head safe-x">
      <div>
        <h1 class="title">资料</h1>
        <p class="subtitle">丢进资料，带着出处提问</p>
      </div>
    </header>

    <section class="section safe-x">
      <details class="import-fold">
        <summary>导入资料 <AppIcon name="chevron" /></summary>
        <div class="import-card">
          <button class="demo-fill" @click="fillDemoDocument"><AppIcon name="sparkle" />填入示例资料</button>
          <input v-model="title" class="title-input" placeholder="资料标题（如：课程设计要求）" />
          <textarea v-model="text" class="text-input" rows="7" placeholder="粘贴资料正文" />
          <div class="import-actions">
            <input
              ref="fileInput"
              hidden
              type="file"
              accept=".txt,.pdf,text/plain,application/pdf"
              @change="readFile"
            />
            <button class="secondary-btn" :disabled="pdfParsing" @click="chooseFile">
              <AppIcon name="database" />{{ pdfParsing ? `解析中 ${pdfProgress}%` : '选择 TXT / PDF' }}
            </button>
            <button class="primary-btn" :disabled="rag.importing || pdfParsing" @click="importText">
              {{ rag.importing ? `${rag.progress}%` : '导入资料' }}
            </button>
          </div>
          <div v-if="rag.importing" class="progress">
            <span :style="{ width: `${rag.progress}%` }" /><small>{{ rag.progressText }}</small>
          </div>
          <div v-if="pdfParsing" class="progress">
            <span :style="{ width: `${pdfProgress}%` }" /><small>正在解析 PDF 文本层…</small>
          </div>
        </div>
      </details>
    </section>

    <section class="section safe-x">
      <h2 class="section-title">
        资料库 <span class="count">{{ rag.documents.length }}</span>
      </h2>
      <div v-if="!rag.documents.length" class="empty-mini">
        <AppIcon name="library" /><span>还没有资料，先粘贴一段文本吧</span>
      </div>
      <article v-for="doc in rag.documents" :key="doc.id" class="doc-card">
        <!-- 图标与标题整体做成按钮：点开看这份资料切出来的分块 -->
        <button class="doc-open" :aria-label="`查看《${doc.title}》的分块`" @click="openChunks(doc)">
          <span class="doc-icon"><AppIcon name="library" /></span>
          <span class="doc-body">
            <strong>{{ doc.title }}</strong
            ><small>{{ doc.charCount }} 字 · {{ doc.chunkCount }} 个片段</small>
          </span>
        </button>
        <button
          class="doc-action"
          :disabled="chat.streaming"
          aria-label="问这份资料"
          title="问这份资料"
          @click="askDocument(doc.id)"
        >
          <AppIcon name="chat" />
        </button>
        <button class="doc-action danger" aria-label="删除资料" @click="remove(doc.id)">
          <AppIcon name="trash" />
        </button>
      </article>
    </section>

    <section class="section safe-x">
      <details class="search-fold">
        <summary>查找原文 <AppIcon name="chevron" /></summary>
        <div class="search-row">
          <input
            v-model="query"
            class="search-input"
            placeholder="例如：这份资料的核心要求是什么？"
            @keydown.enter="search"
          /><button class="search-btn" :disabled="searching" aria-label="检索资料" @click="search">
            <AppIcon name="chat" />
          </button>
        </div>
        <div v-if="hits.length" class="hits">
          <article v-for="(hit, index) in hits" :key="hit.chunk.id" class="hit">
            <div class="hit-head">
              <span>[{{ index + 1 }}] {{ hit.chunk.documentTitle }}</span
              ><small>原文片段</small>
            </div>
            <p>{{ hit.chunk.content }}</p>
          </article>
        </div>
      </details>
    </section>
    <p v-if="rag.errorText" class="error safe-x">{{ rag.errorText }}</p>
    <div class="tail" />

    <!--
      分块浏览面板。
      自己就是滚动容器（不复用整页滚动）—— 虚拟滚动需要知道 scrollTop 是相对谁的，
      挂在整页滚动上就得反算列表在页面里的偏移，脆而且容易错位。
    -->
    <div v-if="browsing" class="sheet" role="dialog" aria-modal="true" :aria-label="`${browsing.title} 的分块`">
      <header class="sheet-head">
        <div class="sheet-head-text">
          <p class="sheet-title">{{ browsing.title }}</p>
          <p class="sheet-sub">共 {{ browseChunks.length }} 块 · 正在渲染第 {{ chunkStart + 1 }}–{{ chunkEnd }} 块</p>
        </div>
        <button class="sheet-close" aria-label="关闭" @click="closeChunks"><AppIcon name="close" /></button>
      </header>

      <div ref="chunkScroller" class="sheet-body scroll-y" @scroll.passive="onChunkScroll">
        <!-- 上下占位把滚动高度撑到「全部块 × 行高」，可见行只渲染这一小段 -->
        <div :style="{ paddingTop: `${chunkPadTop}px`, paddingBottom: `${chunkPadBottom}px` }">
          <article v-for="chunk in visibleChunks" :key="chunk.id" class="chunk-row">
            <div class="chunk-head">
              <span class="chunk-index">#{{ chunk.index + 1 }}</span>
              <span class="chunk-meta">{{ chunk.content.length }} 字</span>
              <button class="chunk-toggle" @click="viewingChunk = chunk">全文</button>
            </div>
            <p class="chunk-text">{{ chunk.content }}</p>
          </article>
        </div>
      </div>
    </div>

    <!-- 单块全文。独立一层，盖在分块列表之上，列表的滚动位置不受影响 -->
    <div v-if="viewingChunk" class="chunk-detail" role="dialog" aria-modal="true" aria-label="分块全文">
      <header class="sheet-head">
        <div class="sheet-head-text">
          <p class="sheet-title">第 {{ viewingChunk.index + 1 }} 块</p>
          <p class="sheet-sub">
            {{ viewingChunk.content.length }} 字 · 原文位置 {{ viewingChunk.start }}–{{ viewingChunk.end }}
          </p>
        </div>
        <button class="sheet-close" aria-label="返回列表" @click="viewingChunk = null">返回</button>
      </header>
      <div class="detail-body scroll-y">
        <p>{{ viewingChunk.content }}</p>
      </div>
    </div>
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
  gap: 12px;
  flex-wrap: wrap;
  justify-content: space-between;
  padding: var(--sp-5) var(--sp-5) var(--sp-3);
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
.mode {
  padding: 4px 8px;
  border-radius: var(--r-full);
  font-size: 0.625rem;
  color: var(--warning);
  background: rgba(255, 196, 107, 0.12);
}
.mode.vector {
  color: var(--success);
  background: rgba(79, 209, 165, 0.12);
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
.count {
  color: var(--brand);
}
.import-card {
  padding: var(--sp-4);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: linear-gradient(145deg, var(--bg-glow), var(--surface-1) 65%);
}
.demo-fill {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  margin-bottom: var(--sp-3);
  padding: 11px 14px;
  border: 1px solid color-mix(in srgb, var(--brand) 34%, var(--border));
  border-radius: var(--r-md);
  color: var(--brand);
  background: linear-gradient(135deg, var(--brand-soft), transparent);
  font-size: var(--fs-sm);
  font-weight: 650;
}
.title-input,
.text-input,
.search-input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  outline: none;
  font-size: var(--fs-sm);
}
.title-input {
  padding: 10px 12px;
  margin-bottom: var(--sp-2);
}
.text-input {
  padding: 11px 12px;
  resize: vertical;
  line-height: 1.65;
}
.title-input:focus,
.text-input:focus,
.search-input:focus {
  border-color: var(--brand);
}
.import-actions {
  display: flex;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}
.secondary-btn,
.primary-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 11px;
  border-radius: var(--r-md);
  font-size: var(--fs-sm);
}
.secondary-btn {
  color: var(--text-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
}
.primary-btn {
  color: var(--brand-on);
  background: var(--brand-action);
}
.primary-btn:disabled {
  opacity: 0.5;
}
.progress {
  position: relative;
  height: 28px;
  margin-top: var(--sp-2);
  overflow: hidden;
  border-radius: var(--r-sm);
  background: var(--surface-2);
}
.progress span {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--brand-soft);
  transition: width 0.2s;
}
.progress small {
  position: relative;
  display: block;
  padding: 7px 10px;
  font-size: 0.625rem;
  color: var(--text-2);
}
.empty-mini {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: var(--sp-5);
  border: 1px dashed var(--border);
  border-radius: var(--r-md);
  color: var(--text-3);
  font-size: var(--fs-xs);
}
.doc-card {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-3);
  margin-bottom: var(--sp-2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-1);
}
.doc-icon {
  flex: none;
  display: grid;
  place-items: center;
  color: var(--brand);
  font-size: 1.25rem;
}
/* 图标 + 标题整体可点，用来打开分块面板 */
.doc-open {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  text-align: left;
}
.doc-open:active {
  opacity: 0.72;
}
.doc-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.doc-body strong {
  font-size: var(--fs-sm);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.doc-body small {
  font-size: 0.625rem;
  color: var(--text-3);
}
.doc-action {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: var(--r-full);
  color: var(--brand);
  font-size: 0.9375rem;
}
.doc-action:active {
  background: var(--brand-soft);
}
.doc-action.danger:active {
  color: var(--danger);
  background: rgba(255, 107, 129, 0.12);
}

/* ---------- 分块浏览面板 ---------- */
.sheet {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  padding-top: var(--safe-top);
}
.sheet-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-4) var(--sp-5);
  border-bottom: 1px solid var(--border);
}
.sheet-head-text {
  flex: 1;
  min-width: 0;
}
.sheet-title {
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sheet-sub {
  margin: 3px 0 0;
  font-size: 0.625rem;
  color: var(--text-3);
}
.sheet-close {
  flex: none;
  padding: 7px 12px;
  border-radius: var(--r-full);
  font-size: var(--fs-xs);
  color: var(--text-2);
  background: var(--surface-1);
  border: 1px solid var(--border);
}
.sheet-close:active {
  background: var(--surface-2);
}
/* 虚拟滚动的滚动容器：必须有确定高度（flex:1 + min-height:0），
   否则 clientHeight 量出来是 0，可见区间就算不对 */
.sheet-body {
  flex: 1;
  min-height: 0;
  padding: 0 var(--sp-4);
}

/*
 * 行高必须与 useVirtualList 的 CHUNK_ROW_HEIGHT 完全一致。
 * 这里刻意不用 margin：margin 不计入 height，会把行距撑大，
 * 于是滚到后面每一行都偏一点，越滚越错。
 */
.chunk-row {
  height: 88px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  overflow: hidden;
}
.chunk-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  line-height: 1.4;
  font-size: 0.625rem;
  color: var(--text-3);
}
.chunk-index {
  color: var(--brand);
}
.chunk-vec {
  padding: 1px 6px;
  border-radius: var(--r-full);
  color: var(--success);
  background: rgba(79, 209, 165, 0.12);
}
.chunk-toggle {
  margin-left: auto;
  font-size: 0.625rem;
  color: var(--brand);
}
.chunk-text {
  margin: 6px 0 0;
  font-size: var(--fs-xs);
  line-height: 1.55;
  color: var(--text-2);
  /* 固定两行截断：行高固定是虚拟滚动的前提，想看全文走「全文」按钮 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* 单块全文，盖在分块列表之上 */
.chunk-detail {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  padding-top: var(--safe-top);
}
.detail-body {
  flex: 1;
  min-height: 0;
  padding: var(--sp-4) var(--sp-5);
}
.detail-body p {
  margin: 0;
  font-size: var(--fs-sm);
  line-height: 1.85;
  color: var(--text-1);
  white-space: pre-wrap;
  word-break: break-word;
}
.search-row {
  display: flex;
  gap: var(--sp-2);
}
.search-input {
  flex: 1;
  padding: 11px 12px;
}
.search-btn {
  width: 42px;
  border-radius: var(--r-md);
  color: var(--brand-on);
  background: var(--brand-action);
  font-size: 1.125rem;
}
.search-btn:disabled {
  opacity: 0.5;
}
.hits {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
}
.hit {
  padding: var(--sp-3);
  border-radius: var(--r-md);
  border: 1px solid var(--border);
  background: var(--surface-1);
}
.hit-head {
  display: flex;
  justify-content: space-between;
  gap: var(--sp-2);
  color: var(--brand);
  font-size: var(--fs-xs);
}
.hit-head small {
  color: var(--text-3);
}
.hit p {
  margin: 8px 0 0;
  font-size: var(--fs-sm);
  line-height: 1.65;
  color: var(--text-2);
}
.error {
  margin-bottom: var(--sp-3);
  color: var(--danger);
  font-size: var(--fs-xs);
}
.tail {
  height: var(--sp-6);
}

.import-fold,
.search-fold {
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--surface-1);
  overflow: hidden;
}
.import-fold > summary,
.search-fold > summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  list-style: none;
  font-size: var(--fs-sm);
  cursor: pointer;
}
.import-fold > summary::-webkit-details-marker,
.search-fold > summary::-webkit-details-marker {
  display: none;
}
.import-fold[open] > summary,
.search-fold[open] > summary {
  border-bottom: 1px solid var(--border);
}
.import-fold[open] > summary .icon,
.search-fold[open] > summary .icon {
  transform: rotate(180deg);
}
.import-fold .import-card {
  border: 0;
  border-radius: 0;
}
.search-fold .search-row,
.search-fold .hits {
  margin: 14px;
}
</style>
