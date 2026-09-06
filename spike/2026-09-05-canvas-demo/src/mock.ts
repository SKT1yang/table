/**
 * mock 数据：10 万行 × 20 列 + 树形结构。
 * 树形分布：顶层每 900 行一个父节点（95 子；其第 50 子再带 10 孙），
 * 滚动到任意位置都能遇到可展开行；默认全收起 ≈ 8.6 万可见行，全部展开恰 10 万。
 */
import type { RowNode, Column } from './core/store'

const WORDS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet',
  'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango',
]

export const COLUMNS: Column[] = [
  { id: 'c0', title: '名称', width: 180, pinned: true },
  { id: 'c1', title: '编号', width: 160, pinned: true },
  ...Array.from({ length: 18 }, (_, i) => ({ id: `c${i + 2}`, title: `列 ${i + 3}`, width: 150 })),
]

function mk(id: string, seed: number, children?: RowNode[]): RowNode {
  const data: Record<string, unknown> = {
    c0: `${WORDS[seed % 20]}-${seed}`,
    c1: id,
  }
  for (let j = 2; j < 20; j++) {
    data[`c${j}`] = j % 3 === 0 ? seed * 20 + j : `${WORDS[(seed + j) % 20]}.${j}`
  }
  return { id, children, data }
}

/** 精确凑到 total（父节点 +105，不足时补普通行） */
export function generateData(total = 100_000): RowNode[] {
  const rows: RowNode[] = []
  let parents = 0
  const actual = () => rows.length + parents * 105
  let i = 0
  while (actual() < total) {
    const wantParent = i % 900 === 899
    if (wantParent && actual() + 105 <= total) {
      parents++
      const id = `r${i}`
      const children: RowNode[] = []
      for (let c = 0; c < 95; c++) {
        const cid = `${id}-c${c}`
        if (c === 49) {
          const grand: RowNode[] = []
          for (let k = 0; k < 10; k++) grand.push(mk(`${cid}-g${k}`, i * 100 + k))
          children.push(mk(cid, i * 100 + c, grand))
        } else {
          children.push(mk(cid, i * 100 + c))
        }
      }
      rows.push(mk(id, i, children))
    } else {
      rows.push(mk(`r${i}`, i))
    }
    i++
  }
  return rows
}
