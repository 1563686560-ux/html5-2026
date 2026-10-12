/** 预测训练 Web Worker：把 tfjs 训练挪出主线程，避免卡 UI */
import { trainForecastCore, type ForecastConfig } from './train'

interface WorkerRequest {
  id: number
  series: number[]
  config: ForecastConfig
}

type WorkerScope = {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage: (message: unknown) => void
}

const scope = globalThis as unknown as WorkerScope

scope.onmessage = async (event: MessageEvent) => {
  const { id, series, config } = event.data as WorkerRequest
  try {
    const result = await trainForecastCore(series, {
      ...config,
      onProgress: (epoch, total) => scope.postMessage({ id, type: 'progress', epoch, total })
    })
    scope.postMessage({ id, type: 'done', result })
  } catch (error) {
    scope.postMessage({ id, type: 'error', message: (error as Error).message })
  }
}
