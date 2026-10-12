<script setup lang="ts">
/**
 * 问数 · 数据预测分析台（P4）
 * ------------------------------------------------------------------
 * 全程在设备本地完成：粘贴一组时间序列，或导入 CSV 选一列 → TensorFlow.js
 * 训练微型模型 → 外推未来几个点并画图。没有任何数据离开浏览器。
 * 两条数据入口（粘贴 / CSV）最后都汇到同一个数据框，共用同一条解析链路。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import AppIcon from '@/components/AppIcon.vue'
import { useToast } from '@/composables/useToast'
import { useTheme } from '@/composables/useTheme'
import { useVirtualList } from '@/composables/useVirtualList'
import { drawForecastChart } from '@/ml/chart'
import { csvColumnText, parseCsv } from '@/ml/csv'
import { sampleSeries } from '@/ml/timeseries'
import { usePredictStore, type Sensitivity } from '@/stores/predict'
import { inspectSeries } from '@/ml/series'
import { SAMPLING_PERIODS, periodUnit, formatMetric, formatValue, explainTrend } from '@/ml/presentation'
const { theme, visualStyle } = useTheme()

interface ForecastScene {
  id: string
  emoji: string
  title: string
  caption: string
  unit: string
  source: string
  credit?: string
  values: number[]
}

const scenes: ForecastScene[] = [
  {
    id: 'sales',
    emoji: '🛍️',
    title: '店铺销售额',
    caption: '模拟经营 · 60 天',
    unit: '元',
    source: '周末 / 促销 / 异常',
    values: [
      1268, 1186, 1215, 1294, 1388, 1876, 2018, 1326, 1251, 1289, 1407, 1512, 2084, 2196, 1435, 1368, 1492, 2875, 2380,
      2264, 2318, 1540, 1466, 1589, 1698, 1762, 2245, 2468, 1612, 1578, 1665, 1784, 1839, 2421, 2576, 1715, 1630, 1698,
      1812, 1955, 3380, 2764, 1826, 1759, 1894, 1968, 2043, 2630, 2816, 1925, 1862, 1788, 1996, 2115, 2748, 2924, 2058,
      1976, 2140, 2268
    ]
  },
  {
    id: 'visits',
    emoji: '📡',
    title: '网站访问量',
    caption: '模拟访问 · 60 天',
    unit: '次',
    source: '引流峰值 / 自然回落',
    values: [
      3260, 3418, 3582, 3495, 3720, 2864, 2715, 3386, 3524, 3691, 4018, 4285, 3156, 2942, 3650, 3794, 3921, 4188, 6120,
      4486, 3265, 3884, 4012, 4215, 4398, 4572, 3428, 3180, 3976, 4158, 4312, 4520, 4686, 3515, 3298, 4095, 4270, 4468,
      4825, 7310, 5124, 3620, 4386, 4518, 4662, 4235, 3980, 3456, 3312, 4210, 4395, 4588, 4764, 4930, 3695, 3480, 4362,
      4510, 4788, 5065
    ]
  },
  {
    id: 'temperature',
    emoji: '🌤️',
    title: '长春日均气温',
    caption: '2026 年 6—7 月 · 实测',
    unit: '°C',
    source: '长春 · 日高低温均值',
    credit: '天气二四网',
    values: [
      21, 20, 19, 18.5, 17.5, 18.5, 13.5, 16, 17, 19, 20.5, 20, 22, 21, 20, 19, 20.5, 23, 24.5, 23.5, 21.5, 21, 21.5,
      22, 23, 23, 24.5, 24, 24, 25, 23.5, 23.5, 24.5, 24, 25, 24.5, 24.5, 24, 24.5, 24.5, 25, 24.5, 24.5, 24, 23, 23.5,
      25, 25.5, 24.5, 25, 26, 27, 28, 26, 26.5, 27, 27, 28.5, 29, 29
    ]
  }
]

const sensitivityPresets: Record<Sensitivity, { window: number; epochs: number; label: string }> = {
  stable: { window: 10, epochs: 120, label: '稳健' },
  standard: { window: 7, epochs: 160, label: '标准' },
  sensitive: { window: 4, epochs: 200, label: '灵敏' }
}

/**
 * 预览表格的固定行高（px）。
 * 必须与 CSS 里 .csv-table th/td 的 height 完全一致 —— 定高虚拟滚动是用
 * 「scrollTop ÷ 行高」算可见行的，差 1px 都会随滚动距离累积成整行错位。
 */
const CSV_ROW_HEIGHT = 36
/** 行号列宽（px）。同时用于表头 inline 宽度和表格最小宽度，避免两处各写一个数字 */
const CSV_INDEX_WIDTH = 44

const { show } = useToast()
const predict = usePredictStore()
const {
  input,
  config,
  sensitivity,
  activeScene,
  busy,
  progress,
  error,
  result,
  csvName,
  csvHeaders,
  csvRows,
  csvColumn,
  points,
  validation,
  samplingPeriod,
  valueUnit
} = storeToRefs(predict)
const run = predict.run
const canvas = ref<HTMLCanvasElement | null>(null)

const canTrain = computed(() => validation.value.canRun && !busy.value && !readingCsv.value)
const activeUnit = computed(() => valueUnit.value.trim())
const timeUnit = computed(() => periodUnit(samplingPeriod.value))

const insight = computed(() => {
  return result.value
    ? explainTrend(result.value.actual, result.value.forecast, samplingPeriod.value, activeUnit.value)
    : ''
})

const backtestSummary = computed(() => {
  const outcome = result.value
  if (!outcome) return ''
  const backtest = outcome.backtest
  if (!backtest)
    return `留出的历史数据不足 ${outcome.forecast.length} 个点，无法验证完整的 ${outcome.forecast.length} 步预测；下方单步指标不能代替多步准确度。`
  const modelMae = backtest.modelMetrics.mae
  const baselineMae = backtest.baselineMetrics.mae
  const verdict =
    modelMae < baselineMae ? '模型在这段历史上优于简单基线' : '模型在这段历史上未优于简单基线，建议谨慎参考'
  return `${backtest.origins} 个历史起点分别预测 ${backtest.horizon} 步：模型平均绝对误差 ${formatMetric(modelMae)}${activeUnit.value ? ` ${activeUnit.value}` : ''}，保持末值不变的基线 ${formatMetric(baselineMae)}。${outcome.method === 'constant' ? '恒定序列采用保持末值，与基线相同，不能据此证明趋势预测能力' : verdict}。`
})

function selectSensitivity(value: Sensitivity): void {
  sensitivity.value = value
  const preset = sensitivityPresets[value]
  config.value.window = preset.window
  config.value.epochs = preset.epochs
  result.value = null
}

function loadScene(scene: ForecastScene): void {
  samplingPeriod.value = 'day'
  valueUnit.value = scene.unit
  activeScene.value = scene.id
  input.value = scene.values.join(', ')
  result.value = null
  error.value = null
  show(`已载入${scene.title}的 60 天数据${scene.credit ? ` · 来源：${scene.credit}` : ''}`, 'success')
}

/* ---------------------------- CSV 导入与预览 ---------------------------- */

const csvInput = ref<HTMLInputElement | null>(null)
const readingCsv = ref(false)

const hasCsv = computed(() => csvHeaders.value.length > 0)
/** 列多时给表格一个下限宽度，否则 table-layout: fixed 会把每列压成十几像素 */
const csvTableWidth = computed(() => csvHeaders.value.length * 90 + CSV_INDEX_WIDTH)

/**
 * items 传 getter 而不是数组快照，换一个 CSV 文件时可见区间能自动重算。
 * padTop / padBottom 由上下两个占位行撑起滚动高度 —— 表格不能像普通列表那样
 * 用绝对定位，只能这么撑。
 */
const {
  scroller: csvScroller,
  visible: csvVisibleRows,
  total: csvTotalRows,
  onScroll: onCsvScroll,
  padTop: csvPadTop,
  padBottom: csvPadBottom,
  start: csvStart
} = useVirtualList<string[]>({ items: () => csvRows.value, rowHeight: CSV_ROW_HEIGHT })

function chooseCsv(): void {
  csvInput.value?.click()
}

/**
 * 把选中列拼成逗号文本写回数据框 —— CSV 与「粘贴」因此共用同一条链路
 * （textarea → parseSeries → points → trainForecast），没有第二套解析。
 * 顺带一个好处：导入后还能在数据框里继续手改数字。
 */
function applyCsvColumn(): void {
  const text = csvColumnText({ headers: csvHeaders.value, rows: csvRows.value }, csvColumn.value)
  input.value = text
  activeScene.value = ''
  error.value = null
  // 上一次的结果属于上一组数据，留着会让人误以为它就是这个文件跑出来的
  result.value = null

  const inspected = inspectSeries(text)
  const count = inspected.values.length
  if (inspected.issues.length) {
    show('该列有缺失或非数值，请查看数据检查提示后修正。', 'error')
    return
  }
  show(`已填入第 ${csvColumn.value + 1} 列（${csvHeaders.value[csvColumn.value]}）：${count} 个数值`, 'success')
}

async function readCsv(event: Event): Promise<void> {
  const el = event.target as HTMLInputElement
  const file = el.files?.[0]
  // 先清空 value：不清的话连续两次选同一个文件不会再触发 change
  el.value = ''
  if (!file) return
  if (file.size > 5 * 1024 * 1024) {
    show('CSV 超过 5 MB，请先截取需要预测的数据。', 'error')
    return
  }

  const name = file.name.toLowerCase()
  // 部分系统的选择器会给 .csv 报 application/vnd.ms-excel，所以同时看扩展名与 MIME
  if (!name.endsWith('.csv') && file.type !== 'text/csv' && file.type !== 'application/vnd.ms-excel') {
    show('只支持 CSV 文件（.csv）', 'error')
    return
  }

  readingCsv.value = true
  try {
    const text = await file.text()
    if (!text.trim()) {
      show('这个 CSV 是空文件，没有内容可以预览', 'error')
      return
    }
    const table = parseCsv(text)
    if (!table.headers.length) {
      show('没能从这个文件里解析出任何列，请确认它是标准 CSV', 'error')
      return
    }
    if (busy.value) predict.cancel()
    activeScene.value = ''
    samplingPeriod.value = 'step'
    valueUnit.value = ''
    input.value = ''
    csvName.value = file.name
    csvHeaders.value = table.headers
    csvRows.value = table.rows
    // 优先载入可识别的数值列，避免默认把日期列当成数值序列。
    const numericColumn = table.headers.findIndex((_, index) => {
      const inspected = inspectSeries(csvColumnText(table, index))
      return inspected.values.length >= 5 && inspected.issues.length === 0
    })
    csvColumn.value = numericColumn < 0 ? 0 : numericColumn
    // 换文件后把预览滚回顶部：scrollTop 由 composable 自己维护，
    // 上一个文件滚过很下面时残留的偏移会让新文件的可见区间算到别的位置去
    if (csvScroller.value) csvScroller.value.scrollTop = 0
    if (!table.rows.length) {
      // 只有表头也是有意义的信号：文件导错了，或者筛选后没剩下数据
      show('这个 CSV 只有表头，没有数据行', 'error')
      return
    }
    applyCsvColumn()
  } catch (err) {
    show(`读取失败：${(err as Error).message || '文件无法解码'}`, 'error')
  } finally {
    readingCsv.value = false
  }
}

/* -------------------------------- 训练 -------------------------------- */

function fillSample(): void {
  samplingPeriod.value = 'step'
  valueUnit.value = ''
  activeScene.value = ''
  input.value = sampleSeries().join(', ')
  error.value = null
  result.value = null
}

function clearAll(): void {
  samplingPeriod.value = 'step'
  valueUnit.value = ''
  input.value = ''
  activeScene.value = ''
  result.value = null
  error.value = null
  // CSV 预览一起清掉：数据框空了而表格还在，会让人以为两者还联动着
  csvName.value = ''
  csvHeaders.value = []
  csvRows.value = []
  csvColumn.value = 0
}

function redraw(): void {
  if (result.value && canvas.value) {
    drawForecastChart(canvas.value, result.value.actual, result.value.forecast, result.value.fitted, {
      forecastLabel: `未来 ${result.value.forecast.length} ${timeUnit.value}`
    })
  }
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function exportCsv(): void {
  const outcome = result.value
  if (!outcome) return
  const csvCell = (value: string) => `"${value.replace(/"/g, '""')}"`
  const rows = [
    `采样周期,${csvCell(SAMPLING_PERIODS[samplingPeriod.value])}`,
    `数值单位,${csvCell(activeUnit.value || '未指定')}`,
    `方法,${outcome.method === 'constant' ? '保持末值（恒定序列）' : '神经网络'}`,
    '',
    '阶段,序号,数值'
  ]
  outcome.actual.forEach((value, index) => rows.push(`实际,${index + 1},${value}`))
  outcome.forecast.forEach((value, index) => rows.push(`预测,${outcome.actual.length + index + 1},${value}`))
  rows.push('', '指标,数值')
  rows.push(
    `单步RMSE,${formatMetric(outcome.metrics.rmse)}`,
    `单步MAE,${formatMetric(outcome.metrics.mae)}`,
    `单步MAPE,${formatMetric(outcome.metrics.mape)}`,
    `单步R²,${formatMetric(outcome.metrics.r2, 3)}`
  )
  if (outcome.backtest)
    rows.push(
      `多步回测长度,${outcome.backtest.horizon}`,
      `多步回测起点数,${outcome.backtest.origins}`,
      `多步模型MAE,${outcome.backtest.modelMetrics.mae}`,
      `多步末值基线MAE,${outcome.backtest.baselineMetrics.mae}`
    )
  downloadBlob(new Blob([`\ufeff${rows.join('\r\n')}`], { type: 'text/csv;charset=utf-8' }), 'AI智囊团-预测结果.csv')
  show('预测数据 CSV 已导出', 'success')
}

async function exportReportImage(): Promise<void> {
  const outcome = result.value
  const chart = canvas.value
  if (!outcome || !chart) return

  const report = document.createElement('canvas')
  report.width = 1200
  report.height = 1120
  const ctx = report.getContext('2d')
  if (!ctx) return
  const colors = getComputedStyle(document.documentElement)
  const color = (name: string): string => colors.getPropertyValue(name).trim()
  ctx.fillStyle = color('--bg')
  ctx.fillRect(0, 0, report.width, report.height)
  const gradient = ctx.createLinearGradient(0, 0, report.width, report.height)
  gradient.addColorStop(0, color('--bg-glow'))
  gradient.addColorStop(1, color('--bg'))
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, report.width, report.height)

  ctx.fillStyle = color('--text-1')
  ctx.font = '700 52px system-ui, sans-serif'
  ctx.fillText('AI 智囊团 · 趋势预测报告', 72, 92)
  ctx.fillStyle = color('--text-2')
  ctx.font = '26px system-ui, sans-serif'
  ctx.fillText(
    `${outcome.method === 'constant' ? '保持末值' : '本地模型'} · ${outcome.actual.length} 个数据点 · 未来 ${outcome.forecast.length} ${timeUnit.value} · 单位：${activeUnit.value || '未指定'}`,
    72,
    142
  )

  ctx.fillStyle = color('--surface-1')
  ctx.fillRect(72, 190, 1056, 520)
  // 报告重绘高清曲线，避免把手机端的小画布直接拉大而模糊。
  const reportChart = document.createElement('canvas')
  drawForecastChart(reportChart, outcome.actual, outcome.forecast, outcome.fitted, {
    width: 508,
    height: 240,
    pixelRatio: 2,
    forecastLabel: `未来 ${outcome.forecast.length} ${timeUnit.value}`
  })
  ctx.drawImage(reportChart, 92, 210, 1016, 480)

  const cards = [
    ['多步预测 MAE', formatMetric(outcome.backtest?.modelMetrics.mae)],
    ['末值基线 MAE', formatMetric(outcome.backtest?.baselineMetrics.mae)],
    ['单步 MAE', formatMetric(outcome.metrics.mae)],
    ['单步 R²', formatMetric(outcome.metrics.r2, 3)]
  ]
  cards.forEach(([label, value], index) => {
    const x = 72 + index * 264
    ctx.fillStyle = color('--surface-1')
    ctx.fillRect(x, 752, 240, 142)
    ctx.fillStyle = color('--text-1')
    ctx.font = '700 36px system-ui, sans-serif'
    ctx.fillText(value, x + 24, 812)
    ctx.fillStyle = color('--text-2')
    ctx.font = '22px system-ui, sans-serif'
    ctx.fillText(label, x + 24, 858)
  })

  ctx.fillStyle = color('--text-2')
  ctx.font = '22px system-ui, sans-serif'
  ctx.fillText(
    `留出测试：${outcome.testWindows} 个窗口 · 训练段 R² ${formatMetric(outcome.trainMetrics.r2, 3)} · — 表示不适用`,
    72,
    950
  )
  ctx.fillText(`预测值：${outcome.forecast.map((value) => value.toFixed(1)).join('  /  ')}`, 72, 1000)
  ctx.fillStyle = color('--text-3')
  ctx.font = '19px system-ui, sans-serif'
  ctx.fillText('结果仅用于趋势演示；多步回测与单步指标不可混为一谈。', 72, 1056)

  const blob = await new Promise<Blob | null>((resolve) => report.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('报告图片生成失败')
  downloadBlob(blob, 'AI智囊团-预测报告.png')
  show('预测报告图片已导出', 'success')
}

/**
 * 必须用 flush: 'post'。
 * canvas 在 `v-if="result"` 里，默认的 pre flush 会在 DOM 更新之前执行，
 * 那时 canvas.value 还是 null，第一次训练就只有数字、没有图。
 * post 保证回调在视图更新之后跑，canvas 已经挂载好了。
 */
watch(result, redraw, { flush: 'post' })
watch([theme, visualStyle], redraw, { flush: 'post' })
let chartResizeObserver: ResizeObserver | null = null
watch(
  canvas,
  (element) => {
    chartResizeObserver?.disconnect()
    chartResizeObserver = null
    if (element && typeof ResizeObserver !== 'undefined') {
      chartResizeObserver = new ResizeObserver(redraw)
      chartResizeObserver.observe(element)
    }
  },
  { flush: 'post' }
)
onBeforeUnmount(() => chartResizeObserver?.disconnect())

onMounted(redraw)
</script>

<template>
  <div class="page scroll-y">
    <header class="head safe-x">
      <div>
        <p class="eyebrow">FIND THE NEXT TREND</p>
        <h1 class="title">看见数据的下一步</h1>
        <p class="subtitle">导入连续历史，观察未来 {{ config.horizon || '若干' }} {{ timeUnit }}</p>
      </div>
      <span class="local"><AppIcon name="check" /> 本地计算</span>
    </header>

    <section class="section safe-x">
      <div class="section-heading">
        <div>
          <span class="step">01</span>
          <h2 class="section-title">选择演示场景</h2>
        </div>
        <span class="section-note">60 天历史数据</span>
      </div>
      <div class="scene-grid">
        <button
          v-for="scene in scenes"
          :key="scene.id"
          class="scene-card"
          :class="{ active: activeScene === scene.id }"
          @click="loadScene(scene)"
        >
          <span class="scene-icon">{{ scene.emoji }}</span>
          <strong>{{ scene.title }}</strong>
          <small>{{ scene.caption }}</small>
          <small class="scene-source">{{ scene.source }}</small>
          <span class="scene-action">{{ activeScene === scene.id ? '已选择' : '载入数据' }} →</span>
        </button>
      </div>
    </section>

    <section class="section safe-x">
      <details class="import-panel">
        <summary>
          <span><AppIcon name="database" /> 导入自己的数据</span>
          <small>支持 CSV 或手动输入</small>
        </summary>
        <div class="import-content">
          <textarea
            v-model="input"
            class="data-input"
            rows="5"
            placeholder="粘贴一组数字，逗号、空格或每行一个"
            @input="activeScene = ''"
          />
          <div class="row-actions">
            <input ref="csvInput" hidden type="file" accept=".csv,text/csv" @change="readCsv" />
            <button class="ghost-btn" :disabled="readingCsv" @click="chooseCsv">
              <AppIcon name="database" />{{ readingCsv ? '读取中…' : '选择 CSV' }}
            </button>
            <button class="ghost-btn" @click="fillSample"><AppIcon name="sparkle" />简单示例</button>
            <button class="ghost-btn" @click="clearAll"><AppIcon name="trash" />清空</button>
          </div>
          <p class="hint">已识别 {{ points.length }} 个数据点，建议至少提供 30 个。</p>

          <div v-show="hasCsv" class="csv-card">
            <div class="csv-head">
              <strong class="csv-name">{{ csvName }}</strong>
              <span class="csv-size">{{ csvHeaders.length }} 列</span>
            </div>
            <label v-if="csvHeaders.length > 1" class="csv-picker">
              <span>预测用哪一列</span>
              <select v-model.number="csvColumn" @change="applyCsvColumn">
                <option v-for="(header, index) in csvHeaders" :key="index" :value="index">
                  {{ index + 1 }}. {{ header }}
                </option>
              </select>
            </label>
            <div ref="csvScroller" class="csv-scroller" @scroll="onCsvScroll">
              <table class="csv-table" :style="{ minWidth: `${csvTableWidth}px` }">
                <thead>
                  <tr>
                    <th class="csv-index" :style="{ width: `${CSV_INDEX_WIDTH}px` }">#</th>
                    <th v-for="(header, index) in csvHeaders" :key="index">{{ header }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-if="csvPadTop > 0" class="csv-spacer">
                    <td :colspan="csvHeaders.length + 1" :style="{ height: `${csvPadTop}px` }" />
                  </tr>
                  <tr v-for="(row, index) in csvVisibleRows" :key="csvStart + index">
                    <td class="csv-index">{{ csvStart + index + 1 }}</td>
                    <td v-for="(cell, column) in row" :key="column" :title="cell">{{ cell }}</td>
                  </tr>
                  <tr v-if="csvPadBottom > 0" class="csv-spacer">
                    <td :colspan="csvHeaders.length + 1" :style="{ height: `${csvPadBottom}px` }" />
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="csvTotalRows" class="hint">共 {{ csvTotalRows }} 行 × {{ csvHeaders.length }} 列</p>
          </div>
        </div>
      </details>
    </section>

    <section class="section safe-x">
      <div class="series-meta">
        <label
          ><span>采样周期</span
          ><select v-model="samplingPeriod" aria-label="采样周期">
            <option v-for="(label, key) in SAMPLING_PERIODS" :key="key" :value="key">{{ label }}</option>
          </select></label
        >
        <label
          ><span>数值单位</span
          ><input v-model="valueUnit" maxlength="12" aria-label="数值单位" placeholder="如 元、次、°C"
        /></label>
      </div>
      <p class="hint">数据需按时间先后、等间隔排列。周期未知时按序号预测；周期与日期不会从文件自动推断。</p>
      <div v-if="input.trim()" class="data-check" :class="{ invalid: !validation.canRun }" aria-live="polite">
        <strong>{{ validation.canRun ? `数据检查：${points.length} 个有效点` : '请先修正数据' }}</strong>
        <p v-for="message in validation.errors" :key="message" class="check-error">{{ message }}</p>
        <p v-for="message in validation.warnings" :key="message">{{ message }}</p>
      </div>
      <div class="section-heading">
        <div>
          <span class="step">02</span>
          <h2 class="section-title">预测灵敏度</h2>
        </div>
        <span class="section-note">默认推荐标准</span>
      </div>
      <div class="sensitivity">
        <button
          v-for="(preset, key) in sensitivityPresets"
          :key="key"
          :class="{ active: sensitivity === key }"
          @click="selectSensitivity(key as Sensitivity)"
        >
          <strong>{{ preset.label }}</strong>
          <small>{{ key === 'stable' ? '平滑趋势' : key === 'standard' ? '均衡预测' : '捕捉变化' }}</small>
        </button>
      </div>
      <details class="advanced">
        <summary>高级设置</summary>
        <div class="config-row">
          <label>参考窗口 <input v-model.number="config.window" type="number" min="2" max="12" /> </label>
          <label>预测步数 <input v-model.number="config.horizon" type="number" min="1" max="12" /> </label>
          <label>最大轮数 <input v-model.number="config.epochs" type="number" min="10" max="500" step="10" /> </label>
        </div>
      </details>
    </section>

    <section class="section safe-x">
      <button class="train-btn" :disabled="!canTrain" @click="run">
        <AppIcon name="sliders" />
        {{
          busy
            ? progress >= 95
              ? '正在回测并生成结果…'
              : `AI 模型训练中 ${progress}%`
            : `开始预测未来 ${config.horizon || '若干'} ${timeUnit}`
        }}
      </button>
      <div v-if="busy" class="progress"><span :style="{ width: `${progress}%` }" /></div>
      <button v-if="busy" class="cancel-btn" @click="predict.cancel()"><AppIcon name="stop" />停止本次预测</button>
      <p v-if="!validation.canRun && input.trim()" class="hint">上方检查通过后即可开始预测。</p>
      <p v-if="!validation.canRun && !input.trim() && validation.errors.length" class="hint">
        {{ validation.errors.join(' ') }}
      </p>
      <p v-if="error" class="error">{{ error }}</p>
    </section>

    <section v-if="result" class="section safe-x">
      <div class="section-heading">
        <div>
          <span class="step">03</span>
          <h2 class="section-title">预测结果</h2>
        </div>
        <span class="section-note">未来 {{ result.forecast.length }} {{ timeUnit }}</span>
      </div>
      <div class="card result-card">
        <div class="forecast-hero">
          <span>下一{{ timeUnit }}预测</span>
          <div>
            <strong>{{ formatValue(result.forecast[0]!) }}</strong
            ><small>{{ activeUnit }}</small>
          </div>
          <p>未来 {{ result.forecast.length }} {{ timeUnit }} · {{ SAMPLING_PERIODS[samplingPeriod] }}</p>
        </div>
        <p class="result-context">
          {{ SAMPLING_PERIODS[samplingPeriod] }} · 单位：{{ activeUnit || '未指定' }} ·
          {{ result.method === 'constant' ? '恒定序列保持末值' : '本地神经网络' }}
        </p>
        <canvas ref="canvas" class="chart" height="220" role="img" aria-label="历史数据、模型拟合与未来预测折线图" />
        <p class="legend"><i class="actual" /> 历史数据 <i class="fitted" /> 模型拟合 <i class="predict" /> 未来预测</p>

        <div class="insight">
          <span class="insight-icon"><AppIcon name="sparkle" /></span>
          <div>
            <strong>趋势洞察</strong>
            <p>{{ insight }}</p>
          </div>
        </div>

        <h3 class="forecast-title">未来 {{ result.forecast.length }} {{ timeUnit }}预测</h3>
        <div class="forecast-grid">
          <div v-for="(value, index) in result.forecast" :key="index" class="forecast-day">
            <small>第 {{ index + 1 }} {{ timeUnit }}</small>
            <strong>{{ formatValue(value) }}</strong>
            <span>{{ activeUnit }}</span>
          </div>
        </div>

        <div
          class="backtest"
          :class="{
            caution: !result.backtest || result.backtest.modelMetrics.mae >= result.backtest.baselineMetrics.mae
          }"
        >
          <strong>多步回测 · 与简单基线比较</strong>
          <p>{{ backtestSummary }}</p>
        </div>

        <details class="evaluation">
          <summary>查看误差与模型评估</summary>
          <p class="metrics-caption">回测仅比较历史表现，不保证未来准确；相邻起点的预测目标可能重叠。</p>
          <div class="model-badge">
            {{
              result.method === 'constant'
                ? '恒定序列 · 保持末值 · 无神经网络训练'
                : '64 → 32 → 16 → 1 神经网络 · Dropout · 提前停止'
            }}
          </div>
          <p class="metrics-caption">以下为留出段单步指标，不代表连续 {{ result.forecast.length }} 步的准确度</p>
          <div class="metrics">
            <div>
              <strong>{{ formatMetric(result.metrics.rmse) }}</strong
              ><small>RMSE</small>
            </div>
            <div>
              <strong>{{ formatMetric(result.metrics.mae) }}</strong
              ><small>MAE</small>
            </div>
            <div>
              <strong>{{ formatMetric(result.metrics.mape, 1, '%') }}</strong
              ><small>MAPE</small>
            </div>
            <div>
              <strong>{{ formatMetric(result.metrics.r2, 3) }}</strong
              ><small>R²</small>
            </div>
          </div>
          <p class="metrics-hint">
            实际训练 {{ result.trainedEpochs }} 轮；前 {{ result.splitIndex }} 个点训练，后
            {{ result.actual.length - result.splitIndex }} 个点测试。训练集 R² 为
            {{ formatMetric(result.trainMetrics.r2, 3) }}。— 表示不适用：恒定序列无法计算 R²，零值不参与
            MAPE；这些情况不代表 100% 准确。
          </p>
        </details>

        <div class="export-actions">
          <button class="export-btn primary" @click="exportReportImage"><AppIcon name="share" />导出报告图片</button>
          <button class="export-btn" @click="exportCsv"><AppIcon name="database" />导出 CSV</button>
        </div>
      </div>
    </section>

    <div class="tail" />
  </div>
</template>

<style scoped>
.series-meta {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.series-meta label {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}
.series-meta label > span {
  color: var(--text-2);
  font-size: var(--fs-xs);
}
.series-meta :is(input, select) {
  width: 100%;
  min-width: 0;
  height: 44px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--text-1);
  background: var(--surface-1);
  font: inherit;
  font-size: var(--fs-sm);
}
.data-check {
  padding: 14px 16px;
  margin: 14px 0 22px;
  border: 1px solid var(--border);
  background: var(--surface-1);
  border-radius: var(--r-md);
  font-size: var(--fs-xs);
}
.data-check strong {
  color: var(--success);
  font-weight: 600;
}
.data-check.invalid strong,
.check-error {
  color: var(--danger);
}
.data-check p {
  color: var(--text-2);
  margin: 8px 0 0;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.data-check .check-error {
  color: var(--danger);
}
.result-context {
  color: var(--text-2);
  font-size: var(--fs-xs);
  margin: 0 0 12px;
  overflow-wrap: anywhere;
}
.cancel-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  min-height: 44px;
  margin-top: 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-sm);
}
.error {
  white-space: pre-line;
}
.page {
  height: 100%;
  padding-top: var(--safe-top);
  background: var(--bg);
}
.head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: space-between;
  padding: var(--sp-6) var(--sp-4) var(--sp-5);
}
.eyebrow {
  margin: 0 0 5px;
  color: var(--brand);
  font-size: 0.625rem;
  letter-spacing: 0.18em;
}
.title {
  margin: 0;
  font-size: clamp(1.65rem, 6.5vw, 2.25rem);
  font-weight: 700;
  color: var(--text-1);
}
.subtitle {
  margin: 6px 0 0;
  font-size: var(--fs-sm);
  color: var(--text-2);
}
.local {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  border-radius: var(--r-full);
  font-size: 0.625rem;
  color: var(--success);
  background: rgba(79, 209, 165, 0.14);
}
.section {
  padding-inline: max(var(--sp-4), var(--safe-left)) max(var(--sp-4), var(--safe-right));
  margin-bottom: var(--sp-5);
}
.section-title {
  display: inline;
  margin: 0;
  font-size: var(--fs-md);
  color: var(--text-1);
  letter-spacing: 0;
}
.section-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--sp-3);
  margin-bottom: var(--sp-3);
}
.step {
  margin-right: 7px;
  color: var(--brand);
  font-size: 0.625rem;
  letter-spacing: 0.12em;
}
.section-note {
  color: var(--text-3);
  font-size: var(--fs-xs);
}
.scene-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--sp-2);
}
.scene-card {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 160px;
  padding: var(--sp-3);
  flex-direction: column;
  align-items: flex-start;
  text-align: left;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  color: var(--text-1);
  background: var(--glass);
  box-shadow: var(--tech-shadow);
  transition:
    transform var(--dur) var(--ease),
    border-color var(--dur) var(--ease);
}
.scene-card::after {
  display: none;
}
.scene-card.active {
  border-color: var(--brand);
  background: var(--brand-soft);
}
.scene-icon {
  font-size: 1.55rem;
  margin-bottom: 10px;
}
.scene-card strong {
  font-size: var(--fs-sm);
}
.scene-card small {
  margin-top: 4px;
  color: var(--text-3);
  font-size: 0.75rem;
  line-height: 1.45;
}
.scene-card .scene-source {
  color: var(--text-2);
  font-size: 0.6875rem;
}
.scene-action {
  margin-top: auto;
  color: var(--brand);
  font-size: 0.625rem;
  font-weight: 600;
}

.import-panel,
.advanced,
.evaluation {
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--glass);
}
.import-panel > summary,
.advanced > summary,
.evaluation > summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-4);
  list-style: none;
  cursor: pointer;
}
.import-panel > summary::-webkit-details-marker,
.advanced > summary::-webkit-details-marker,
.evaluation > summary::-webkit-details-marker {
  display: none;
}
.import-panel > summary span {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-sm);
  font-weight: 600;
}
.import-panel > summary small {
  color: var(--text-3);
  font-size: 0.625rem;
}
.import-content {
  padding: 0 var(--sp-3) var(--sp-3);
}
.data-input {
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
.data-input:focus {
  border-color: var(--brand);
}
.row-actions {
  display: flex;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}
.ghost-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px;
  border-radius: var(--r-md);
  font-size: var(--fs-xs);
  color: var(--text-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
}
.ghost-btn:disabled {
  opacity: 0.5;
}
.hint {
  margin: 8px 0 0;
  font-size: var(--fs-xs);
  color: var(--text-3);
}
.csv-card {
  margin-top: var(--sp-3);
  padding: var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--surface-1);
}
.csv-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
}
.csv-name {
  min-width: 0;
  overflow: hidden;
  font-size: var(--fs-sm);
  white-space: nowrap;
  text-overflow: ellipsis;
}
.csv-size {
  flex: none;
  font-size: var(--fs-xs);
  color: var(--text-3);
}
.csv-picker {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
  font-size: var(--fs-xs);
  color: var(--text-2);
}
.csv-picker span {
  flex: none;
}
.csv-picker select {
  flex: 1;
  min-width: 0;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-xs);
}
/*
 * 预览容器高度受控（252px = 7 行 × 36px，正好整行数），并且自己滚。
 * 关键：绝不能让整页来承担这段滚动 —— useVirtualList 读的是这个容器的 scrollTop，
 * 一旦滚动发生在页面上，它读到的永远是 0，可见区间就不会动了。
 */
.csv-scroller {
  height: 252px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-2);
}
.csv-table {
  width: 100%;
  /* separate 而不是 collapse：collapse 下部分浏览器不画 sticky 表头的边框 */
  border-collapse: separate;
  border-spacing: 0;
  table-layout: fixed;
  font-size: var(--fs-xs);
}
.csv-table th,
.csv-table td {
  /* 36px 必须与脚本里的 CSV_ROW_HEIGHT 一致，这是虚拟滚动的换算基准 */
  height: 36px;
  padding: 0 10px;
  line-height: 36px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  text-align: left;
  color: var(--text-2);
}
.csv-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  /* sticky 元素必须有实底，否则下面的行会从表头透上来 */
  background: var(--surface-3);
  color: var(--text-1);
  font-weight: 600;
  box-shadow: inset 0 -1px 0 var(--border-strong);
}
.csv-table td {
  /* 用 box-shadow 画分隔线而不是 border：border 会参与行高，破坏 36px 这个基准 */
  box-shadow: inset 0 -1px 0 var(--border);
}
.csv-index {
  color: var(--text-3);
  text-align: right;
}
/* 上下占位行：高度由内联 style 按 padTop/padBottom 给，这里只负责抹掉自身样式 */
.csv-table .csv-spacer td {
  height: 0;
  padding: 0;
  line-height: 0;
  box-shadow: none;
}
.config-row {
  display: flex;
  gap: var(--sp-2);
}
.sensitivity {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--sp-2);
}
.sensitivity button {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 12px 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  color: var(--text-2);
  background: var(--glass);
}
.sensitivity button.active {
  border-color: var(--brand);
  color: var(--brand-on);
  background: var(--brand-action);
  box-shadow: 0 9px 24px color-mix(in srgb, var(--brand) 25%, transparent);
}
.sensitivity button strong {
  font-size: var(--fs-sm);
}
.sensitivity button small {
  opacity: 0.72;
  font-size: 0.625rem;
}
.advanced {
  margin-top: var(--sp-2);
}
.advanced > summary {
  padding: 11px var(--sp-3);
  color: var(--text-3);
  font-size: var(--fs-xs);
}
.advanced .config-row {
  padding: 0 var(--sp-3) var(--sp-3);
}
.config-row label {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: var(--fs-xs);
  color: var(--text-2);
}
.config-row input {
  width: 100%;
  padding: 9px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-sm);
}
.train-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: 15px;
  border-radius: var(--r-lg);
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--brand-on);
  background: var(--brand-action);
  box-shadow: 0 12px 30px color-mix(in srgb, var(--brand) 28%, transparent);
}
.train-btn:disabled {
  opacity: 0.45;
}
.progress {
  height: 6px;
  margin-top: var(--sp-2);
  overflow: hidden;
  border-radius: var(--r-full);
  background: var(--surface-2);
}
.progress span {
  display: block;
  height: 100%;
  background: var(--brand-action);
  transition: width 0.15s linear;
}
.error {
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-xs);
  color: var(--danger);
}
.card {
  padding: var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--glass);
  backdrop-filter: blur(18px);
}
.chart {
  width: 100%;
  height: 220px;
  display: block;
}
.metrics {
  display: flex;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
}
/* 指标口径必须写在数字正上方：这组是测试集指标，不是训练集拟合 */
.metrics-caption {
  margin: var(--sp-4) 0 0;
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--brand);
}
.metrics-hint {
  margin: var(--sp-2) 0 0;
  font-size: 0.625rem;
  line-height: 1.7;
  color: var(--text-3);
}
.metrics > div {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--sp-2);
  border-radius: var(--r-sm);
  background: var(--surface-2);
}
.metrics strong {
  overflow-wrap: anywhere;
  font-size: var(--fs-md);
}
.metrics small {
  font-size: 0.625rem;
  color: var(--text-3);
}
.forecast-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: var(--sp-3);
}
.insight {
  display: flex;
  gap: var(--sp-3);
  margin-top: var(--sp-4);
  padding: var(--sp-3);
  border: 1px solid color-mix(in srgb, var(--brand) 30%, var(--border));
  border-radius: var(--r-md);
  background: linear-gradient(135deg, color-mix(in srgb, var(--brand) 12%, transparent), transparent);
}
.insight-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: 12px;
  color: var(--brand-on);
  background: var(--brand-action);
}
.insight strong {
  font-size: var(--fs-sm);
}
.insight p {
  margin: 5px 0 0;
  color: var(--text-2);
  font-size: var(--fs-xs);
  line-height: 1.65;
}
.backtest {
  margin-top: var(--sp-3);
  padding: var(--sp-3);
  border: 1px solid color-mix(in srgb, var(--brand) 32%, var(--border));
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--brand) 7%, var(--surface-1));
}
.backtest.caution {
  border-color: color-mix(in srgb, var(--warning) 42%, var(--border));
  background: color-mix(in srgb, var(--warning) 7%, var(--surface-1));
}
.backtest strong {
  font-size: var(--fs-xs);
}
.backtest p {
  margin: 6px 0 0;
  color: var(--text-2);
  font-size: var(--fs-xs);
  line-height: 1.6;
}
.backtest small {
  display: block;
  margin-top: 6px;
  color: var(--text-3);
  line-height: 1.5;
}
.forecast-title {
  margin: var(--sp-4) 0 var(--sp-2);
  font-size: var(--fs-sm);
}
.forecast-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}
.forecast-day {
  display: flex;
  min-width: 0;
  padding: 9px 5px;
  flex-direction: column;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-2);
}
.forecast-day small {
  color: var(--text-3);
  font-size: 0.5625rem;
}
.forecast-day strong {
  max-width: 100%;
  overflow-wrap: anywhere;
  margin-top: 3px;
  color: var(--warning);
  font-size: var(--fs-md);
}
.forecast-day span {
  max-width: 100%;
  overflow-wrap: anywhere;
  color: var(--text-3);
  font-size: 0.5625rem;
}
.evaluation {
  margin-top: var(--sp-4);
  background: var(--surface-1);
}
.evaluation > summary {
  padding: 12px var(--sp-3);
  color: var(--text-2);
  font-size: var(--fs-xs);
}
.evaluation[open] {
  padding-bottom: var(--sp-3);
}
.model-badge {
  margin: 0 var(--sp-3);
  padding: 8px 10px;
  border-radius: var(--r-sm);
  color: var(--brand);
  background: var(--brand-soft);
  font-size: 0.625rem;
}
.evaluation .metrics,
.evaluation .metrics-hint {
  margin-inline: var(--sp-3);
}
.forecast-chip {
  padding: 5px 10px;
  border-radius: var(--r-full);
  font-size: var(--fs-xs);
  color: var(--warning);
  background: rgba(255, 196, 107, 0.14);
}
.legend {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: var(--sp-3) 0 0;
  font-size: 0.625rem;
  color: var(--text-3);
}
.legend i {
  display: inline-block;
  width: 16px;
  height: 0;
  border-top: 2px solid;
}
.legend .actual {
  border-color: var(--chart-history);
}
.legend .fitted {
  border-color: var(--chart-fitted);
  border-style: dashed;
}
.legend .predict {
  border-color: var(--chart-forecast);
  border-style: dashed;
}
.export-actions {
  display: grid;
  grid-template-columns: 1.25fr 1fr;
  gap: var(--sp-2);
  margin-top: var(--sp-4);
}
.export-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  color: var(--text-2);
  background: var(--surface-2);
  font-size: var(--fs-xs);
  font-weight: 600;
}
.export-btn.primary {
  color: var(--brand-on);
  border-color: transparent;
  background: var(--brand-action);
  box-shadow: 0 10px 24px rgba(91, 124, 250, 0.22);
}
.tail {
  height: var(--sp-6);
}
@media (max-width: 360px) {
  .scene-grid {
    grid-template-columns: 1fr;
  }
  .scene-card {
    min-height: 110px;
  }
  .forecast-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

.forecast-hero {
  padding: 20px;
  margin-bottom: 18px;
  border-radius: var(--r-lg);
  border: 1px solid var(--border);
  background: linear-gradient(130deg, var(--brand-soft), var(--surface-1));
}
.forecast-hero > span {
  color: var(--text-2);
  font-size: var(--fs-xs);
}
.forecast-hero > div {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.forecast-hero strong {
  font-size: clamp(30px, 9vw, 42px);
  line-height: 1.2;
  color: var(--brand);
  letter-spacing: -0.03em;
  overflow-wrap: anywhere;
  max-width: 100%;
}
.forecast-hero small {
  color: var(--text-2);
}
.forecast-hero p {
  margin: 10px 0 0;
  color: var(--text-3);
  font-size: var(--fs-xs);
}
.forecast-grid {
  margin-bottom: 18px;
}
.forecast-day {
  min-width: 0;
}
.forecast-day strong {
  overflow-wrap: anywhere;
}
.backtest {
  font-size: var(--fs-xs);
}
.scene-card {
  min-height: 140px;
}
</style>
