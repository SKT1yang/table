/**
 * COMMAND→MUTATION 命令流 + undo/redo 对压栈（spike 假设 #4，Univer 范式的最小形状）。
 * mutation 即未来协同的 OT transform 单位（接缝形状，本 spike 不做协同）。
 */
import { atom, computed, type Computed } from './signal'

export interface SetCellMutation {
  type: 'setCell'
  rowId: string
  colId: string
  /** 编辑前的值（undo 用 / 未来 OT 用） */
  prev: unknown
  /** 编辑后的值 */
  value: unknown
}

export type Mutation = SetCellMutation

export interface CommandService {
  /** 按序应用一组 mutation（= 一次 COMMAND 的 undo 单位）*/
  execute(muts: Mutation[]): void
  undo(): boolean
  redo(): boolean
  canUndo: Computed<boolean>
  canRedo: Computed<boolean>
}

export function createCommandService(apply: (m: Mutation) => void): CommandService {
  const undoStack: Mutation[][] = []
  const redoStack: Mutation[][] = []
  const version = atom(0)
  const canUndo = computed(() => {
    version()
    return undoStack.length > 0
  })
  const canRedo = computed(() => {
    version()
    return redoStack.length > 0
  })

  function execute(muts: Mutation[]): void {
    if (!muts.length) return
    for (const m of muts) apply(m)
    undoStack.push(muts)
    redoStack.length = 0 // 对压栈语义：新命令使 redo 分支失效
    version.set(version.peek() + 1)
  }

  function undo(): boolean {
    const group = undoStack.pop()
    if (!group) return false
    for (let i = group.length - 1; i >= 0; i--) {
      const m = group[i]
      apply({ ...m, prev: m.value, value: m.prev }) // 反向应用
    }
    redoStack.push(group)
    version.set(version.peek() + 1)
    return true
  }

  function redo(): boolean {
    const group = redoStack.pop()
    if (!group) return false
    for (const m of group) apply(m)
    undoStack.push(group)
    version.set(version.peek() + 1)
    return true
  }

  return { execute, undo, redo, canUndo, canRedo }
}
