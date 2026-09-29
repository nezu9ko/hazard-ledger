/**
 * 领域模型：数据库行 ↔ 前端 JSON、筛选 SQL 拼装、附件字段规范化
 *
 * ⚠️ 本文件原在 `server.js` 里，2026-09-29 按功能拆分到 lib/ 下。
 *    顶部的 require 是"本文件实际用到什么就引什么"生成的；
 *    想知道本模块跟谁耦合，看顶部那几行就够了。
 */

"use strict";

/* ---------------- 领域模型（数据库行 ↔ 前端 JSON） ---------------- */

/**
 * 解析数据库里存的附件字段（TEXT，内容为 JSON 数组字符串）。
 * **向后兼容**两种元素形态，统一输出 [{ u, n }]（u=路径，n=原文件名）：
 *   · 旧版：纯字符串            "/uploads/xxx.jpg"
 *   · 新版：对象                { "u": "/uploads/xxx.pdf", "n": "整改方案.pdf" }
 * 只保留形如 /uploads/xxx 的本站路径，其余（外链、路径穿越等）一律丢弃。
 */
function parsePhotos(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const x of arr) {
      const u = typeof x === "string" ? x : (x && typeof x.u === "string" ? x.u : null);
      if (!u || !/^\/uploads\/[A-Za-z0-9._-]+$/.test(u)) continue;
      const n = (x && typeof x === "object" && typeof x.n === "string") ? x.n.slice(0, 120) : "";
      out.push({ u, n });
    }
    return out;
  } catch { return []; }
}

/**
 * 校验并归一化「前端提交的附件数组」：白名单路径 + 去重 + 上限个数。
 * 这是防止"外链文件/路径注入"写入数据库的关键闸门。
 * @param max 每个字段最多保留的个数（默认 6）
 */
/** 每个照片字段最多几个附件（与前端 public/script.js 的 MAX_PHOTOS 保持一致） */
const MAX_PHOTOS = 6;
function normalizePhotos(input, max = MAX_PHOTOS) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const x of input) {
    const u = typeof x === "string" ? x : (x && typeof x.u === "string" ? x.u : null);
    if (!u || !/^\/uploads\/[A-Za-z0-9._-]+$/.test(u)) continue;
    // 原文件名：只保留可打印字符、去尖括号（防注入）、限长
    let n = "";
    if (x && typeof x === "object" && typeof x.n === "string") {
      n = x.n.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 120);
    }
    if (!out.some((o) => o.u === u)) out.push({ u, n });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 数据库行 → 前端隐患对象（camelCase）。
 *
 * 设计要点：把「逾期」「未闭环」这两个**派生状态**直接翻译成 SQL 条件，
 * 从而让筛选与分页都下推到数据库执行 —— 数据量再大也不会把全表读进内存。
 *   未闭环 → status <> 'closed'
 *   逾期   → status <> 'closed' AND plan_deadline < 今天
 * 这与 rowToHazard() 的派生逻辑保持一致（列表状态、筛选、统计三处同口径）。
 *
 * @returns {{ where: string, params: any[] }} where 恒不为空（无条件时为 "TRUE"）
 */
function buildHazardWhere(q, today) {
  const conds = [];
  const params = [];
  /** 追加一个条件；sql 中的 ? 会被自动替换为对应的 $n 占位符 */
  const add = (sql, val) => {
    params.push(val);
    conds.push(sql.replace("?", `$${params.length}`));
  };

  const level = q.get("level");
  if (level) add("level = ?", level);

  const category = q.get("category");
  if (category) add("category = ?", category);

  // 「部门/单位」筛选：依据是**整改责任人所属部门**。
  // 用子查询而不是 JOIN —— 列表 / 计数 / 导出共用同一个 where 片段，
  // 子查询不需要给表起别名，四处调用点都不用改。
  const department = (q.get("department") || "").trim();
  if (department) {
    add("rectify_user_id IN (SELECT id FROM users WHERE department = ?)", department);
  }

  const status = q.get("status");
  // 列表筛选对外只有三种口径（见前端 STATUS_FILTER_LABELS）：
  //   已验收 = closed ／ 未验收 = 非 closed ／ 逾期 = 非 closed 且过了计划时限
  if (status === "unclosed") conds.push("status <> 'closed'");
  else if (status === "overdue") add("(status <> 'closed' AND plan_deadline < ?)", today);
  else if (status) add("status = ?", status);

  const dateFrom = q.get("dateFrom");
  if (dateFrom) add("inspect_date >= ?", dateFrom);
  const dateTo = q.get("dateTo");
  if (dateTo) add("inspect_date <= ?", dateTo);

  const keyword = (q.get("keyword") || "").trim();
  if (keyword) {
    params.push(`%${keyword}%`);
    const n = params.length;   // 同一个占位符复用 5 次
    conds.push(`(hazard_code ILIKE $${n} OR description ILIKE $${n} OR location ILIKE $${n}`
      + ` OR inspector ILIKE $${n} OR rectify_person ILIKE $${n})`);
  }

  // 按 id 精确圈定（用于「导出选中」「批量操作」）
  const ids = (q.get("ids") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length) {
    params.push(ids);
    conds.push(`id = ANY($${params.length})`);
  }

  return { where: conds.length ? conds.join(" AND ") : "TRUE", params };
}

/**
 * 数据库行 → 前端隐患对象（camelCase）。
 * ★ 核心：status 在此处派生 —— 未闭环且已过计划完成时限 → "overdue"。
 *   因为列表、筛选、统计都基于同一份数据做同样判断，所以三处口径必然一致。
 * @param today 本地时区今天（由调用方传入，保证同一次请求内基准一致）
 */
function rowToHazard(r, today) {
  const status = r.status !== "closed" && r.plan_deadline < today ? "overdue" : r.status;
  return {
    id: r.id,
    hazardCode: r.hazard_code,
    inspectDate: r.inspect_date,
    inspector: r.inspector,
    location: r.location,
    description: r.description,
    category: r.category,
    level: r.level,
    rectifyMeasure: r.rectify_measure,
      rectifyPerson: r.rectify_person,
      rectifyUserId: r.rectify_user_id ?? null,
      rectifyFund: r.rectify_fund == null || String(r.rectify_fund).trim() === ""
        ? "" : String(Number(r.rectify_fund)),   // NUMERIC 会带 .00，转成干净的数字串
    planDeadline: r.plan_deadline,
    emergencyPlan: r.emergency_plan ?? null,
    status,
    actualCompleteDate: r.actual_complete_date ?? null,
    reviewer: r.reviewer ?? null,
    reviewerUserId: r.reviewer_user_id ?? null,
    reviewDate: r.review_date ?? null,
    reviewResult: r.review_result ?? null,
    closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null,
    hazardPhotos: parsePhotos(r.hazard_photos),
    rectifyPhotos: parsePhotos(r.rectify_photos),
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
function rowToUser(r) {
  return {
    id: r.id, userId: r.user_id, userName: r.user_name, role: r.role, department: r.department || "",
    mustChangePassword: Boolean(r.must_change_password),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

module.exports = {
  parsePhotos,
  MAX_PHOTOS,
  normalizePhotos,
  buildHazardWhere,
  rowToHazard,
  rowToUser,
};
