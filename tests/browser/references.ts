// 开发环境组件验证页面：只展示合成数据，不访问用户资料或模型接口。
import { createApp, h } from 'vue'
import MessageBubble from '../../src/components/MessageBubble.vue'
import { getPersona, DEFAULT_PERSONA_ID } from '../../src/data/personas'
import '../../src/styles/theme.css'
import '../../src/styles/base.css'

createApp({
  render: () =>
    h('main', { style: 'max-width:640px;margin:32px auto;padding:16px' }, [
      h('h1', '引用组件验证'),
      h(MessageBubble, {
        persona: getPersona(DEFAULT_PERSONA_ID),
        message: {
          id: 'test',
          sessionId: 'test',
          role: 'assistant',
          createdAt: 0,
          content: '测试项目使用 Vue 构建界面。[1]',
          references: [
            {
              title: '测试技术说明',
              content: '测试项目使用 Vue 构建界面。\n这是保存的原文快照。',
              documentId: 'test',
              chunkIds: ['test-1']
            }
          ]
        }
      })
    ])
}).mount('#app')
