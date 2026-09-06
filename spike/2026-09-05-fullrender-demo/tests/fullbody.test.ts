/**
 * 分块首屏的块计划纯函数契约（FullBody 的 DOM 半边由 ?bench=1 页内自检覆盖）。
 */
import { describe, it, expect } from 'vitest'
import { planChunks } from '../src/core/fullbody'

describe('planChunks', () => {
  it('空数据 → 无块', () => {
    expect(planChunks(0, 200)).toEqual([])
  })

  it('chunk=0（同步全量对照档）→ 单块覆盖全部', () => {
    expect(planChunks(5000, 0)).toEqual([{ from: 0, to: 5000 }])
    expect(planChunks(5000, -1)).toEqual([{ from: 0, to: 5000 }])
  })

  it('整除：5000 / 200 → 25 块，末块恰好闭合', () => {
    const chunks = planChunks(5000, 200)
    expect(chunks).toHaveLength(25)
    expect(chunks[0]).toEqual({ from: 0, to: 200 })
    expect(chunks[24]).toEqual({ from: 4800, to: 5000 })
  })

  it('非整除：末块截断到 count（1000 / 300 → 4 块，末块 900..1000）', () => {
    const chunks = planChunks(1000, 300)
    expect(chunks).toHaveLength(4)
    expect(chunks[3]).toEqual({ from: 900, to: 1000 })
  })

  it('chunkSize > count → 单块（首屏即全量）', () => {
    expect(planChunks(50, 200)).toEqual([{ from: 0, to: 50 }])
  })

  it('块区间连续无缝（滚动条在挂载期间恒定的前提：首块后即可滚到任意处）', () => {
    const chunks = planChunks(1234, 97)
    let cursor = 0
    for (const c of chunks) {
      expect(c.from).toBe(cursor)
      expect(c.to).toBeGreaterThan(c.from)
      cursor = c.to
    }
    expect(cursor).toBe(1234)
  })
})
