import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  // '@table/core' 仅类型面使用（usage-shims 声明合并），运行时不引用，无需 alias。
  test: {
    typecheck: {
      // 双轨分工（文档 §6）：tsc（vitest --typecheck）只管 *.test-d.ts 断言；
      // .vue 与全程序检查归 vue-tsc（pnpm typecheck）。
      // tsc 不解析 .vue 导入，故忽略测试文件之外的源错误（vue-tsc 已全量把关）。
      ignoreSourceErrors: true,
    },
  },
})
