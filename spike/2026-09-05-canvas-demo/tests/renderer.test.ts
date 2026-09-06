/**
 * 「draw 即 effect」语义单测（mock canvas，node 环境跑真渲染器 + 真 store）：
 *  - 任何渲染输入变化 → 恰一次全量重绘（=== 停传播 → 同值零重绘）
 *  - 虚拟化：fillText 次数 ≈ 可见 cell 数，远小于全量
 *  - 编辑入口不重绘，值变化才重绘（对应 DOM 版 cell 计数 delta=1）
 *  - dispose 后订阅清零（防泄漏契约：dataVersion 订阅数归 0）
 */
import { describe, it, expect } from 'vitest'
import { createStore } from '../src/core/store'
import { COLUMNS, generateData } from '../src/mock'
import { createRenderer, type RendererHost } from '../src/renderer'

function mockHost() {
  const fills = { fillText: 0 }
  const ctx: unknown = new Proxy(
    {},
    {
      get(_t, p) {
        if (p === 'measureText') return (s: string) => ({ width: s.length * 6 })
        if (p === 'createLinearGradient')
          return () => ({
            addColorStop() {},
          })
        if (p === 'fillText') return () => void fills.fillText++
        if (typeof p === 'symbol') return undefined
        return () => {}
      },
      set() {
        return true
      },
    },
  )
  const canvas = {
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    getContext: () => ctx,
  }
  const listeners: Record<string, Array<() => void>> = {}
  const host = {
    wrap: { style: {} },
    scroller: {
      scrollTop: 0,
      scrollLeft: 0,
      clientWidth: 800,
      clientHeight: 600,
      style: {},
      addEventListener(type: string, fn: () => void) {
        ;(listeners[type] ??= []).push(fn)
      },
      removeEventListener(type: string, fn: () => void) {
        listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn)
      },
      focus() {},
    },
    spacer: { style: {} as Record<string, string> },
    canvas,
  }
  /** 直接触发已注册的 scroller 事件（模拟浏览器 scroll 派发） */
  const fire = (type: string) => {
    for (const fn of listeners[type] ?? []) fn()
  }
  return { host: host as unknown as RendererHost, fills, spacer: host.spacer, scroller: host.scroller, fire }
}

function setup(rowCount = 500) {
  const store = createStore(COLUMNS)
  store.loadRows(generateData(rowCount))
  const { host, fills, spacer, scroller, fire } = mockHost()
  const renderer = createRenderer(store, host)
  return { store, renderer, fills, spacer, scroller, fire }
}

describe('renderer：draw 即 effect', () => {
  it('挂载首绘：重绘=1，只画可见区（远小于全量 cell）', () => {
    const { renderer, fills } = setup()
    expect(renderer.stats.repaints.peek()).toBe(1)
    // 600px 高 ≈ 18 行 × (3 body 列 + 2 pinned) + 5 表头 ≈ 95；全量 = 500×20
    expect(fills.fillText).toBeGreaterThan(50)
    expect(fills.fillText).toBeLessThan(300)
  })

  it('滚动 → 恰 +1 重绘；同值 set 零重绘（=== 停传播）', () => {
    const { store, renderer } = setup()
    expect(renderer.stats.repaints.peek()).toBe(1)
    store.scrollTop.set(1000)
    expect(renderer.stats.repaints.peek()).toBe(2)
    store.scrollTop.set(1000) // 同值
    expect(renderer.stats.repaints.peek()).toBe(2)
  })

  it('focus 变化 → +1 重绘（焦点环）', () => {
    const { store, renderer } = setup()
    store.scrollTop.set(1000)
    store.focusCell.set({ rowId: 'r10', colId: 'c5' })
    expect(renderer.stats.repaints.peek()).toBe(3)
  })

  it('编辑入口不重绘；提交同值零命令；值变化 → +1 重绘', () => {
    const { store, renderer } = setup()
    store.focusCell.set({ rowId: 'r10', colId: 'c5' })
    const base = renderer.stats.repaints.peek()
    store.beginEdit({ rowId: 'r10', colId: 'c5' }) // editingCell 不在 draw 依赖里
    expect(renderer.stats.repaints.peek()).toBe(base)
    const prev = store.readCell('r10', 'c5')
    store.commitEdit(prev) // 同值 → 无 mutation
    expect(renderer.stats.repaints.peek()).toBe(base)
    store.beginEdit({ rowId: 'r10', colId: 'c5' })
    store.commitEdit('EDITED')
    expect(renderer.stats.repaints.peek()).toBe(base + 1)
    expect(store.readCell('r10', 'c5')).toBe('EDITED')
  })

  it('undo/redo 各 +1 重绘，值往返正确', () => {
    const { store, renderer } = setup()
    store.focusCell.set({ rowId: 'r10', colId: 'c5' })
    store.beginEdit({ rowId: 'r10', colId: 'c5' })
    store.commitEdit('V2')
    store.beginEdit({ rowId: 'r10', colId: 'c5' })
    store.commitEdit('V3')
    const base = renderer.stats.repaints.peek()
    expect(store.commands.undo()).toBe(true)
    expect(store.readCell('r10', 'c5')).toBe('V2')
    expect(renderer.stats.repaints.peek()).toBe(base + 1)
    expect(store.commands.redo()).toBe(true)
    expect(store.readCell('r10', 'c5')).toBe('V3')
    expect(renderer.stats.repaints.peek()).toBe(base + 2)
  })

  it('树形展开 → 扁平行数变化 + spacer 尺寸同步', () => {
    const { store, spacer } = setup(2000) // i=899 处有父节点（2000 > 899+105）
    expect(spacer.style.height).toBe(36 + store.flatRows.peek().length * 35 + 'px')
    store.toggleExpand('r899')
    const after = store.flatRows.peek().length
    expect(after).toBeGreaterThan(0)
    expect(spacer.style.height).toBe(36 + after * 35 + 'px')
  })

  it('★ 纯横向滚动（scrollTop 不变）→ 滚动脉冲仍触发重绘（CDP 实测抓到的回归）', () => {
    const { renderer, scroller, fire } = setup()
    const base = renderer.stats.repaints.peek()
    scroller.scrollLeft = 800
    fire('scroll')
    expect(renderer.stats.repaints.peek()).toBe(base + 1)
  })

  it('dispose：订阅清零，后续变化不再重绘（防泄漏契约）', () => {
    const { store, renderer } = setup()
    expect(store.dataVersionSubs()).toBeGreaterThan(0) // draw effect 持有 dataVersion 订阅
    const frozen = renderer.stats.repaints.peek()
    renderer.dispose()
    expect(store.dataVersionSubs()).toBe(0)
    store.scrollTop.set(3000)
    store.focusCell.set({ rowId: 'r10', colId: 'c5' })
    expect(renderer.stats.repaints.peek()).toBe(frozen)
  })
})
