import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { Capacitor } from '@capacitor/core'
import { App as NativeApp } from '@capacitor/app'
import App from './App.vue'
import router from './router'
import { initTheme } from './composables/useTheme'

import './styles/theme.css'
import './styles/base.css'

// 主题必须在挂载前写入 html，避免首帧闪一下默认配色
initTheme()

createApp(App).use(createPinia()).use(router).mount('#app')

// Android 实体返回键：子页面先回到上一条 Web 路由，只有广场首页才退出。
// 不注册监听时 Capacitor 会把返回键交给 Activity，任何页面都会直接退桌面。
if (Capacitor.isNativePlatform()) {
  void router.isReady().then(() =>
    NativeApp.addListener('backButton', () => {
      if (router.currentRoute.value.path !== '/') router.back()
      else void NativeApp.exitApp()
    })
  )
}

// PWA：仅在正式构建注册 Service Worker，避免开发时缓存干扰热更新
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('[pwa] Service Worker 注册失败', error)
    })
  })
}
