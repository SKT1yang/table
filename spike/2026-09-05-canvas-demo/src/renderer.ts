/**
 * canvas 渲染器（纯 TS，零框架依赖 —— 「渲染器层可替换」的第二个实例）。
 * 与 DOM spike 的核心差异：没有挂载/卸载，只有「重绘可见区」——不连续滚动
 * （拖滚动条/跳转）在 DOM 路线是结构性边界（挂载吞吐 0.45ms/行 vs 需求
 * 0.16ms/行），在此退化为一次全量重绘（实测见 RESULTS.md）。
 *
 * 架构：draw 即 effect —— draw() 本身是一个 signal effect，直接订阅
 * scrollTop/viewportSize/flatRows/focusCell/每个可见 cell 的 readCell(→dataVersion)，
 * 任何 store 变化同步重绘。零手动刷新管线；=== 停传播保证同值零重绘
 * （编辑 → dataVersion bump → 全 cell 重算 → 只有真变化才触发重绘）。
 *
 * 分层绘制（单 canvas 多 clip pass，替代 DOM 的 sticky/z-index）：
 *   body(clip 右侧主区) → pinned body(左侧实底) → 接缝阴影 →
 *   header body → header pinned(左上角) → focus 环
 */
import { atom, batch, effect, type Atom } from './core/signal'
import type { GridStore } from './core/store'
import {
  colRange,
  rowRange,
  fitText,
  hitTest,
  ensureColVisible,
  PAD_X,
  INDENT_PX,
  TOGGLE_W,
  type ColMeta,
} from './geometry'

export interface RendererHost {
  wrap: HTMLElement
  scroller: HTMLElement
  spacer: HTMLElement
  canvas: HTMLCanvasElement
}

export interface RendererStats {
  /** 重绘次数（编辑提交后 delta 应为 1 —— draw 即 effect 的 === 停传播证据） */
  repaints: Atom<number>
  lastMs: Atom<number>
  avgMs: Atom<number>
}

const FONT = "12px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif"
const FONT_HEADER = "600 12px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif"
const C = {
  bg: '#ffffff',
  pinnedBg: '#f4f5f7',
  headerBg: '#eef0f3',
  headerPinnedBg: '#e8eaef',
  headerText: '#333333',
  text: '#333333',
  line: '#eeeeee',
  pinnedLine: '#e3e4e8',
  headerLine: '#e0e2e6',
  headerBottom: '#d7d9de',
  focus: '#1668dc',
  toggle: '#666666',
}

export function createRenderer(store: GridStore, host: RendererHost) {
  const { scroller, spacer, canvas } = host
  const ctx = canvas.getContext('2d', { alpha: false })!
  const R = store.ROW_HEIGHT
  const H = store.HEADER_HEIGHT

  // 列元数据一次性构建（demo 列不变；列宽动态化 = 每次重算 absLeft 前缀）
  const colMetas: ColMeta[] = store.columns.map((c) => store.colById.get(c.id)!)
  const pinnedCols = colMetas.filter((m) => m.pinned)
  const pinnedCount = pinnedCols.length
  const pinnedW = store.pinnedWidth
  const treeCol = colMetas[0] // 树形列 = 首列（与 DOM spike 同假设）

  // 渲染器本地状态：横向滚动脉冲（store 无 scrollLeft atom —— core 原样复用，
  // 横向纯属渲染关注点）；纯横滚时 scrollTop 不变 === 停传播会吞掉重绘，靠它补触发
  const hTick = atom(0)

  // —— 统计（Vue 工具栏 / CDP 读取）——
  const repaints = atom(0)
  const lastMs = atom(0)
  const avgMs = atom(0)
  const stats: RendererStats = { repaints, lastMs, avgMs }

  let lastRowCount = -1

  function drawCell(m: ColMeta, rowTop: number, fr: { depth: number; hasChildren: boolean; expanded: boolean }, value: unknown): void {
    const x = m.absLeft
    const w = m.col.width
    ctx.fillStyle = m.pinned ? C.pinnedBg : C.bg
    ctx.fillRect(x, rowTop, w, R)

    const isTree = m === treeCol
    let tx = x + PAD_X
    if (isTree && fr.hasChildren) {
      // 展开开关（命中检测共用 INDENT_PX/TOGGLE_W/PAD_X 常量）
      const cx = Math.round(x + PAD_X + fr.depth * INDENT_PX + TOGGLE_W / 2)
      const cy = Math.round(rowTop + R / 2)
      ctx.beginPath()
      if (fr.expanded) {
        ctx.moveTo(cx - 4, cy - 3)
        ctx.lineTo(cx + 4, cy - 3)
        ctx.lineTo(cx, cy + 4)
      } else {
        ctx.moveTo(cx - 3, cy - 4)
        ctx.lineTo(cx - 3, cy + 4)
        ctx.lineTo(cx + 4, cy)
      }
      ctx.closePath()
      ctx.fillStyle = C.toggle
      ctx.fill()
      tx = x + PAD_X + fr.depth * INDENT_PX + TOGGLE_W + 4
    } else if (isTree) {
      tx = x + PAD_X + fr.depth * INDENT_PX
    }

    const text = value == null ? '' : String(value)
    if (!text) return
    const maxW = (m.pinned ? x + w : x + w) - tx - PAD_X
    const fitted = fitText(text, maxW, (s) => ctx.measureText(s).width)
    ctx.fillStyle = C.text
    if (typeof value === 'number') {
      ctx.textAlign = 'right'
      ctx.fillText(fitted, x + w - PAD_X, Math.round(rowTop + R / 2))
      ctx.textAlign = 'left'
    } else {
      ctx.fillText(fitted, tx, Math.round(rowTop + R / 2))
    }
  }

  function draw(): void {
    hTick() // 纯横滚时 scrollTop 不变（=== 停传播），靠此脉冲订阅触发重绘——CDP 实测抓到过缺失导致的横向滞留
    const t0 = performance.now()
    const dpr = (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1

    // 位图尺寸自愈（首帧/窗口缩放/DPR 变化/滚动条出现——RO 之外的第二道保险）
    const cw = scroller.clientWidth
    const ch = scroller.clientHeight
    const bw = Math.max(1, Math.round(cw * dpr))
    const bh = Math.max(1, Math.round(ch * dpr))
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw
      canvas.height = bh
      canvas.style.width = cw + 'px'
      canvas.style.height = ch + 'px'
    }

    const vw = Math.max(cw, 1)
    const vh = Math.max(ch, 1)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.font = FONT
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = C.bg
    ctx.fillRect(0, 0, vw, vh)

    const rows = store.flatRows()
    // spacer 尺寸只在行数变化时写（滚动帧零样式写入）
    if (rows.length !== lastRowCount) {
      lastRowCount = rows.length
      spacer.style.width = store.totalWidth + 'px'
      spacer.style.height = H + rows.length * R + 'px'
    }

    const focus = store.focusCell()
    const focusIdx = focus ? store.rowIndexMap().get(focus.rowId) : undefined

    if (rows.length) {
      const st = store.scrollTop()
      const sl = Math.round(scroller.scrollLeft)
      const sti = Math.round(st)
      const [r0, r1] = rowRange(rows.length, sti, vh, R, H)
      const [c0, c1] = colRange(colMetas, sl, vw, pinnedW)
      const yTop = r0 * R
      const yBottom = r1 * R

      // —— pass 1：body（pinned 右侧主区）——
      ctx.save()
      ctx.beginPath()
      ctx.rect(pinnedW, H, Math.max(0, vw - pinnedW), vh - H)
      ctx.clip()
      ctx.translate(-sl, H - sti)
      for (let ri = r0; ri < r1; ri++) {
        const fr = rows[ri]
        const rowTop = ri * R
        for (let ci = c0; ci < c1; ci++) {
          const m = colMetas[ci]
          drawCell(m, rowTop, fr, store.readCell(fr.id, m.col.id))
        }
      }
      // 网格线（单 path 批量 stroke；空窗口不画）
      if (c1 > c0) {
        ctx.beginPath()
        for (let ri = r0; ri < r1; ri++) {
          const y = ri * R + R - 0.5
          ctx.moveTo(colMetas[c0].absLeft, y)
          ctx.lineTo(colMetas[c1 - 1].absLeft + colMetas[c1 - 1].col.width, y)
        }
        for (let ci = c0; ci < c1; ci++) {
          const x = colMetas[ci].absLeft + colMetas[ci].col.width - 0.5
          ctx.moveTo(x, yTop)
          ctx.lineTo(x, yBottom)
        }
        ctx.strokeStyle = C.line
        ctx.lineWidth = 1
        ctx.stroke()
      }
      ctx.restore()

      // —— pass 2：pinned body（左侧实底，clip 天然互斥零同步）——
      if (pinnedCount > 0) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(0, H, pinnedW, vh - H)
        ctx.clip()
        ctx.translate(0, H - sti)
        for (let ri = r0; ri < r1; ri++) {
          const fr = rows[ri]
          const rowTop = ri * R
          for (const m of pinnedCols) drawCell(m, rowTop, fr, store.readCell(fr.id, m.col.id))
        }
        ctx.beginPath()
        for (let ri = r0; ri < r1; ri++) {
          const y = ri * R + R - 0.5
          ctx.moveTo(0, y)
          ctx.lineTo(pinnedW, y)
        }
        for (const m of pinnedCols) {
          const x = m.absLeft + m.col.width - 0.5
          ctx.moveTo(x, yTop)
          ctx.lineTo(x, yBottom)
        }
        ctx.strokeStyle = C.pinnedLine
        ctx.lineWidth = 1
        ctx.stroke()
        ctx.restore()
      }

      // —— 接缝阴影（横向滚动时提示 pinned 之下还有内容）——
      if (sl > 0) {
        const grad = ctx.createLinearGradient(pinnedW, 0, pinnedW + 6, 0)
        grad.addColorStop(0, 'rgba(31,35,41,0.12)')
        grad.addColorStop(1, 'rgba(31,35,41,0)')
        ctx.fillStyle = grad
        ctx.fillRect(pinnedW, H, 6, vh - H)
      }

      // —— pass 3：header（body 列段 + pinned 段，clip 互斥）——
      const drawHeader = (from: number, to: number, left: number, w: number, pinned: boolean) => {
        ctx.save()
        ctx.beginPath()
        ctx.rect(left, 0, Math.max(0, w), H)
        ctx.clip()
        ctx.translate(pinned ? 0 : -sl, 0)
        ctx.font = FONT_HEADER
        ctx.fillStyle = pinned ? C.headerPinnedBg : C.headerBg
        ctx.fillRect(pinned ? 0 : sl, 0, pinned ? pinnedW : vw, H)
        for (let ci = from; ci < to; ci++) {
          const m = colMetas[ci]
          ctx.fillStyle = C.headerText
          ctx.fillText(m.col.title, m.absLeft + PAD_X, Math.round(H / 2))
        }
        // 列分隔 + 表头底边
        ctx.beginPath()
        for (let ci = from; ci < to; ci++) {
          const x = colMetas[ci].absLeft + colMetas[ci].col.width - 0.5
          ctx.moveTo(x, 0)
          ctx.lineTo(x, H)
        }
        ctx.moveTo(pinned ? 0 : sl, H - 0.5)
        ctx.lineTo(pinned ? pinnedW : sl + vw, H - 0.5)
        ctx.strokeStyle = C.headerBottom
        ctx.lineWidth = 1
        ctx.stroke()
        ctx.font = FONT
        ctx.restore()
      }
      drawHeader(c0, c1, pinnedW, vw - pinnedW, false)
      if (pinnedCount > 0) drawHeader(0, pinnedCount, 0, pinnedW, true)

      // —— focus 环（viewport 坐标；编辑期由 DOM 覆盖层盖住）——
      if (focus && focusIdx != null) {
        const m = store.colById.get(focus.colId)
        if (m) {
          const fx = m.pinned ? m.pinLeft : m.absLeft - sl
          const fy = H + focusIdx * R - sti
          ctx.strokeStyle = C.focus
          ctx.lineWidth = 2
          ctx.strokeRect(fx + 1, fy + 1, m.col.width - 2, R - 2)
        }
      }
    }

    const ms = performance.now() - t0
    repaints.set(repaints.peek() + 1)
    lastMs.set(ms)
    avgMs.set(avgMs.peek() === 0 ? ms : avgMs.peek() * 0.9 + ms * 0.1)
  }

  // —— 首帧量测 + RO（滚动条出现/消失改变 clientWidth 时 contentRect 变化会触发）——
  // 先于 draw effect 建立：首绘即带真实视口尺寸
  store.viewportSize.set({ width: scroller.clientWidth, height: scroller.clientHeight })
  let ro: ResizeObserver | null = null
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      store.viewportSize.set({ width: r.width, height: r.height })
    })
    ro.observe(scroller)
  }

  // —— draw 即 effect：订阅一切渲染输入（含每个可见 cell 的 dataVersion）——
  const stopDraw = effect(draw)

  // —— store scrollTop → scroller 反向同步（键盘导航/展开补偿；同值 no-op 无环路）——
  const stopSync = effect(() => {
    const st = store.scrollTop()
    if (Math.abs(scroller.scrollTop - st) > 0.5) scroller.scrollTop = st
  })

  // —— 事件 ——
  function onScroll(): void {
    const st = scroller.scrollTop
    batch(() => {
      hTick.set(hTick.peek() + 1) // 纯横滚时 scrollTop 不变，靠脉冲重绘
      if (st !== store.scrollTop.peek()) store.scrollTop.set(st)
    })
  }

  function hitAt(e: MouseEvent) {
    const rect = scroller.getBoundingClientRect()
    return hitTest(
      e.clientX - rect.left,
      e.clientY - rect.top,
      colMetas,
      store.flatRows.peek(),
      scroller.scrollLeft,
      scroller.scrollTop,
      H,
      R,
      pinnedW,
    )
  }

  function onClick(e: MouseEvent): void {
    const hit = hitAt(e)
    if (!hit) return
    const rows = store.flatRows.peek()
    if (hit.toggle) {
      store.toggleExpand(rows[hit.rowIdx].id)
      return
    }
    store.focusCell.set({ rowId: rows[hit.rowIdx].id, colId: colMetas[hit.colIdx].col.id })
  }

  function onDblClick(e: MouseEvent): void {
    const hit = hitAt(e)
    if (!hit) return
    const rows = store.flatRows.peek()
    const pos = { rowId: rows[hit.rowIdx].id, colId: colMetas[hit.colIdx].col.id }
    store.focusCell.set(pos)
    store.beginEdit(pos)
  }

  function onMouseDown(): void {
    scroller.focus({ preventScroll: true })
  }

  /** 焦点列横向滚入视口（纵向由 store.scrollFocusIntoView 负责） */
  function followFocusX(): void {
    const pos = store.focusCell.peek()
    if (!pos) return
    const m = store.colById.get(pos.colId)
    if (!m) return
    const target = ensureColVisible(m, scroller.scrollLeft, scroller.clientWidth, pinnedW)
    if (target != null) scroller.scrollLeft = target
  }

  function onKeydown(e: KeyboardEvent): void {
    const meta = e.ctrlKey || e.metaKey
    if (meta && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault()
      if (e.shiftKey) store.commands.redo()
      else store.commands.undo()
      return
    }
    if (meta && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault()
      store.commands.redo()
      return
    }
    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault()
        store.moveFocus(-1, 0)
        store.scrollFocusIntoView()
        break
      case 'ArrowDown':
        e.preventDefault()
        store.moveFocus(1, 0)
        store.scrollFocusIntoView()
        break
      case 'ArrowLeft':
        e.preventDefault()
        store.moveFocus(0, -1)
        break
      case 'ArrowRight':
        e.preventDefault()
        store.moveFocus(0, 1)
        break
      case 'Tab':
        e.preventDefault()
        store.moveFocus(0, e.shiftKey ? -1 : 1)
        break
      case 'Home':
        e.preventDefault()
        store.focusEdge(meta ? 'home' : 'rowHome')
        store.scrollFocusIntoView()
        break
      case 'End':
        e.preventDefault()
        store.focusEdge(meta ? 'end' : 'rowEnd')
        store.scrollFocusIntoView()
        break
      case 'Enter':
      case 'F2':
        e.preventDefault()
        store.beginEdit()
        break
      case 'Escape':
        store.cancelEdit()
        break
    }
    followFocusX()
  }

  scroller.addEventListener('scroll', onScroll, { passive: true })
  scroller.addEventListener('click', onClick)
  scroller.addEventListener('dblclick', onDblClick)
  scroller.addEventListener('mousedown', onMouseDown)
  scroller.addEventListener('keydown', onKeydown)

  function dispose(): void {
    stopDraw()
    stopSync()
    ro?.disconnect()
    scroller.removeEventListener('scroll', onScroll)
    scroller.removeEventListener('click', onClick)
    scroller.removeEventListener('dblclick', onDblClick)
    scroller.removeEventListener('mousedown', onMouseDown)
    scroller.removeEventListener('keydown', onKeydown)
  }

  return { stats, dispose }
}

export type GridRenderer = ReturnType<typeof createRenderer>
