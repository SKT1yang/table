/**
 * 自研薄 signal —— spike 的头号验证对象（方向文档开放问题 #1）。
 *
 * 语义契约（tests/signal.test.ts 锁定）：
 *  1. 相等语义 = ===：atom.set 同值零传播；computed 重算后值不变 → 不向下游传播
 *     （= AG Grid cell 级 change detection 的 signal 化，验收 3 的机制基础）
 *  2. computed lazy + 缓存：无消费者的链路不空转，读取时才重算
 *  3. effect 立即执行一次；依赖每次执行时重建；dispose 后彻底解绑
 *  4. batch：多次 set 合并为一次 effect flush（toggleExpand 的原子性依赖它）
 *
 * 传播模型：atom.set 同步急切重算「有下游的」computed（值变才继续传播），
 * effect 延迟到 flush 阶段统一执行 —— 兼顾正确性（effect 只跑一次、读到新值）
 * 与「值不变停传播」的精确性。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Subscriber {
  deps: Set<AnyNode>
}
type AnyNode = AtomImpl<any> | ComputedImpl<any>

let activeSub: Subscriber | null = null
const subStack: Subscriber[] = []

function pushSub(s: Subscriber) {
  subStack.push(s)
  activeSub = s
}
function popSub() {
  subStack.pop()
  activeSub = subStack.length ? subStack[subStack.length - 1] : null
}

function track(node: AnyNode) {
  if (activeSub) {
    node.subs.add(activeSub)
    activeSub.deps.add(node)
  }
}

class AtomImpl<T> {
  readonly subs = new Set<Subscriber>()
  constructor(public current: T) {}
  read(): T {
    track(this)
    return this.current
  }
  write(next: T): void {
    if (next === this.current) return // 语义 1：=== 同值零传播
    this.current = next
    if (this.subs.size) notifySubs(this.subs)
  }
}

class ComputedImpl<T> {
  readonly subs = new Set<Subscriber>()
  readonly deps = new Set<AnyNode>()
  dirty = true
  hasValue = false
  value: T = undefined as T
  private computing = false
  constructor(private readonly fn: () => T) {}

  read(): T {
    if (this.dirty) this.recompute() // 语义 2：lazy，读取时才重算
    track(this)
    return this.value
  }
  peek(): T {
    if (this.dirty) this.recompute()
    return this.value
  }

  recompute(): void {
    if (!this.dirty) return
    if (this.computing) throw new Error('signal: 检测到循环依赖')
    this.computing = true
    // 重建依赖：先解绑旧的（依赖集合每次重算重建，支持条件分支动态依赖）
    for (const d of this.deps) d.subs.delete(this)
    this.deps.clear()
    pushSub(this)
    let next: T
    try {
      next = this.fn()
    } finally {
      popSub()
      this.computing = false
    }
    this.dirty = false
    const changed = !this.hasValue || next !== this.value
    this.value = next
    this.hasValue = true
    if (changed && this.subs.size) notifySubs(this.subs) // 语义 1：值不变停传播
  }

  dispose(): void {
    for (const d of this.deps) d.subs.delete(this)
    this.deps.clear()
    this.dirty = true
  }
}

class EffectImpl {
  readonly deps = new Set<AnyNode>()
  private disposed = false
  constructor(private readonly fn: () => void) {}
  run(): void {
    if (this.disposed) return
    for (const d of this.deps) d.subs.delete(this)
    this.deps.clear() // 语义 3：依赖每次执行重建
    pushSub(this)
    try {
      this.fn()
    } finally {
      popSub()
    }
  }
  dispose(): void {
    this.disposed = true
    pending.delete(this)
    for (const d of this.deps) d.subs.delete(this)
    this.deps.clear()
  }
}

// —— 调度：effect 去重 + 延迟 flush ——
// notifyDepth：一次 set 的整条通知波次内不 flush（否则菱形依赖中 effect 会在
// 兄弟 computed 尚未重算时提前执行、读到脏值又触发二次调度）；波次结束统一 flush。
// batchDepth：多次 set 合并为一次 flush（语义 4）。
const pending = new Set<EffectImpl>()
let batchDepth = 0
let notifyDepth = 0
let flushing = false

function schedule(e: EffectImpl) {
  pending.add(e)
  if (batchDepth === 0 && notifyDepth === 0) flush()
}

function flush() {
  if (flushing) return
  flushing = true
  try {
    while (pending.size) {
      const e = pending.values().next().value!
      pending.delete(e)
      e.run()
    }
  } finally {
    flushing = false
  }
}

function notifySubs(subs: Set<Subscriber>) {
  notifyDepth++
  try {
    for (const sub of [...subs]) {
      if (sub instanceof EffectImpl) {
        schedule(sub)
      } else {
        const c = sub as ComputedImpl<unknown>
        c.dirty = true
        // 有下游才急切重算；无下游留在 dirty，等下次 read 懒算
        if (c.subs.size > 0) c.recompute()
      }
    }
  } finally {
    notifyDepth--
    if (notifyDepth === 0 && batchDepth === 0) flush()
  }
}

// —— 公开 API ——

export interface Atom<T> {
  (): T
  set(next: T): void
  peek(): T
  /** debug：当前订阅数（防泄漏自检用） */
  readonly _subs: number
}
export interface Computed<T> {
  (): T
  peek(): T
  dispose(): void
  /** debug：当前订阅数（防泄漏自检用） */
  readonly _subs: number
}

export function atom<T>(initial: T): Atom<T> {
  const a = new AtomImpl(initial)
  const f = (() => a.read()) as Atom<T>
  f.set = (v: T) => a.write(v)
  f.peek = () => a.current
  Object.defineProperty(f, '_subs', { get: () => a.subs.size })
  return f
}

export function computed<T>(fn: () => T): Computed<T> {
  const c = new ComputedImpl(fn)
  const f = (() => c.read()) as Computed<T>
  f.peek = () => c.peek()
  f.dispose = () => c.dispose()
  Object.defineProperty(f, '_subs', { get: () => c.subs.size })
  return f
}

export function effect(fn: () => void): () => void {
  const e = new EffectImpl(fn)
  e.run()
  return () => e.dispose()
}

export function batch(fn: () => void): void {
  batchDepth++
  try {
    fn()
  } finally {
    batchDepth--
    if (batchDepth === 0) flush()
  }
}
