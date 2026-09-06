/**
 * Vue 消费原语（spike 形态，方向文档开放问题 #2）。
 * shallowRef 赋值即可 —— 所有 signal 值都是不可变替换（number/新数组/新对象），
 * 双保险：signal 层 === 停传播 + Vue 自身 hasChanged 检查，不需要 triggerRef。
 */
import { shallowRef, onScopeDispose, type Ref } from 'vue'
import { effect, type Atom, type Computed } from './core/signal'

/** 整值订阅（range / slice / canUndo / focusRect...） */
export function useSignal<T>(sig: Atom<T> | Computed<T>): Ref<T> {
  const r = shallowRef<T>(sig())
  const stop = effect(() => {
    r.value = sig()
  })
  onScopeDispose(stop)
  return r
}
