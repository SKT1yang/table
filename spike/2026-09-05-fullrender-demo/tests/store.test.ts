/**
 * core 集成：数据管线 / 命令流 / 树形锚点补偿 / 键盘导航数学 —— 逻辑级验证（无 DOM）。
 * （全量档：computeRange/滚动形态分流测试随虚拟化机器删除，见 grid-demo 原版对照）
 */
import { describe, it, expect } from 'vitest'
import { createStore, flatten, ROW_HEIGHT, type RowNode } from '../src/core/store'
import { scrollTargetForIndex } from '../src/core/virtual'
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
