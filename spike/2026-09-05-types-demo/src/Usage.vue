<!--
  用户视角探针：模拟业务侧消费类型 API 的真实写法。
  全文件零显式 <Movie> 泛型标注（逃生舱 typedColumn 除外）。
-->
<script setup lang="ts">
import { createTable } from "./core-types";
import { typedColumn } from "./column-helper";
import TableShell from "./TableShell.vue";

type Movie = {
  id: string;
  title: string;
  year: number;
  tags: string[];
  meta?: { lang: string };
};

// interface 行型回归：T extends object 不排除 interface（Record<string, unknown> 会）
interface Film {
  id: string;
  title: string;
  year: number;
}

const movies: Movie[] = [
  { id: "m1", title: "Bugonia", year: 2025, tags: ["sci-fi"], meta: { lang: "en" } },
  { id: "m2", title: "The Bride!", year: 2026, tags: ["romance"] },
];

const films: Film[] = [{ id: "f1", title: "Stalker", year: 1979 }];

const table = createTable({
  data: movies,
  getRowId: (row) => row.id,
  columns: [
    {
      field: "title",
      title: "片名",
      width: 220,
      pinned: true,
      renderCell: ({ value }) => value.toUpperCase(),
    },
    { field: "year", title: "年份", width: 90, renderCell: ({ value }) => `${2026 - value}` },
    { field: "meta", title: "语言", width: 90, renderCell: ({ row }) => row.meta?.lang ?? "-" },
    // 逃生舱：动态列（显式 <Movie> 是清单 ⑧ 的唯一豁免）
    typedColumn<Movie>("runtime", { title: "时长", width: 80 }),
    // 展示列（操作列）
    { id: "actions", title: "操作", width: 120, renderCell: ({ row }) => `编辑 ${row.id}` },
  ],
});

const filmTable = createTable({
  data: films,
  getRowId: (row) => row.id,
  columns: [
    { field: "title", title: "片名", width: 220 },
    // @ts-expect-error interface 行型的字段键控同样生效：'yaer' 不在 keyof Film（单行对象）
    { field: "yaer", title: "年份", width: 90 },
  ],
});

// 命令式方法按键控 + 值收敛
table.sortBy("year", "asc");
table.setCellValue("m1", "year", 2024);
// @ts-expect-error 值类型必须匹配列：year 是 number
table.setCellValue("m1", "year", "2024");
// @ts-expect-error field 拼写错误
table.sortBy("yaer", "asc");

// 事件回调 payload 推断
function onCell(e: { row: Movie; rowId: string; field: keyof Movie }) {
  console.log(e.row.title, e.field);
}
</script>

<template>
  <TableShell :store="table" @cell-click="onCell">
    <template #default="{ rows }">
      <ul>
        <li v-for="r in rows" :key="r.id">
          {{ r.title }}
          <!-- @vue-expect-error 模板内行类型键控探针：noSuchField 不在 Movie 上 -->
          {{ r.noSuchField }}
        </li>
      </ul>
    </template>
  </TableShell>
</template>
