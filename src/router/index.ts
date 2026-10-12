import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'

/**
 * 用 hash 模式：部署到任意静态托管都不需要服务端重写规则，
 * 直接双击 index.html 之外的场景也更容易跑起来。
 * 四个页面全部按需加载，减小首屏体积。
 */
const routes: RouteRecordRaw[] = [
  { path: '/', name: 'plaza', component: () => import('@/views/PlazaView.vue') },
  { path: '/personas', name: 'personas', component: () => import('@/views/PersonasView.vue') },
  { path: '/personas/edit', name: 'persona-edit', component: () => import('@/views/PersonaEditView.vue') },
  { path: '/memories', name: 'memories', component: () => import('@/views/MemoriesView.vue') },
  { path: '/chat', name: 'chat', component: () => import('@/views/ChatView.vue') },
  { path: '/library', name: 'library', component: () => import('@/views/LibraryView.vue') },
  { path: '/predict', name: 'predict', component: () => import('@/views/PredictView.vue') },
  { path: '/debate', name: 'debate', component: () => import('@/views/DebateView.vue') },
  { path: '/guess', name: 'guess', component: () => import('@/views/GuessView.vue') },
  { path: '/me', name: 'me', component: () => import('@/views/MeView.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/' }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

const TITLES: Record<string, string> = {
  plaza: 'AI 智囊团',
  personas: '角色广场 · AI 智囊团',
  'persona-edit': '编辑角色 · AI 智囊团',
  memories: '记忆 · AI 智囊团',
  chat: '对话 · AI 智囊团',
  library: '资料 · AI 智囊团',
  predict: '问数 · AI 智囊团',
  debate: '问理 · AI 智囊团',
  guess: '猜心 · AI 智囊团',
  me: '我的 · AI 智囊团'
}

router.afterEach((to) => {
  document.title = TITLES[String(to.name)] ?? 'AI 智囊团'
})

export default router
