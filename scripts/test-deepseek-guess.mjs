// 真实猜心回归入口：直接运行应用实际的 store、提示词、核对和知识库检索。
// 不复制游戏逻辑，不使用固定备用题。会调用真实 API，模型模拟玩家，不代表真人准确率。
// 运行：node scripts/test-deepseek-guess.mjs 奶龙
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const targets = ['奶龙', '微波炉', '大熊猫', '皮卡丘', '孙悟空', '电风扇', '月亮', '埃菲尔铁塔', '雨伞', '吉他', '长城']
const target = process.argv[2] ?? '微波炉'
if (target === '--help' || target === '-h') {
  console.log('用法：node scripts/test-deepseek-guess.mjs [目标]；默认微波炉，每局最多60轮，调用真实API。')
  console.log('目标：' + targets.join('、'))
  process.exit(0)
}
if (!targets.includes(target)) {
  console.error('未登记的测试目标，请使用 --help 查看可用目标。')
  process.exit(2)
}
const root = fileURLToPath(new URL('../', import.meta.url))
const result = spawnSync(process.execPath, [
  fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)),
  'run', 'src/stores/guess.live.test.ts', '-t', '真实 deepseek-flash：' + target + ' 从零开始猜'
], {cwd: root, env: {...process.env, GUESS_LIVE: '1'}, stdio: 'inherit', shell: false})
if (result.error) console.error('测试启动失败：' + result.error.message)
process.exit(result.status ?? 1)
