import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import eslintConfigPrettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    // android/ 由 Capacitor/Gradle 生成，其中还会复制生产环境的压缩 JS；
    // 这些文件不属于源码，应该由 Android 工具链校验而不是交给 ESLint。
    ignores: ['dist/**', 'android/**', 'node_modules/**', '.pnpm-store/**', '*.tmp', '*.tmpdir/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser }
    }
  },
  {
    files: ['**/*.{ts,tsx,vue}'],
    languageOptions: { globals: { ...globals.browser } }
  },
  {
    files: ['scripts/**/*.mjs', '*.config.js', '*.config.mjs'],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    // scripts/ 下的 .js 是 Univer 文档脚本，跑在 univer_execute 的沙箱里：
    // univerAPI / api / doc 由沙箱注入（见脚本头部注释），不是模块导入，
    // 所以必须在这里声明，否则 no-undef 会把它当成未定义变量报错。
    files: ['scripts/**/*.js'],
    languageOptions: {
      globals: { ...globals.node, univerAPI: 'readonly', api: 'readonly', doc: 'readonly' }
    }
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        caches: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        location: 'readonly'
      }
    }
  },
  {
    files: ['**/*.test.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } }
  },
  {
    rules: {
      // 明确使用的 any / 断言属于与 IndexedDB 等弱类型 API 交互的既有写法
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },
  eslintConfigPrettier
)
