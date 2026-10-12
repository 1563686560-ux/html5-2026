import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { RegressionMetrics } from '@/ml/metrics'
import type { RollingBacktest } from '@/ml/backtest'
import { trainForecast } from '@/ml/timeseries'
import { validateForecastInput } from '@/ml/validation'
import type { SamplingPeriod } from '@/ml/presentation'

export interface ForecastOutcome {
  method: 'neural' | 'constant'
  loss: number
  trainedEpochs: number
  validationLoss: number | null
  forecast: number[]
  fitted: number[]
  actual: number[]
  /** 留出的测试集指标。 */
  metrics: RegressionMetrics
  trainMetrics: RegressionMetrics
  splitIndex: number
  trainWindows: number
  testWindows: number
  backtest: RollingBacktest | null
}

export type Sensitivity = 'stable' | 'standard' | 'sensitive'

/** 仅保留在当前应用会话中；切换页面不丢失，重启后仍从空白开始。 */
export const usePredictStore = defineStore('predict', () => {
  const input = ref('')
  const config = ref({ window: 7, horizon: 7, epochs: 160 })
  const sensitivity = ref<Sensitivity>('standard')
  const activeScene = ref('')
  const samplingPeriod = ref<SamplingPeriod>('step')
  const valueUnit = ref('')
  const busy = ref(false)
  const progress = ref(0)
  const error = ref<string | null>(null)
  const result = ref<ForecastOutcome | null>(null)
  const csvName = ref('')
  const csvHeaders = ref<string[]>([])
  const csvRows = ref<string[][]>([])
  const csvColumn = ref(0)

  const validation = computed(() => validateForecastInput(input.value, config.value))
  const points = computed(() => validation.value.values)
  let runId = 0
  let controller: AbortController | null = null
  function cancel(): void {
    runId++
    controller?.abort()
    controller = null
    busy.value = false
    progress.value = 0
    error.value = '已停止预测，数据仍保留，可以调整后重新开始。'
  }

  // 手动修改数字或高级参数后，旧结果不再代表当前配置。
  watch(
    [
      input,
      activeScene,
      samplingPeriod,
      valueUnit,
      () => config.value.window,
      () => config.value.horizon,
      () => config.value.epochs
    ],
    () => {
      runId++
      if (busy.value) cancel()
      result.value = null
      error.value = null
    },
    { flush: 'sync' }
  )

  async function run(): Promise<void> {
    if (busy.value) return
    const actual = [...points.value]
    if (!validation.value.canRun) {
      result.value = null
      error.value = validation.value.errors.join('\n')
      return
    }
    const source = input.value
    const scene = activeScene.value
    const options = { ...config.value }
    const jobId = ++runId
    const jobController = new AbortController()
    controller = jobController
    const isCurrent = () =>
      jobId === runId &&
      input.value === source &&
      activeScene.value === scene &&
      config.value.window === options.window &&
      config.value.horizon === options.horizon &&
      config.value.epochs === options.epochs

    busy.value = true
    error.value = null
    result.value = null
    progress.value = 0
    try {
      const outcome = await trainForecast(
        actual,
        {
          window: options.window,
          horizon: options.horizon,
          epochs: options.epochs,
          onProgress: (epoch, total) => {
            if (isCurrent()) progress.value = Math.min(95, Math.round((epoch / total) * 95))
          }
        },
        { signal: jobController.signal }
      )
      if (!isCurrent()) return
      if (
        outcome.forecast.length !== options.horizon ||
        outcome.forecast.some((value) => !Number.isFinite(value)) ||
        outcome.fitted.some((value) => !Number.isFinite(value))
      ) {
        throw new Error('模型返回的预测长度或数值无效，请调整数据后重试。')
      }
      result.value = {
        method: outcome.method ?? 'neural',
        loss: outcome.finalLoss,
        trainedEpochs: outcome.trainedEpochs,
        validationLoss: outcome.validationLoss,
        forecast: outcome.forecast,
        fitted: outcome.fitted,
        actual,
        metrics: outcome.metrics,
        trainMetrics: outcome.trainMetrics,
        splitIndex: outcome.splitIndex,
        trainWindows: outcome.trainWindows,
        testWindows: outcome.testWindows,
        backtest: outcome.backtest
      }
      progress.value = 100
    } catch (cause) {
      if (isCurrent()) error.value = (cause as Error).message
    } finally {
      if (isCurrent()) {
        busy.value = false
        controller = null
      }
    }
  }

  return {
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
    valueUnit,
    run,
    cancel
  }
})
