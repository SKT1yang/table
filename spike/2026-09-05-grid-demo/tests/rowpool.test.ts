/**
 * 行回收差分规划器 planReassign —— 逻辑级验证（无 DOM）。
 * 核心契约：纯滚动时保持行零样式写入（topMoved/visual 全 false），
 * 只有进入窗口的行需要 rebind —— 回收性能语义的全部基础。
 */
import { describe, it, expect } from 'vitest'
import { planReassign, type SlotState } from '../src/core/rowpool'
import type { FlatRow } from '../src/core/store'

/** 构造窗口行：id 连续 r{start}..r{end}，全普通行 */
function rows(start: number, end: number, patch?: (i: number, fr: FlatRow) => void): FlatRow[] {
  const out: FlatRow[] = []
  for (let i = start; i < end; i++) {
    const fr: FlatRow = { id: `r${i}`, depth: 0, hasChildren: false, expanded: false }
    patch?.(i, fr)
    out.push(fr)
  }
  return out
}

/** slot 快照 = 上次绑定的行（index 语义 = 扁平绝对索引；注意 FlatRow.id → SlotState.rowId） */
function states(start: number, end: number, patch?: (i: number, fr: FlatRow) => void): SlotState[] {
  return rows(start, end, patch).map((fr, i) => ({
    rowId: fr.id,
    index: start + i,
    depth: fr.depth,
    hasChildren: fr.hasChildren,
    expanded: fr.expanded,
  }))
}

describe('planReassign', () => {
  it('纯滚动位移 k：恰好 k enters / k frees，所有 keep 零样式写入', () => {
    const plan = planReassign(states(100, 140), rows(110, 150), 110)
    expect(plan.enters).toHaveLength(10)
    expect(plan.frees).toHaveLength(10)
    expect(plan.keeps).toHaveLength(30)
    // 滚动零样式写入契约：保持行 top 不变、树形视觉不变
    expect(plan.keeps.every((k) => !k.topMoved && !k.visual)).toBe(true)
    expect(plan.enters.map((e) => e.fr.id)).toEqual(rows(140, 150).map((r) => r.id))
  })

  it('向上滚动同理（反方向）', () => {
    const plan = planReassign(states(100, 140), rows(90, 130), 90)
    expect(plan.enters).toHaveLength(10)
    expect(plan.frees).toHaveLength(10)
    expect(plan.keeps.every((k) => !k.topMoved && !k.visual)).toBe(true)
  })

  it('不相交跳转：零 keep，全量 frees/enters', () => {
    const plan = planReassign(states(100, 140), rows(5000, 5040), 5000)
    expect(plan.keeps).toHaveLength(0)
    expect(plan.frees).toHaveLength(40)
    expect(plan.enters).toHaveLength(40)
  })

  it('窗口上方展开（对象全量重建）：索引平移的 keep topMoved，语义未变的行 visual=false', () => {
    // flatten 契约：任何展开/收起后 FlatRow 对象全新 —— 引用比较必须失效。
    // 窗口上方插入 5 行：窗口内容 r105..r144，但绝对索引整体 +5（r105 从 105 → 110）
    const next = rows(105, 145)
    const plan = planReassign(states(100, 140), next, 110)
    expect(plan.keeps).toHaveLength(35) // r105..r139
    expect(plan.keeps.every((k) => k.topMoved)).toBe(true) // 索引全部 +5
    expect(plan.keeps.every((k) => !k.visual)).toBe(true) // 但语义字段全没变
    expect(plan.enters).toHaveLength(5) // r140..r144（绝对索引 145..149）
    expect(plan.frees).toHaveLength(5) // 持有 r100..r104 的 slot
  })

  it('窗口内展开：切换行 visual=true，子节点 enters，下方行 topMoved，行数此消彼长', () => {
    // 窗口 r100..r139（r110 = 折叠父节点）；展开 r110 插入 3 个子节点，尾部 3 行被挤出
    const prev = states(100, 140, (i, fr) => {
      if (i === 110) fr.hasChildren = true // 折叠父节点：hasChildren / expanded=false
    })
    const next = [
      ...rows(100, 111, (i, fr) => {
        if (i === 110) { fr.hasChildren = true; fr.expanded = true }
      }),
      { id: 'c0', depth: 1, hasChildren: false, expanded: false },
      { id: 'c1', depth: 1, hasChildren: false, expanded: false },
      { id: 'c2', depth: 1, hasChildren: false, expanded: false },
      ...rows(111, 137),
    ]
    const plan = planReassign(prev, next, 100)
    expect(plan.enters.map((e) => e.fr.id)).toEqual(['c0', 'c1', 'c2'])
    expect(plan.frees).toHaveLength(3) // r137..r139 离开
    const toggled = plan.keeps.find((k) => k.fr.id === 'r110')
    const above = plan.keeps.find((k) => k.fr.id === 'r105')
    const below = plan.keeps.find((k) => k.fr.id === 'r120')
    // r110: expanded 翻转 → visual、索引未变；上方行索引未变；下方行索引 +3 → topMoved
    expect([toggled?.visual, toggled?.topMoved, above?.topMoved, above?.visual, below?.topMoved]).toEqual([
      true, false, false, false, true,
    ])
  })

  it('收起：子节点变 frees，下方行 topMoved（反向平移），切换行 visual', () => {
    // prev：r110 已展开，含子节点 c0/c1；收起后窗口缩短 2 行 → 0 enters / 2 frees
    const prevRows = [
      ...rows(100, 111, (i, fr) => {
        if (i === 110) { fr.hasChildren = true; fr.expanded = true }
      }),
      { id: 'c0', depth: 1, hasChildren: false, expanded: false },
      { id: 'c1', depth: 1, hasChildren: false, expanded: false },
      ...rows(111, 139),
    ]
    const prev = prevRows.map((fr, i) => ({
      rowId: fr.id,
      index: 100 + i,
      depth: fr.depth,
      hasChildren: fr.hasChildren,
      expanded: fr.expanded,
    }))
    const next = [
      ...rows(100, 111, (i, fr) => {
        if (i === 110) fr.hasChildren = true // expanded 收回落 false
      }),
      ...rows(111, 139),
    ]
    const plan = planReassign(prev, next, 100)
    expect(plan.frees).toHaveLength(2) // c0/c1 的 slot
    expect(plan.enters).toHaveLength(0) // 窗口缩短：只出不全进
    expect(plan.keeps).toHaveLength(39)
    const toggled = plan.keeps.find((k) => k.fr.id === 'r110')
    const below = plan.keeps.find((k) => k.fr.id === 'r120')
    expect([toggled?.visual, below?.topMoved]).toEqual([true, true])
  })

  it('窗口收缩（跳转→静止恢复）：frees > enters，富余 slot 归还空闲池', () => {
    const plan = planReassign(states(100, 140), rows(100, 120), 100) // 只保留前 20 行
    expect(plan.keeps).toHaveLength(20)
    expect(plan.frees).toHaveLength(20)
    expect(plan.enters).toHaveLength(0)
  })

  it('边界：空窗口 / 空池 / 换数据源（id 全换）', () => {
    expect(planReassign(states(100, 140), [])).toEqual({ keeps: [], frees: states(100, 140).map((_, i) => i), enters: [] })
    const fromEmpty = planReassign([], rows(0, 5))
    expect(fromEmpty).toEqual({ keeps: [], frees: [], enters: rows(0, 5).map((fr, i) => ({ index: i, fr })) })
    // 换数据源：id 不相交 → 全量 rebind
    expect(planReassign(states(100, 140), rows(900, 940), 900).keeps).toHaveLength(0)
  })

  it('深度档位变化（跨层移动语义）→ visual', () => {
    const prev = states(100, 101)
    const next = rows(100, 101, (_, fr) => { fr.depth = 2 })
    const plan = planReassign(prev, next, 100)
    expect(plan.keeps[0].visual).toBe(true)
    expect(plan.keeps[0].topMoved).toBe(false)
  })
})
