/**
 * 轻量提示（Toast）
 * ------------------------------------------------------------------
 * 模块级单例：任何组件调用 useToast().show() 都会推到同一个列表，
 * 由挂载在 App 根部的 ToastHost 统一渲染。
 */
import { ref } from 'vue'

export type ToastTone = 'info' | 'success' | 'error'

export interface ToastItem {
  id: number
  text: string
  tone: ToastTone
}

const items = ref<ToastItem[]>([])
let seq = 0

export function useToast() {
  function show(text: string, tone: ToastTone = 'info', duration = 2200): void {
    const id = ++seq
    items.value = [...items.value, { id, text, tone }]
    window.setTimeout(() => {
      items.value = items.value.filter((t) => t.id !== id)
    }, duration)
  }

  return { items, show }
}
