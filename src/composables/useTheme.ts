/**
 * 主题切换
 * ------------------------------------------------------------------
 * 为什么不把主题也放 IndexedDB？
 *   IndexedDB 是异步的，等它读完再应用主题会出现「先暗后亮」的闪烁。
 *   主题是极小的非敏感数据，放 localStorage 可以同步读取、首帧即生效。
 *   而 API Key 等设置放 IndexedDB，避免同步阻塞。
 */
import { ref } from 'vue'
import { Capacitor, registerPlugin, SystemBars, SystemBarsStyle } from '@capacitor/core'

const themeBars = registerPlugin<{ apply(options: { background: string; light: boolean }): Promise<void> }>('ThemeBars')
let nativeThemeUpdate = Promise.resolve()

export type ThemeMode = 'dark' | 'light'
export type VisualStyle = 'technology' | 'professional' | 'aurora' | 'cream' | 'emerald'
export const VISUAL_THEMES: { id: VisualStyle; name: string; mode: ThemeMode; background: string; accent: string }[] = [
  { id: 'technology', name: '深蓝科技', mode: 'dark', background: '#081326', accent: '#65e3df' },
  { id: 'professional', name: '明亮专业', mode: 'light', background: '#f5f6fb', accent: '#5264d9' },
  { id: 'aurora', name: '极光紫', mode: 'dark', background: '#181126', accent: '#d3b0ff' },
  { id: 'cream', name: '奶油橙', mode: 'light', background: '#fff8ef', accent: '#a74713' },
  { id: 'emerald', name: '翡翠绿', mode: 'light', background: '#f2f8f5', accent: '#197655' }
]

const STORAGE_KEY = 'ai-brain-trust:theme'
const STYLE_KEY = 'ai-brain-trust:visual-style'

function readInitialTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'dark' || saved === 'light') return saved
  } catch {
    /* 隐私模式下 localStorage 可能不可用 */
  }
  return 'dark'
}

const theme = ref<ThemeMode>(readInitialTheme())
function readInitialStyle(): VisualStyle {
  try {
    const saved = localStorage.getItem(STYLE_KEY)
    if (VISUAL_THEMES.some((item) => item.id === saved)) return saved as VisualStyle
  } catch {
    /* Local storage may be unavailable. */
  }
  return theme.value === 'dark' ? 'technology' : 'professional'
}
const visualStyle = ref<VisualStyle>(readInitialStyle())
// 完整主题绑定明暗和风格，并兼容旧版保存的明暗偏好。
theme.value = VISUAL_THEMES.find((item) => item.id === visualStyle.value)!.mode

function apply(mode: ThemeMode): void {
  document.documentElement.dataset.theme = mode
  document.documentElement.dataset.style = visualStyle.value
  // 更新浏览器地址栏 / 状态栏配色
  const color = VISUAL_THEMES.find((item) => item.id === visualStyle.value)!.background
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color)
  if (Capacitor.getPlatform() === 'android') {
    // Serialize changes so rapid theme taps cannot leave stale system bar colors.
    nativeThemeUpdate = nativeThemeUpdate
      .then(async () => {
        await SystemBars.setStyle({ style: mode === 'light' ? SystemBarsStyle.Light : SystemBarsStyle.Dark })
        await themeBars.apply({ background: color, light: mode === 'light' })
      })
      .catch((error) => console.warn('系统栏主题更新失败', error))
  }
}

export function useTheme() {
  function setTheme(mode: ThemeMode): void {
    theme.value = mode
    visualStyle.value = mode === 'dark' ? 'technology' : 'professional'
    apply(mode)
    try {
      localStorage.setItem(STORAGE_KEY, mode)
      localStorage.setItem(STYLE_KEY, visualStyle.value)
    } catch {
      /* 忽略写入失败 */
    }
  }

  function toggleTheme(): void {
    setTheme(theme.value === 'dark' ? 'light' : 'dark')
  }

  function setVisualStyle(style: VisualStyle): void {
    const selected = VISUAL_THEMES.find((item) => item.id === style)
    if (!selected) return
    visualStyle.value = selected.id
    theme.value = selected.mode
    apply(selected.mode)
    try {
      localStorage.setItem(STORAGE_KEY, selected.mode)
      localStorage.setItem(STYLE_KEY, selected.id)
    } catch {
      /* 存储不可用仍即时应用 */
    }
  }

  return { theme, visualStyle, setTheme, toggleTheme, setVisualStyle, apply }
}

/** 应用启动时调用一次，把主题写到 html 上 */
export function initTheme(): void {
  apply(theme.value)
}
