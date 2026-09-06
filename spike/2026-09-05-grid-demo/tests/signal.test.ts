/**
 * signal 语义锁定 —— spike 假设 #3（cell 级 === 停传播）与防泄漏契约的硬证据。
 */
import { describe, it, expect, vi } from 'vitest'
import { atom, computed, effect, batch } from '../src/core/signal'

describe('atom', () => {
  it('set 相同引用零传播；dispose 后彻底解绑', () => {
    const a = atom({ x: 1 })
    const spy = vi.fn()
    const dispose = effect(() => {
      a()
      spy()
    })
    expect(spy).toHaveBeenCalledTimes(1)
    a.set(a.peek()) // === 相同
    expect(spy).toHaveBeenCalledTimes(1)
    a.set({ x: 2 })
    expect(spy).toHaveBeenCalledTimes(2)
    dispose()
    a.set({ x: 3 })
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('peek 不建立依赖', () => {
    const a = atom(1)
    const spy = vi.fn(() => a.peek())
    effect(spy)
    a.set(2)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('computed', () => {
  it('lazy + 缓存：依赖未变时 fn 只执行一次', () => {
    const a = atom(1)
    const fn = vi.fn(() => a() * 2)
    const c = computed(fn)
    expect(fn).toHaveBeenCalledTimes(0) // lazy：未读取不计算
    expect(c()).toBe(2)
    expect(c()).toBe(2)
    expect(fn).toHaveBeenCalledTimes(1)
    a.set(2)
    expect(c()).toBe(4)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('★ 值不变停传播：上游引用变了但投影值 ===，下游 effect 不触发（AG Grid cell diff 语义）', () => {
    const a = atom({ x: 1, y: 9 })
    const cellA = computed(() => a().x)
    const spyA = vi.fn(() => cellA())
    effect(spyA)
    expect(spyA).toHaveBeenCalledTimes(1)

    a.set({ x: 1, y: 100 }) // 新引用；cellA 投影值仍为 1
    expect(spyA).toHaveBeenCalledTimes(1) // ← 停传播，不触发

    a.set({ x: 5, y: 100 })
    expect(spyA).toHaveBeenCalledTimes(2)
  })

  it('依赖动态切换（条件分支）', () => {
    const cond = atom(true)
    const a = atom('a')
    const b = atom('b')
    const c = computed(() => (cond() ? a() : b()))
    expect(c()).toBe('a')
    b.set('B')
    expect(c()).toBe('a') // 未订阅 b
    cond.set(false)
    expect(c()).toBe('B')
    a.set('A')
    expect(c()).toBe('B') // 已解绑 a
  })

  it('菱形依赖无 glitch：一次 set 下游 effect 只跑一次且读到新值', () => {
    const a = atom(1)
    const b = computed(() => a() + 1)
    const c = computed(() => a() * 10)
    let last = ''
    const spy = vi.fn(() => {
      last = `${b()}-${c()}`
    })
    effect(spy)
    expect(last).toBe('2-10')
    a.set(2)
    expect(spy).toHaveBeenCalledTimes(2)
    expect(last).toBe('3-20')
  })

  it('computed.dispose 后上游变更不再触发下游 effect（cell 卸载防泄漏契约）', () => {
    const a = atom(1)
    const c = computed(() => a())
    const spy = vi.fn(() => c())
    effect(spy)
    expect(spy).toHaveBeenCalledTimes(1)
    c.dispose()
    a.set(2)
    expect(spy).toHaveBeenCalledTimes(1) // c 已从 a 解绑 → 停传播
  })

  it('dispose 后上游订阅数归零（无泄漏）', () => {
    const a = atom(0)
    expect(a._subs).toBe(0)
    const c = computed(() => a())
    const dispose = effect(() => c())
    expect(a._subs).toBe(1) // c 挂在 a 上
    dispose()
    expect(a._subs).toBe(1) // effect 解绑，computed 仍在
    c.dispose()
    expect(a._subs).toBe(0)
  })
})

describe('batch', () => {
  it('多次 set 合并为一次 effect flush', () => {
    const a = atom(0)
    const spy = vi.fn(() => a())
    effect(spy)
    expect(spy).toHaveBeenCalledTimes(1)
    batch(() => {
      a.set(1)
      a.set(2)
      a.set(3)
    })
    expect(spy).toHaveBeenCalledTimes(2)
    expect(a.peek()).toBe(3)
  })
})
