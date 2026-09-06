/**
 * core 集成：数据管线 / 命令流 / 树形锚点补偿 / 键盘导航数学 —— 逻辑级验证（无 DOM）。
 */
import { describe, it, expect } from 'vitest'
import { createStore, flatten, ROW_HEIGHT, type RowNode } from '../src/core/store'
import { computeRange, scrollTargetForIndex } from '../src/core/virtual'
import { generateData } from '../src/mock'

function treeRows(): RowNode[] {
  return [
    { id: 'a', data: { c0: 'A' }, children: [
      { id: 'a1', data: { c0: 'A1' } },
      { id: 'a2', data: { c0: 'A2' }, children: [
        { id: 'a2x', data: { c0: 'A2X' } },
        { id: 'a2y', data: { c0: 'A2Y' } },
      ] },
    ] },
    { id: 'b', data: { c0: 'B' } },
  ]
}

describe('flatten', () => {
  it('三层嵌套：折叠子树不出现，展开后 depth 正确', () => {
    const rows = treeRows()
    const collapsed = flatten(rows, new Set())
    expect(collapsed.map((r) => r.id)).toEqual(['a', 'b'])

    const open = flatten(rows, new Set(['a', 'a2']))
    expect(open.map((r) => r.id)).toEqual(['a', 'a1', 'a2', 'a2x', 'a2y', 'b'])
    expect(open.map((r) => r.depth)).toEqual([0, 1, 1, 2, 2, 0])
    expect(open.map((r) => r.hasChildren)).toEqual([true, false, true, false, false, false])
  })
})

describe('virtual', () => {
  it('computeRange：顶部/滚到底/不足一屏/双向缓冲 clamp', () => {
    const vh = 700 // 20 行可见
    const TAIL = 12
    const LEAD = 20
    const r0 = computeRange(100_000, 0, vh, ROW_HEIGHT, TAIL, LEAD)
    expect(r0.startIndex).toBe(0)
    expect(r0.endIndex).toBe(Math.ceil(vh / ROW_HEIGHT) + 1 + LEAD)
    expect(r0.padTop).toBe(0)
    expect(r0.totalHeight).toBe(100_000 * ROW_HEIGHT)

    const st = 100_000 * ROW_HEIGHT - vh // 真实底部 maxScroll
    const rb = computeRange(100_000, st, vh, ROW_HEIGHT, TAIL, LEAD)
    expect(rb.endIndex).toBe(100_000) // 滚到底不越界

    const rs = computeRange(5, 0, vh, ROW_HEIGHT, TAIL, LEAD)
    expect(rs.endIndex).toBe(5) // 数据不足一屏
  })

  it('scrollTargetForIndex：可见返回 null；上方头顶对齐；下方底对齐；clamp', () => {
    const vh = 700
    expect(scrollTargetForIndex(5, vh, ROW_HEIGHT, 100_000, 5 * ROW_HEIGHT)).toBeNull()
    expect(scrollTargetForIndex(2, vh, ROW_HEIGHT, 100_000, 10 * ROW_HEIGHT)).toBe(2 * ROW_HEIGHT)
    expect(scrollTargetForIndex(30, vh, ROW_HEIGHT, 100_000, 10 * ROW_HEIGHT)).toBe(31 * ROW_HEIGHT - vh)
    // 最后一行底对齐被 clamp 到 maxScroll
    expect(scrollTargetForIndex(99_999, vh, ROW_HEIGHT, 100_000, 0)).toBe(100_000 * ROW_HEIGHT - vh)
  })
})

describe('store：编辑命令流（验收 4 逻辑）', () => {
  function setup() {
    const store = createStore([{ id: 'c0', title: 'x', width: 100 }])
    store.loadRows(treeRows())
    store.flatRows.peek()
    return store
  }

  it('编辑 → readCell 返回新值', () => {
    const s = setup()
    s.commands.execute([{ type: 'setCell', rowId: 'a1', colId: 'c0', prev: 'A1', value: 'EDIT' }])
    expect(s.readCell('a1', 'c0')).toBe('EDIT')
    expect(s.readCell('a', 'c0')).toBe('A') // 其它行不受影响
  })

  it('undo/redo 跨多次编辑 + 对压栈（undo 后新命令清空 redo）', () => {
    const s = setup()
    s.commands.execute([{ type: 'setCell', rowId: 'a', colId: 'c0', prev: 'A', value: 'A1' }])
    s.commands.execute([{ type: 'setCell', rowId: 'b', colId: 'c0', prev: 'B', value: 'B1' }])
    expect(s.readCell('a', 'c0')).toBe('A1')

    expect(s.commands.undo()).toBe(true)
    expect(s.readCell('b', 'c0')).toBe('B') // 后编辑的先还原
    expect(s.commands.undo()).toBe(true)
    expect(s.readCell('a', 'c0')).toBe('A')

    expect(s.commands.redo()).toBe(true)
    expect(s.commands.redo()).toBe(true)
    expect(s.readCell('a', 'c0')).toBe('A1')
    expect(s.readCell('b', 'c0')).toBe('B1')

    expect(s.commands.undo()).toBe(true)
    s.commands.execute([{ type: 'setCell', rowId: 'a', colId: 'c0', prev: 'A1', value: 'A2' }])
    expect(s.commands.canRedo.peek()).toBe(false) // redo 分支已失效
    expect(s.readCell('a', 'c0')).toBe('A2')
    expect(s.commands.undo()).toBe(true)
    expect(s.readCell('a', 'c0')).toBe('A1')
  })
})

describe('store：滚动形态分流（连续 vs 跳转）', () => {
  function setup() {
    const s = createStore([{ id: 'c0', title: 'x', width: 100 }])
    s.loadRows(Array.from({ length: 100_000 }, (_, i) => ({ id: 'r' + i, data: {} })))
    s.viewportSize.set({ width: 800, height: 700 }) // 可见 21 行
    return s
  }

  it('连续滚动（400px/帧）：方向 + 速度 lead 生效', () => {
    const s = setup()
    s.scrollTop.set(100 * ROW_HEIGHT)
    s.flatRows.peek()
    s.setScrollVelocity(400) // 11 行/帧 << 窗口
    const r = s.range.peek()
    expect(r.startIndex).toBe(100 - 6) // 后方压半
    expect(r.endIndex).toBeGreaterThan(100 + 21 + 12) // 前方 = 基础 + 速度加成
  })

  it('拖滚动条式跳转（17500px/帧）：判为不相交 → 只挂可见行，零缓冲', () => {
    const s = setup()
    s.scrollTop.set(100 * ROW_HEIGHT)
    s.flatRows.peek()
    s.setScrollVelocity(17500)
    const r = s.range.peek()
    expect(r.startIndex).toBe(100) // tail = 0
    expect(r.endIndex).toBe(100 + 21) // lead = 0，仅可见行（ceil(700/35)+1 含安全余量）
  })

  it('跳转后静止：clear 恢复基础双向缓冲', () => {
    const s = setup()
    s.scrollTop.set(100 * ROW_HEIGHT)
    s.flatRows.peek()
    s.setScrollVelocity(999_999)
    s.clearScrollVelocity()
    const r = s.range.peek()
    expect(r.startIndex).toBe(100 - 12)
    expect(r.endIndex).toBe(100 + 21 + 12) // 12/12 基础
  })

  it('跳转 lead（回收时代的方向性缓冲）：下行只扩下方、上行只扩上方、clear 归零', () => {
    const s = setup()
    s.setJumpLead(150)
    s.scrollTop.set(100 * ROW_HEIGHT)
    s.flatRows.peek()
    s.setScrollVelocity(999_999) // 下行跳转
    expect(s.range.peek().startIndex).toBe(100) // tail = 0
    expect(s.range.peek().endIndex).toBe(100 + 21 + 150) // lead = 150
    s.setScrollVelocity(-999_999) // 上行跳转（tail 被 0 clamp）
    expect(s.range.peek().startIndex).toBe(Math.max(0, 100 - 150))
    expect(s.range.peek().endIndex).toBe(100 + 21)
    s.setScrollVelocity(400) // 连续档不受跳转 lead 影响
    expect(s.range.peek().endIndex).toBeLessThan(100 + 21 + 150)
    s.clearScrollVelocity()
    expect(s.range.peek().startIndex).toBe(100 - 12) // 恢复基础缓冲
  })
})

describe('store：树形锚点补偿（验收 5 逻辑）', () => {
  it('展开视口上方节点：scrollTop 增加 新增行数×行高，锚行 index 视觉不变', () => {
    // 构造：1000 个顶层行，第 10 行带 3 个子
    const rows: RowNode[] = Array.from({ length: 1000 }, (_, i) =>
      i === 10
        ? { id: `r${i}`, data: {}, children: [{ id: 'k1', data: {} }, { id: 'k2', data: {} }, { id: 'k3', data: {} }] }
        : { id: `r${i}`, data: {} },
    )
    const s = createStore([{ id: 'c0', title: 'x', width: 100 }])
    s.loadRows(rows)
    s.viewportSize.set({ width: 800, height: 700 })
    s.scrollTop.set(100 * ROW_HEIGHT) // 视口首行 = r100
    s.flatRows.peek()

    s.toggleExpand('r10') // 视口上方展开，插入 3 行
    expect(s.scrollTop.peek()).toBe(103 * ROW_HEIGHT) // 补偿 +3×35
    expect(s.flatRows.peek()[103].id).toBe('r100') // 锚行视觉位置不变

    s.toggleExpand('r10') // 收起
    expect(s.scrollTop.peek()).toBe(100 * ROW_HEIGHT)
    expect(s.flatRows.peek()[100].id).toBe('r100')
  })

  it('展开视口内自身的父节点：锚行即父节点时不跳', () => {
    const s = createStore([{ id: 'c0', title: 'x', width: 100 }])
    s.loadRows(treeRows())
    s.viewportSize.set({ width: 800, height: 700 })
    s.scrollTop.set(0)
    s.flatRows.peek()
    s.toggleExpand('a') // 首行自身展开
    expect(s.scrollTop.peek()).toBe(0) // 无补偿
    expect(s.flatRows.peek()[0].id).toBe('a')
  })
})

describe('mock 数据', () => {
  it('总数精确 100000，id 唯一，父节点均匀分布', () => {
    const rows = generateData(100_000)
    const s = createStore([{ id: 'c0', title: 'x', width: 100 }])
    s.loadRows(rows)
    expect(s.totalRows).toBe(100_000)
    expect(s.flatRows.peek().length).toBeLessThan(100_000) // 默认全收起
    expect(s.flatRows.peek().length).toBeGreaterThan(85_000)
    // 全展开 = 恰好 10 万且 id 唯一
    const ids = new Set<string>()
    let count = 0
    const walk = (ns: RowNode[]) => {
      for (const n of ns) {
        ids.add(n.id)
        count++
        if (n.children) walk(n.children)
      }
    }
    walk(rows)
    expect(count).toBe(100_000)
    expect(ids.size).toBe(100_000)
  })
})
