/**
 * 性能 smoke：记录关键耗时供 RESULTS.md 引用（宽松上限，防 CI 抖动）。
 */
import { describe, it, expect } from 'vitest'
import { generateData } from '../src/mock'
import { flatten } from '../src/core/store'

describe('perf smoke', () => {
  it('数据生成 / 全展开 flatten 耗时记录', () => {
    let t0 = performance.now()
    const rows = generateData(100_000)
    const genMs = performance.now() - t0

    const allParentIds = new Set<string>()
    const collect = (ns: typeof rows) => {
      for (const n of ns) {
        if (n.children) {
          allParentIds.add(n.id)
          collect(n.children)
        }
      }
    }
    collect(rows)
    t0 = performance.now()
    const flat = flatten(rows, allParentIds)
    const flattenMs = performance.now() - t0

    // eslint-disable-next-line no-console
    console.log(
      `[perf] 生成 10 万行×20 列: ${genMs.toFixed(0)}ms；全展开 flatten(${flat.length} 行): ${flattenMs.toFixed(1)}ms`,
    )

    expect(flat.length).toBe(100_000)
    expect(genMs).toBeLessThan(2_000) // 宽松上限
    expect(flattenMs).toBeLessThan(100) // 展开单父节点只 +105 行，全量重算也应在个位数 ms
  })
})
