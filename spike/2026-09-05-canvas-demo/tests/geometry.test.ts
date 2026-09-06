/**
 * 几何纯函数单测：canvas 路线自带的命中检测/窗口数学（DOM 路线由浏览器代劳的部分）。
 */
import { describe, it, expect } from 'vitest'
import {
  colRange,
  rowRange,
  hitTest,
  ensureColVisible,
  fitText,
  type ColMeta,
} from '../src/geometry'

// 2 pinned(100) + 3 body(150)，pinnedW=200，总宽 650
const cols: ColMeta[] = [
  { col: { id: 'a', title: 'A', width: 100 }, absLeft: 0, pinLeft: 0, pinned: true },
  { col: { id: 'b', title: 'B', width: 100 }, absLeft: 100, pinLeft: 100, pinned: true },
  { col: { id: 'c', title: 'C', width: 150 }, absLeft: 200, pinLeft: 0, pinned: false },
  { col: { id: 'd', title: 'D', width: 150 }, absLeft: 350, pinLeft: 0, pinned: false },
  { col: { id: 'e', title: 'E', width: 150 }, absLeft: 500, pinLeft: 0, pinned: false },
]
const R = 35
const H = 36

describe('colRange（可见 body 列窗口，pinned 永不进窗口）', () => {
  it('sl=0：与 [pinnedW, vw) 相交的 body 列', () => {
    expect(colRange(cols, 0, 500, 200)).toEqual([2, 4]) // c、d 可见，e 越界
  })
  it('视口宽于内容：全部 body 列', () => {
    expect(colRange(cols, 0, 650, 200)).toEqual([2, 5])
  })
  it('横向滚动：左缘被 pinned 遮住的列不出现', () => {
    expect(colRange(cols, 150, 400, 200)).toEqual([3, 5]) // c 完全藏在 pinned 下
  })
  it('滚出右缘：空窗口', () => {
    expect(colRange(cols, 500, 300, 200)).toEqual([0, 0])
  })
  it('零宽视口：空窗口', () => {
    expect(colRange(cols, 0, 0, 200)).toEqual([0, 0])
  })
})

describe('rowRange（可见行窗口，带表头偏移与上下过绘）', () => {
  it('顶部：从 0 起，含 1 行过绘', () => {
    expect(rowRange(1000, 0, 600, R, H)).toEqual([0, 18])
  })
  it('中部：跨界行（部分在视口上方）包含在内', () => {
    expect(rowRange(1000, 3500, 600, R, H)).toEqual([98, 118])
  })
  it('尾部 clamp 到 total', () => {
    expect(rowRange(100, 2900, 600, R, H)).toEqual([81, 100])
  })
  it('空数据 / 零高视口', () => {
    expect(rowRange(0, 0, 600, R, H)).toEqual([0, 0])
    expect(rowRange(10, 0, 0, R, H)).toEqual([0, 0])
  })
})

describe('hitTest（viewport 坐标 → 行列；树形开关共用绘制常量）', () => {
  const rows = [
    { hasChildren: true, depth: 0 },
    { hasChildren: true, depth: 1 },
    { hasChildren: false, depth: 0 },
  ]
  it('body 命中', () => {
    expect(hitTest(250, 50, cols, rows, 0, 0, H, R, 200)).toEqual({ rowIdx: 0, colIdx: 2, toggle: false })
  })
  it('pinned 命中', () => {
    expect(hitTest(50, 50, cols, rows, 0, 0, H, R, 200)).toEqual({ rowIdx: 0, colIdx: 0, toggle: false })
  })
  it('表头区 → null', () => {
    expect(hitTest(250, 20, cols, rows, 0, 0, H, R, 200)).toBeNull()
  })
  it('越界（底/右）→ null', () => {
    expect(hitTest(250, H + 3 * R, cols, rows, 0, 0, H, R, 200)).toBeNull()
    expect(hitTest(700, 50, cols, rows, 0, 0, H, R, 200)).toBeNull()
  })
  it('树形开关命中（深度 0）', () => {
    expect(hitTest(10, 50, cols, rows, 0, 0, H, R, 200)).toEqual({ rowIdx: 0, colIdx: 0, toggle: true })
  })
  it('深度 1：开关区间随缩进右移', () => {
    expect(hitTest(30, H + R, cols, rows, 0, 0, H, R, 200)).toEqual({ rowIdx: 1, colIdx: 0, toggle: true })
    expect(hitTest(10, H + R, cols, rows, 0, 0, H, R, 200)).toEqual({ rowIdx: 1, colIdx: 0, toggle: false })
  })
  it('叶子行首列不命中开关', () => {
    expect(hitTest(10, H + 2 * R, cols, rows, 0, 0, H, R, 200)).toEqual({ rowIdx: 2, colIdx: 0, toggle: false })
  })
  it('横向滚动下：pinned 区按 viewport、body 区按 content 换算', () => {
    // sl=150：viewport x=100 在 pinned 区 → 列 b（viewport 坐标，不换算）
    expect(hitTest(100, 50, cols, rows, 150, 0, H, R, 200)).toEqual({ rowIdx: 0, colIdx: 1, toggle: false })
    // body 区：viewport 250 ↔ content 400 → 列 d
    expect(hitTest(250, 50, cols, rows, 150, 0, H, R, 200)).toEqual({ rowIdx: 0, colIdx: 3, toggle: false })
  })
  it('★ 横向滚动后 pinned 区点击不误命中 body 列（CDP 冒烟抓到的回归）', () => {
    // sl=1600：viewport x=10 在 pinned 区 → 列 a；若错误地做 content 换算（1610）会命中 body 列
    expect(hitTest(10, 50, cols, rows, 1600, 0, H, R, 200)).toEqual({ rowIdx: 0, colIdx: 0, toggle: true })
    expect(hitTest(150, 50, cols, rows, 1600, 0, H, R, 200)).toEqual({ rowIdx: 0, colIdx: 1, toggle: false })
    // body 区正常换算：sl=100 → viewport 250 ↔ content 350 → 列 d
    expect(hitTest(250, 50, cols, rows, 100, 0, H, R, 200)).toEqual({ rowIdx: 0, colIdx: 3, toggle: false })
  })
})

describe('ensureColVisible（焦点列横向滚入，nearest 语义）', () => {
  it('已可见 → null', () => {
    expect(ensureColVisible(cols[2], 0, 500, 200)).toBeNull() // c 在 [200,500)
    expect(ensureColVisible(cols[3], 150, 500, 200)).toBeNull() // d 在 [350,650)
  })
  it('右缘露出 → 右对齐', () => {
    expect(ensureColVisible(cols[4], 0, 500, 200)).toBe(150) // e 右缘 650 - vw 500
  })
  it('左缘被 pinned 遮住 → 对齐 pinned 右缘', () => {
    expect(ensureColVisible(cols[2], 150, 500, 200)).toBe(0)
  })
  it('pinned 列 → null（不参与横向滚动）', () => {
    expect(ensureColVisible(cols[0], 500, 500, 200)).toBeNull()
  })
})

describe('fitText（省略号，measure 注入）', () => {
  const measure = (s: string) => s.length * 6
  it('适配 → 原文', () => {
    expect(fitText('abc', 100, measure)).toBe('abc')
  })
  it('溢出 → 截断加省略号', () => {
    expect(fitText('abcdefghij', 30, measure)).toBe('abcd…')
  })
  it('零宽 → 空串；极窄 → 省略号兜底（clip 收尾）', () => {
    expect(fitText('abc', 0, measure)).toBe('')
    expect(fitText('abc', 3, measure)).toBe('…')
  })
})
