/**
 * 预测训练核心：主线程与 Web Worker 共用。
 * 强制 CPU 后端 —— 模型极小，CPU 足够快，且能保证在 Worker 内可用。
 */
import * as tf from '@tensorflow/tfjs'
import { rollingBacktest, type RollingBacktest } from './backtest'
import { computeMetrics, type RegressionMetrics } from './metrics'

export interface ForecastConfig {
  /** 主线程回退路径支持协作式停止；Worker 路径直接终止工作线程。 */
  signal?: AbortSignal
  window?: number
  horizon?: number
  epochs?: number
  batchSize?: number
  hidden?: number
  /** 测试集（留出集）占整条序列的比例，默认 0.2 */
  testRatio?: number
  onProgress?: (epoch: number, total: number) => void
}

export interface ForecastResult {
  method?: 'neural' | 'constant'
  finalLoss: number
  /** 早停后的实际训练轮数 */
  trainedEpochs: number
  /** 最后一轮验证集损失；样本过少无法切验证集时为空 */
  validationLoss: number | null
  forecast: number[]
  min: number
  max: number
  scaled: number[]
  fitted: number[]
  /** **测试集（留出集）**指标 —— 界面展示的就是这一组 */
  metrics: RegressionMetrics
  /** 训练集内拟合指标。放在一起是为了能看出训练/测试的落差（落差大即过拟合） */
  trainMetrics: RegressionMetrics
  /** 切分点：测试集从原始序列的该下标开始 */
  splitIndex: number
  /** 参与训练的窗口数（不是点数） */
  trainWindows: number
  /** 参与评估的窗口数 */
  testWindows: number
  /** 与正式预测相同的递推方式，在留出段上比较神经网络和末值基线。 */
  backtest: RollingBacktest | null
}

/**
 * 按时间顺序切分训练集与测试集。
 * 时间序列**不能打乱**：测试集必须取**最后一段**，
 * 否则就是拿「未来」去评估「过去」，指标会虚高到没有意义。
 *
 * 单独抽成纯函数是为了能直接测边界（极小序列、比例越界等）。
 */
export function splitSeries(totalPoints: number, testRatio = 0.2): { splitIndex: number; testSize: number } {
  const ratio = Number.isFinite(testRatio) ? Math.min(Math.max(testRatio, 0.05), 0.5) : 0.2
  // 至少留 1 个测试点，同时保证训练段不为空
  const testSize = Math.max(1, Math.min(Math.round(totalPoints * ratio), totalPoints - 1))
  return { splitIndex: totalPoints - testSize, testSize }
}

function minMaxScale(values: number[]): { min: number; max: number; scaled: number[] } {
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  return { min, max, scaled: values.map((value) => (value - min) / span) }
}

function deNormalize(value: number, min: number, max: number): number {
  return value * (max - min || 1) + min
}

function buildWindows(series: number[], window: number): { xs: number[][]; ys: number[] } {
  const xs: number[][] = []
  const ys: number[] = []
  for (let i = window; i < series.length; i++) {
    xs.push(series.slice(i - window, i))
    ys.push(series[i])
  }
  return { xs, ys }
}

function rollForecast(model: tf.LayersModel, scaled: number[], window: number, horizon: number): number[] {
  const result: number[] = []
  let buffer = scaled.slice(-window)
  for (let i = 0; i < horizon; i++) {
    const value = tf.tidy(() => {
      const input = tf.tensor2d([buffer], [1, window])
      return (model.predict(input) as tf.Tensor).dataSync()[0]
    })
    result.push(value)
    buffer = [...buffer.slice(1), value]
  }
  return result
}

/**
 * 把配置项规整成合法整数。
 * 界面用的是 <input type="number">，用户清空后会得到空字符串，
 * 直接参与运算会变成 `7 < "3"` 这种字符串比较（结果不可预期），
 * epochs 变成 '' 也会让训练静默跑 0 轮。这里统一兜住：
 * 空值走默认，越界夹到边界，非数字走默认。
 */
function toInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value === null || value === undefined || value === '') return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(Math.round(parsed), min), max)
}

export async function trainForecastCore(series: number[], config: ForecastConfig = {}): Promise<ForecastResult> {
  const checkStopped = () => {
    if (config.signal?.aborted) throw new Error('预测已停止')
  }
  checkStopped()
  if (series.some((value) => !Number.isFinite(value))) throw new Error('数据包含无效数值，请修正后再预测')
  const window = toInt(config.window, 4, 2, 60)
  const horizon = toInt(config.horizon, 4, 1, 30)
  const epochs = toInt(config.epochs, 80, 1, 2000)
  const batchSize = toInt(config.batchSize, 8, 1, 256)
  const hidden = toInt(config.hidden, 64, 8, 512)
  const { onProgress } = config

  if (series.length < window + 3) {
    throw new Error(`至少需要 ${window + 3} 个数据点，当前只有 ${series.length} 个`)
  }

  // 先切分，再决定怎么缩放：训练段与测试段从这一刻起必须严格分开
  const { splitIndex } = splitSeries(series.length, config.testRatio)
  const trainWindows = Math.min(splitIndex - window, series.length - window - 1)
  const testWindows = series.length - window - trainWindows
  if (trainWindows < 1 || testWindows < 1) {
    throw new Error(`数据点太少，无法切出训练集与测试集：至少需要 ${window + 3} 个，当前只有 ${series.length} 个`)
  }

  if (series.every((value) => value === series[0])) {
    const value = series[0]
    const fitted = series.slice(window)
    const metrics = computeMetrics(series.slice(splitIndex), series.slice(splitIndex))
    return {
      method: 'constant',
      finalLoss: 0,
      trainedEpochs: 0,
      validationLoss: null,
      forecast: Array.from({ length: horizon }, () => value),
      fitted,
      min: value,
      max: value,
      scaled: series.map(() => 0),
      metrics,
      trainMetrics: metrics,
      splitIndex,
      trainWindows,
      testWindows,
      backtest: rollingBacktest(series, splitIndex, horizon, (_, steps) => Array.from({ length: steps }, () => value))
    }
  }

  try {
    await tf.setBackend('cpu')
  } catch {
    /* 保留默认后端 */
  }
  await tf.ready()

  /*
   * 只用**训练段**估算 min/max。
   * 如果把测试段也算进来，缩放器就「见过」测试数据 —— 这是数据泄漏，
   * 指标会虚高；而真实使用中根本拿不到未来数据，等于自欺。
   * 整条序列仍用这一组 min/max 缩放，所以测试段的取值可能落在 [0,1] 之外，
   * 这正是它应有的样子。
   */
  const { min, max } = minMaxScale(series.slice(0, splitIndex))
  const span = max - min || 1
  const scaled = series.map((value) => (value - min) / span)
  const { xs, ys } = buildWindows(scaled, window)

  // 只把训练段窗口喂给模型；测试段窗口留到最后单独评估
  const trainXs = xs.slice(0, trainWindows)
  const trainYs = ys.slice(0, trainWindows)

  const xsTensor = tf.tensor2d(trainXs, [trainXs.length, window])
  const ysTensor = tf.tensor2d(trainYs, [trainYs.length, 1])

  const model = tf.sequential()
  model.add(
    tf.layers.dense({
      units: hidden,
      activation: 'relu',
      inputShape: [window],
      kernelInitializer: tf.initializers.glorotUniform({ seed: 202606 })
    })
  )
  model.add(tf.layers.dropout({ rate: 0.2, seed: 202607 }))
  model.add(
    tf.layers.dense({
      units: 32,
      activation: 'relu',
      kernelInitializer: tf.initializers.glorotUniform({ seed: 202608 })
    })
  )
  model.add(tf.layers.dropout({ rate: 0.1, seed: 202609 }))
  model.add(
    tf.layers.dense({
      units: 16,
      activation: 'relu',
      kernelInitializer: tf.initializers.glorotUniform({ seed: 202610 })
    })
  )
  model.add(tf.layers.dense({ units: 1, kernelInitializer: tf.initializers.glorotUniform({ seed: 202611 }) }))
  model.compile({ optimizer: 'adam', loss: 'meanSquaredError' })

  try {
    const useValidation = trainXs.length >= 10
    const monitorKey = useValidation ? 'val_loss' : 'loss'
    let bestMonitoredLoss = Number.POSITIVE_INFINITY
    let staleEpochs = 0
    const history = await model.fit(xsTensor, ysTensor, {
      epochs,
      batchSize,
      shuffle: false,
      validationSplit: useValidation ? 0.15 : 0,
      verbose: 0,
      callbacks: {
        onEpochEnd: (epoch: number, logs?: tf.Logs) => {
          checkStopped()
          onProgress?.(epoch + 1, epochs)
          const monitoredLoss = logs?.[monitorKey]
          if (typeof monitoredLoss !== 'number') return
          if (monitoredLoss < bestMonitoredLoss - 0.00001) {
            bestMonitoredLoss = monitoredLoss
            staleEpochs = 0
          } else {
            staleEpochs += 1
            if (staleEpochs >= 15) model.stopTraining = true
          }
        }
      }
    })
    const losses = history.history.loss as number[]
    const finalLoss = losses[losses.length - 1] ?? Number.NaN
    const validationLosses = history.history.val_loss as number[] | undefined
    const validationLoss = validationLosses?.[validationLosses.length - 1]

    const fittedScaled = xs.map((slice) =>
      tf.tidy(() => (model.predict(tf.tensor2d([slice], [1, window])) as tf.Tensor).dataSync()[0])
    )
    const fitted = fittedScaled.map((value) => deNormalize(value, min, max))
    /*
     * 评估分开算：
     *   metrics      —— **测试集**窗口（模型训练时从未见过它们的标签），这才是能对外说的数字；
     *   trainMetrics —— 训练集窗口内的拟合，用来看两者的落差。
     * fitted 覆盖全部窗口，所以图上测试段那条「拟合」线实际上就是样本外预测。
     */
    const fittedTrain = fitted.slice(0, trainWindows)
    const fittedTest = fitted.slice(trainWindows)
    const trainMetrics = computeMetrics(series.slice(window, window + trainWindows), fittedTrain)
    const metrics = computeMetrics(series.slice(window + trainWindows), fittedTest)

    // 留出段内每个完整起点预测 horizon 步。模型尚未用留出段微调，
    // 但较晚起点允许使用该时刻已观测到的历史值作为输入。
    const backtest = rollingBacktest(series, splitIndex, horizon, (known, steps) =>
      rollForecast(
        model,
        known.map((value) => (value - min) / span),
        window,
        steps
      ).map((value) => deNormalize(value, min, max))
    )

    /*
     * 指标必须来自上面的留出测试集，不能回头改写；但正式预测未来时，最后一段
     * 已经是已知历史，理应参与模型拟合。因此在评估完成后，用全部窗口短暂微调，
     * 再生成未来值。这是“无泄漏评估 + 全历史正式预测”的两阶段流程。
     */
    const allXsTensor = tf.tensor2d(xs, [xs.length, window])
    const allYsTensor = tf.tensor2d(ys, [ys.length, 1])
    try {
      checkStopped()
      await model.fit(allXsTensor, allYsTensor, {
        epochs: Math.max(12, Math.min(40, Math.round(losses.length * 0.25))),
        batchSize,
        shuffle: false,
        verbose: 0,
        callbacks: { onEpochEnd: checkStopped }
      })
    } finally {
      allXsTensor.dispose()
      allYsTensor.dispose()
    }
    const forecast = rollForecast(model, scaled, window, horizon).map((value) => deNormalize(value, min, max))
    if (
      !Number.isFinite(finalLoss) ||
      forecast.some((value) => !Number.isFinite(value)) ||
      fitted.some((value) => !Number.isFinite(value))
    ) {
      throw new Error('模型未生成有效结果，请核对极端值、减少训练轮数或更换数据后重试')
    }

    return {
      method: 'neural',
      finalLoss,
      trainedEpochs: losses.length,
      validationLoss: typeof validationLoss === 'number' && Number.isFinite(validationLoss) ? validationLoss : null,
      forecast,
      min,
      max,
      scaled,
      fitted,
      metrics,
      trainMetrics,
      splitIndex,
      trainWindows,
      testWindows,
      backtest
    }
  } finally {
    xsTensor.dispose()
    ysTensor.dispose()
    model.dispose()
  }
}
