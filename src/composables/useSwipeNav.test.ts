import { describe, expect, it } from 'vitest'
import { SWIPE_MIN_PX, resolveSwipe } from './useSwipeNav'

describe('resolveSwipe 滑动方向判定', () => {
  it('明确的左滑 → next，右滑 → prev', () => {
    expect(resolveSwipe(-120, 4)).toBe('next')
    expect(resolveSwipe(120, 4)).toBe('prev')
  })

  it('位移不够大时不触发（避免点按与抖动误判）', () => {
    expect(resolveSwipe(-20, 2)).toBeNull()
    expect(resolveSwipe(SWIPE_MIN_PX - 1, 0)).toBeNull()
    expect(resolveSwipe(-(SWIPE_MIN_PX - 1), 0)).toBeNull()
  })

  it('刚够阈值就触发', () => {
    expect(resolveSwipe(-SWIPE_MIN_PX, 0)).toBe('next')
    expect(resolveSwipe(SWIPE_MIN_PX, 0)).toBe('prev')
  })

  it('斜向但不明确时不触发 —— 否则正常滚动会被误伤', () => {
    // 横向 100 纵向 80：横向不占绝对优势
    expect(resolveSwipe(-100, 80)).toBeNull()
    // 横向 60 纵向 50：比值 1.2，低于 1.8
    expect(resolveSwipe(60, 50)).toBeNull()
  })

  it('纵向为主的手势一律不触发（把滚动和下拉刷新留给原逻辑）', () => {
    expect(resolveSwipe(-10, 200)).toBeNull()
    expect(resolveSwipe(30, -180)).toBeNull()
  })

  it('横划同时带一点纵向偏移仍然触发', () => {
    expect(resolveSwipe(-200, 30)).toBe('next')
    expect(resolveSwipe(200, -30)).toBe('prev')
  })

  it('零位移不触发', () => {
    expect(resolveSwipe(0, 0)).toBeNull()
  })

  it('阈值可覆盖', () => {
    expect(resolveSwipe(-30, 0, 20)).toBe('next')
    expect(resolveSwipe(-30, 0, 40)).toBeNull()
  })
})
