import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  // 相对资源路径同时兼容静态托管与 Capacitor WebView 内的本地资源。
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    // 监听 0.0.0.0，方便手机连同一局域网真机调试
    host: true,
    port: 5173,
    watch: {
      /**
       * 忽略「原子写入」留下的临时文件。
       * 不少编辑器/工具保存源码时先写 `.<文件名>.<pid>.<uuid>.tmpdir/<文件名>.tmp`
       * 再改名覆盖原文件；Windows 上改名瞬间文件仍被占用，chokidar 会抛
       * EBUSY，而 FSWatcher 的 error 事件没有接手方，**整个 dev server 会直接退出**。
       * 这类临时目录没有任何被监听的价值，忽略掉即可。
       */
      // 验收截图与导出报告不是源文件；Windows 下载写入时可能被暂时锁定。
      ignored: ['**/*.tmpdir/**', '**/*.tmp', '**/output/**']
    }
  },
  build: {
    target: 'es2020',
    rollupOptions: {
      output: {
        // 手动分包：把体积较大的第三方库拆出去，优化首屏
        manualChunks: {
          vendor: ['vue', 'vue-router', 'pinia'],
          markdown: ['marked', 'dompurify'],
          // TensorFlow.js 体积大且只在「问数」用到，单独拆包便于缓存
          tfjs: ['@tensorflow/tfjs']
        }
      }
    }
  }
})
