import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const themeKey = 'ai-brain-trust:theme'
const styleKey = 'ai-brain-trust:visual-style'
let storage: Map<string, string>
let dataset: Record<string, string>
let setMeta: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetModules()
  storage = new Map()
  dataset = {}
  setMeta = vi.fn()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value)
  })
  vi.stubGlobal('document', {
    createElement: () => ({}),
    documentElement: { dataset },
    querySelector: () => ({ setAttribute: setMeta })
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('手机端完整主题', () => {
  it.each(['aurora', 'cream', 'emerald'] as const)('新增主题 %s 保存后能完整恢复', async (style) => {
    const module = await import('./useTheme')
    const selected = module.VISUAL_THEMES.find((item) => item.id === style)!
    module.useTheme().setVisualStyle(style)
    expect(dataset).toEqual({ theme: selected.mode, style })
    expect(setMeta).toHaveBeenCalledWith('content', selected.background)
    vi.resetModules()
    const restored = await import('./useTheme')
    restored.initTheme()
    expect(restored.useTheme().visualStyle.value).toBe(style)
    expect(dataset).toEqual({ theme: selected.mode, style })
  })
  it.each(['aurora', 'cream', 'emerald'] as const)('新增主题 %s 保存后能完整恢复', async (style) => {
    const module = await import('./useTheme')
    const selected = module.VISUAL_THEMES.find((item) => item.id === style)!
    module.useTheme().setVisualStyle(style)
    expect(dataset).toEqual({ theme: selected.mode, style })
    expect(setMeta).toHaveBeenCalledWith('content', selected.background)
    vi.resetModules()
    const restored = await import('./useTheme')
    restored.initTheme()
    expect(restored.useTheme().visualStyle.value).toBe(style)
    expect(dataset).toEqual({ theme: selected.mode, style })
  })
  it('首次使用默认深蓝科技，并同步状态栏颜色', async () => {
    const { useTheme, initTheme } = await import('./useTheme')
    initTheme()
    expect(useTheme().theme.value).toBe('dark')
    expect(dataset).toEqual({ theme: 'dark', style: 'technology' })
    expect(setMeta).toHaveBeenCalledWith('content', '#081326')
  })
  it('完整主题切换后重新加载仍保持选择', async () => {
    const { useTheme } = await import('./useTheme')
    useTheme().setVisualStyle('professional')
    expect(storage.get(themeKey)).toBe('light')
    expect(storage.get(styleKey)).toBe('professional')
    expect(setMeta).toHaveBeenCalledWith('content', '#f5f6fb')
    vi.resetModules()
    const restored = await import('./useTheme')
    restored.initTheme()
    expect(dataset).toEqual({ theme: 'light', style: 'professional' })
    restored.useTheme().toggleTheme()
    expect(dataset).toEqual({ theme: 'dark', style: 'technology' })
  })
  it('旧版温暖风格按已保存的明暗偏好迁移', async () => {
    storage.set(styleKey, 'warm')
    storage.set(themeKey, 'light')
    const { useTheme, initTheme } = await import('./useTheme')
    initTheme()
    expect(useTheme().visualStyle.value).toBe('professional')
    expect(dataset.theme).toBe('light')
  })
  it('浏览器存储不可用时仍可切换主题', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('unavailable')
      },
      setItem: () => {
        throw new Error('unavailable')
      }
    })
    const { useTheme, initTheme } = await import('./useTheme')
    expect(() => initTheme()).not.toThrow()
    expect(() => useTheme().setVisualStyle('professional')).not.toThrow()
    expect(dataset).toEqual({ theme: 'light', style: 'professional' })
  })
})
