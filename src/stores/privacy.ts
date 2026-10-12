/** 本地隐私锁状态 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { kvGet, kvSet } from '@/db'
import { createSalt, hashPin } from '@/utils/pin'

interface PrivacyRecord {
  enabled: boolean
  salt: string
  hash: string
}

const KEY = 'privacy-lock'

export const usePrivacyStore = defineStore('privacy', () => {
  const record = ref<PrivacyRecord>({ enabled: false, salt: '', hash: '' })
  const ready = ref(false)
  const unlocked = ref(true)
  const busy = ref(false)
  const errorText = ref<string | null>(null)
  /** 读取配置失败时的提示：隐私锁静默失效是安全问题，必须让用户看见 */
  const storageWarning = ref<string | null>(null)
  const loadFailed = ref(false)
  const loading = ref(false)

  const enabled = computed(() => record.value.enabled && Boolean(record.value.hash))
  const locked = computed(() => !ready.value || loadFailed.value || (enabled.value && !unlocked.value))

  async function init(): Promise<void> {
    if (loading.value) return
    loading.value = true
    try {
      const saved = await kvGet<PrivacyRecord>(KEY)
      if (
        saved &&
        (typeof saved.enabled !== 'boolean' ||
          typeof saved.hash !== 'string' ||
          typeof saved.salt !== 'string' ||
          (saved.enabled && (!saved.hash || !saved.salt)))
      ) {
        throw new Error('隐私锁配置损坏')
      }
      record.value = { enabled: false, salt: '', hash: '' }
      unlocked.value = true
      if (saved?.hash && saved.salt) {
        record.value = { enabled: Boolean(saved.enabled), salt: saved.salt, hash: saved.hash }
        unlocked.value = !record.value.enabled
      }
      storageWarning.value = null
      loadFailed.value = false
    } catch (error) {
      // 读不到配置时不能假装「没设过锁」，否则隐私锁会静默失效
      loadFailed.value = true
      unlocked.value = false
      storageWarning.value = `隐私锁配置读取失败，内容保持锁定：${(error as Error).message}`
      console.warn('[privacy] 读取隐私锁配置失败', error)
    } finally {
      ready.value = true
      loading.value = false
    }
  }

  async function setPin(pin: string): Promise<boolean> {
    if (!ready.value || loadFailed.value || loading.value) return false
    const value = pin.trim()
    if (!/^\d{4,8}$/.test(value)) {
      errorText.value = 'PIN 需要是 4～8 位数字'
      return false
    }
    busy.value = true
    errorText.value = null
    try {
      const salt = createSalt()
      const hash = await hashPin(value, salt)
      const next: PrivacyRecord = { enabled: true, salt, hash }
      // 先落盘、成功后再改内存：否则写库失败时界面显示「已启用」，
      // 刷新后锁却不见了，用户完全无从察觉
      await kvSet(KEY, next)
      record.value = next
      unlocked.value = true
      storageWarning.value = null
      return true
    } catch (error) {
      errorText.value = (error as Error).message
      return false
    } finally {
      busy.value = false
    }
  }

  async function disablePin(pin: string): Promise<boolean> {
    if (!(await verify(pin))) return false
    const previous = record.value.enabled
    record.value.enabled = false
    try {
      await kvSet(KEY, { ...record.value })
      unlocked.value = true
      return true
    } catch (error) {
      // 写失败就回滚内存状态，避免「界面关了、库里还开着」
      record.value.enabled = previous
      errorText.value = (error as Error).message
      return false
    }
  }

  async function verify(pin: string): Promise<boolean> {
    if (!ready.value || loadFailed.value || loading.value) return false
    if (!record.value.hash || !record.value.salt) return true
    busy.value = true
    errorText.value = null
    try {
      const valid = (await hashPin(pin.trim(), record.value.salt)) === record.value.hash
      if (!valid) errorText.value = 'PIN 不正确'
      else unlocked.value = true
      return valid
    } catch (error) {
      errorText.value = (error as Error).message
      return false
    } finally {
      busy.value = false
    }
  }

  function clearError(): void {
    errorText.value = null
  }

  return {
    loadFailed,
    loading,
    record,
    ready,
    enabled,
    locked,
    unlocked,
    busy,
    errorText,
    storageWarning,
    init,
    setPin,
    disablePin,
    verify,
    clearError
  }
})
