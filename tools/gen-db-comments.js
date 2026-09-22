/**
 * 从 server.js 的 SCHEMA_COMMENTS 生成独立的 SQL 脚本（tools/db-comments.sql）。
 * 唯一数据源是 server.js，避免两处文案不一致。
 * 用法：node tools/gen-db-comments.js
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

// 提取 SCHEMA_COMMENTS 数组区间
const start = src.indexOf("const SCHEMA_COMMENTS = [");
const end = src.indexOf("];", start);
if (start < 0 || end < 0) { console.error("未找到 SCHEMA_COMMENTS"); process.exit(1); }
const block = src.slice(start, end);

// 解析形如 ["TABLE", "hazard", null, "注释"] 的每一行
const rowRe = /\[\s*"(TABLE|COLUMN)"\s*,\s*"([^"]+)"\s*,\s*(null|"[^"]+")\s*,\s*"((?:[^"\\]|\\.)*)"\s*\]/g;
const entries = [];
let m;
while ((m = rowRe.exec(block)) !== null) {
  const [, kind, table, col, textRaw] = m;
  const colName = col === "null" ? null : col.slice(1, -1);
  const text = textRaw.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  entries.push({ kind, table, col: colName, text });
}

const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;
const out = [
  "-- ============================================================================",
  "--  隐患治理台账系统 — 表 / 字段中文注释",
  "-- ============================================================================",
  "--  本文件由 tools/gen-db-comments.js 从 server.js 的 SCHEMA_COMMENTS 自动生成，",
  "--  请勿手工修改；要改注释请改 server.js 后重新生成。",
  "--",
  "--  何时需要用到本文件？",
  "--    · 服务启动时会自动同步这些注释，**平时无需手动执行**；",
  "--    · 仅当你把数据库搬到别处、或想手动补注释时，才需要执行：",
  "--        \"D:\\PostgreSQL\\pgsql\\bin\\psql.exe\" -U postgres -h 127.0.0.1 -d hazard_ledger -f tools\\db-comments.sql",
  "--",
  `--  共 ${entries.length} 条（表 ${entries.filter((e) => e.kind === "TABLE").length} 张 / 字段 ${entries.filter((e) => e.kind === "COLUMN").length} 个）`,
  "-- ============================================================================",
  "",
];
for (const e of entries) {
  if (e.kind === "TABLE") out.push(`COMMENT ON TABLE ${e.table} IS ${sq(e.text)};`);
  else out.push(`COMMENT ON COLUMN ${e.table}.${e.col} IS ${sq(e.text)};`);
}
out.push("");

fs.writeFileSync(path.join(ROOT, "tools", "db-comments.sql"), out.join("\n"), "utf8");
console.log(`✅ 已生成 tools/db-comments.sql（${entries.length} 条）`);
