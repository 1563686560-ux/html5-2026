/**
 * P4 预测对外 API：默认走 Web Worker，Worker 不可用时退回主线程。
 * 纯工具函数（parseSeries / sampleSeries）在 series.ts。
 */
import { parseSeries, sampleSeries } from './series'
import type { ForecastConfig, ForecastResult } from './train'
import ForecastWorker from './forecast.worker?worker'

export { parseSeries, sampleSeries }
export type { ForecastConfig, ForecastResult }

interface WorkerReply {
  id: number
  type: 'progress' | 'done' | 'error'
  epoch?: number
  total?: number
  result?: ForecastResult
  message?: string
}

export interface ForecastRunOptions {
  signal?: AbortSignal
  timeoutMs?: number
}
function trainForecastInWorker(
  series: number[],
  config: ForecastConfig,
  options: ForecastRunOptions
): Promise<ForecastResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('预测已停止'))
      return
    }
    const worker = new ForecastWorker()
    const id = Math.floor(Math.random() * 1e9)
    let settled = false
    const cleanup = () => {
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
    }
    const fail = (message: string) => {
      if (!settled) {
        cleanup()
        reject(new Error(message))
      }
    }
    const abort = () => fail('预测已停止')
    const timer = setTimeout(() => fail('预测超过等待时间，请减少数据量或训练轮数后重试。'), options.timeoutMs ?? 90000)
    options.signal?.addEventListener('abort', abort, { once: true })

    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      if (settled) return
      const message = event.data
      if (message.id !== id) return
      if (message.type === 'progress') {
        if (typeof message.epoch === 'number' && typeof message.total === 'number') {
          config.onProgress?.(message.epoch, message.total)
        }
      } else if (message.type === 'done') {
        cleanup()
        if (message.result) resolve(message.result)
        else reject(new Error('Worker 未返回结果'))
      } else if (message.type === 'error') {
        fail(message.message ?? '训练失败')
      }
    }

    worker.onerror = (error) => {
      fail(error.message || 'Worker 运行错误')
    }

    // onProgress 是函数，无法结构化克隆，剥离后再传给 Worker
    const { onProgress: _ignored, signal: _signal, ...rest } = config
    void _ignored
    void _signal
    try {
      worker.postMessage({ id, series, config: rest })
    } catch (error) {
      fail((error as Error).message || '无法启动预测，请重试')
    }
  })
}

export async function trainForecast(
  series: number[],
  config: ForecastConfig = {},
  options: ForecastRunOptions = {}
): Promise<ForecastResult> {
  if (options.signal?.aborted) throw new Error('预测已停止')
  if (typeof Worker === 'undefined') {
    // 仅当 Worker 不可用时才动态加载主线程训练（含 tfjs），避免正常路径加载两份 tfjs
    const { trainForecastCore } = await import('./train')
    if (options.signal?.aborted) throw new Error('预测已停止')
    const controller = new AbortController()
    let expired = false
    const abort = () => controller.abort()
    const timer = setTimeout(() => {
      expired = true
      abort()
    }, options.timeoutMs ?? 90000)
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      return await trainForecastCore(series, { ...config, signal: controller.signal })
    } catch (error) {
      if (expired) throw new Error('预测超过等待时间，请减少数据量或训练轮数后重试。', { cause: error })
      throw error
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
  }
  return trainForecastInWorker(series, config, options)
}
