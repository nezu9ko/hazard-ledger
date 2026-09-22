/**
 * ============================================================================
 *  隐患治理台账系统 — 本地服务端（Node.js 原生 HTTP + PostgreSQL）
 * ============================================================================
 *
 * 【运行环境】
 *   - Node.js >= 22（无框架，仅使用内置模块 + `pg` 驱动）
 *   - PostgreSQL >= 12（首次启动自动建库、建表、播种默认管理员）
 *
 * 【依赖】
 *   仅 `pg`（node-postgres）。`npm install` 后即可运行，无需构建。
 *
 * 【启动方式】
 *   node server.js   或   start.bat（前台）/ 计划任务 HazardLedger（后台自启）
 *
 * 【整体架构】
 *   静态前端（public/）  ──HTTP──▶  本文件（API + 静态托管）  ──SQL──▶  PostgreSQL
 *                                              │
 *                                              └── 图片文件落盘（uploads/）
 *
 * 【代码结构导航】
 *   1. 配置加载            loadConfig()              端口 / 数据库连接（环境变量 > config.json > 默认）
 *   2. 通用工具            sendJson / readBody / 日期与散列工具
 *   3. 领域模型            rowToHazard / rowToUser / parsePhotos（数据库行 ↔ 前端 JSON）
 *   4. 会话鉴权            createSession / getSessionUser / bearerToken（服务端令牌）
 *   5. 权限矩阵            requiredRoles(方法, 路径)  声明式角色要求
 *   6. 操作日志            logOp()                  所有写操作留痕
 *   7. 数据库初始化        initDatabase()            建库 + 建表 + 播种 admin
 *   8. 业务处理器          handleAuth / handleUsers / handleHazards / handleStats /
 *                          handleExport / handleUpload / handlePhotosMaintenance /
 *                          handleLogs / handleReminders / handleSeed
 *   9. HTTP 服务           路由分发（先鉴权，再分发）+ 静态文件 + 上传目录托管
 *  10. 启动与优雅退出
 *
 * 【关键设计约定】
 *   - 日期一律使用「本地时区」字符串 YYYY-MM-DD（localDateStr），
 *     避免 toISOString() 的 UTC 偏移导致"逾期"口径差一天。
 *   - 隐患状态是**派生**的：数据库只存 pending / rectifying / closed，
 *     "逾期(overdue)" 由 rowToHazard() 依据 planDeadline 与今天比较实时得出，
 *     因此列表、筛选、统计三处天然一致。
 *   - 所有 API（除 /api/health 与 /api/auth）都必须携带
 *     `Authorization: Bearer <token>`，否则 401；角色不符 403。
 *   - 隐患编号 YH-YYYYMMDD-NNNN 由 `counters` 表 UPSERT 原子取号，避免并发撞号。
 *   - 照片存于 uploads/，数据库只存相对路径数组（JSON 字符串），
 *     且仅接受本站 /uploads/ 前缀，防止外链与路径注入。
 * ============================================================================
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Client, Pool } = require("pg");

/* ---------------- 配置 ----------------
 * 优先级：环境变量 > config.json > 内置默认值。
 * 这样既能用 config.json 做本地部署配置，也方便在 CI/容器里用环境变量覆盖。
 */
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const CONFIG_FILE = path.join(ROOT, "config.json");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function loadConfig() {
  const defaults = {
    port: 3000,
    host: "0.0.0.0",
    // 公司名称：仅存于 config.json（已被 .gitignore 排除），不会出现在版本库里。
    // 服务端通过 /api/app-info 下发给前端显示；留空则前端不显示。
    companyName: "",
    db: { host: "127.0.0.1", port: 5432, user: "postgres", password: "", database: "hazard_ledger" },
  };
  let fileCfg = {};
  try { fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { /* 首次运行无配置 */ }
  const cfg = { ...defaults, ...fileCfg, db: { ...defaults.db, ...(fileCfg.db || {}) } };
  // 环境变量优先
  cfg.port = Number(process.env.PORT || cfg.port);
  cfg.host = process.env.HOST || cfg.host;
  cfg.db.host = process.env.PGHOST || cfg.db.host;
  cfg.db.port = Number(process.env.PGPORT || cfg.db.port);
  cfg.db.user = process.env.PGUSER || cfg.db.user;
  cfg.db.password = process.env.PGPASSWORD || cfg.db.password;
  cfg.db.database = process.env.PGDATABASE || cfg.db.database;
  return cfg;
}
const CFG = loadConfig();

/* 业务枚举（与前端 script.js 中的 LABELS 映射表一一对应）
 * 这些值是写入数据库的"机器码"，改动需同步前端与既有数据 */
const DEFAULT_INITIAL_PASSWORD = "123456";                                              // 新建用户的初始密码（首次登录强制修改）
const LEVELS = ["major", "serious", "general", "minor"];                                // 隐患等级：重大/较大/一般/轻微
const CATEGORIES = ["equipment", "operation", "fire", "electrical", "environment", "management"]; // 隐患类别
const STATUSES = ["pending", "rectifying", "closed"];                                   // 数据库可存的三种状态（overdue 为派生状态，不入库）
const ROLES = ["entry", "safety_admin", "reviewer", "admin"];                           // 四种角色

/* ---------------- 工具 ---------------- */
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
/** 口令散列：SHA-256(salt::password)。
 *  说明：这是轻量实现（非 bcrypt/argon2），对局域网内部系统够用；
 *  若未来暴露到公网，建议替换为 scrypt/bcrypt。 */
const hashPassword = (pwd, salt) => sha256(`${salt}::${pwd}`);
/** 生成 24 位十六进制随机 ID（用于主键、文件名、会话令牌等，碰撞概率极低） */
const genId = () => crypto.randomBytes(12).toString("hex");

/** 本地时区日期字符串 YYYY-MM-DD。
 *  ⚠️ 全系统日期口径统一走这里，绝不要用 toISOString().slice(0,10)（那是 UTC，东八区会差一天） */
function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
/** 相对今天偏移 N 天的本地日期（仅演示数据使用） */
function shiftDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localDateStr(d);
}

/** 统一 JSON 响应：显式声明 charset，避免中文在部分客户端乱码 */
function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json;charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
/** 400 快捷响应（注意签名是 (res, message)，切勿漏传 res） */
const badRequest = (res, message) => sendJson(res, { error: { code: "BAD_REQUEST", message } }, 400);
/** 404 快捷响应 */
const notFound = (res, message = "资源不存在") => sendJson(res, { error: { code: "NOT_FOUND", message } }, 404);

/** 读取并解析 JSON 请求体。
 *  @param maxBytes 体积上限（默认 2MB；图片上传接口会传入更大的值），
 *                  超限立即断开连接，防止内存被打满 */
function readBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = ""; let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error("请求体过大")); req.destroy(); return; }
      raw += c;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error("请求体格式错误")); }
    });
    req.on("error", reject);
  });
}

/* ---------------- 领域模型（数据库行 ↔ 前端 JSON） ---------------- */

/**
 * 解析数据库里存的照片字段（TEXT，内容为 JSON 数组字符串）。
 * 只保留形如 /uploads/xxx 的本站路径，其余（外链、路径穿越等）一律丢弃。
 */
function parsePhotos(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string" && /^\/uploads\/[A-Za-z0-9._-]+$/.test(x)) : [];
  } catch { return []; }
}

/**
 * 校验并归一化「前端提交的照片数组」：白名单前缀 + 去重 + 上限张数。
 * 这是防止"外链图片/路径注入"写入数据库的关键闸门。
 * @param max 每个字段最多保留的张数（默认 6）
 */
function normalizePhotos(input, max = 6) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const x of input) {
    if (typeof x !== "string") continue;
    if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(x)) continue;
    if (!out.includes(x)) out.push(x);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 状态筛选匹配。
 * 支持伪状态 `unclosed`（未闭环 = 非 closed）——看板"未闭环数"点击跳转时使用。
 * 其余状态与 hazards.status 精确匹配。
 */
function matchStatus(h, status) {
  if (!status) return true;
  if (status === "unclosed") return h.status !== "closed";
  return h.status === status;
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
    rectifyFund: r.rectify_fund == null ? "0" : String(r.rectify_fund),
    planDeadline: r.plan_deadline,
    emergencyPlan: r.emergency_plan ?? null,
    status,
    actualCompleteDate: r.actual_complete_date ?? null,
    reviewer: r.reviewer ?? null,
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
    id: r.id, userId: r.user_id, userName: r.user_name, role: r.role,
    mustChangePassword: Boolean(r.must_change_password),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

/* ---------------- 会话（服务端令牌鉴权） ----------------
 * 为什么用「Bearer 令牌 + sessions 表」而不是 Cookie？
 *  - 令牌放在请求头里，天然免疫 CSRF（浏览器不会自动携带）；
 *  - 前后端同源部署时也无需处理 Cookie 的 SameSite/跨域问题。
 * 令牌本身是 24 字节随机数，数据库只存明文令牌（局域网内部系统，够用）。
 */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

/** 登录成功后签发会话令牌，并顺手清理已过期会话（顺带做垃圾回收） */
async function createSession(userId) {
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query("INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)", [token, userId, expiresAt]);
  // 顺手清理过期会话
  await pool.query("DELETE FROM sessions WHERE expires_at <= NOW()");
  return token;
}
/** 按令牌取用户；令牌不存在或已过期返回 null（调用方据此返回 401） */
async function getSessionUser(token) {
  if (!token) return null;
  const r = await pool.query(
    "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1 AND s.expires_at > NOW()",
    [token]
  );
  return r.rows[0] || null;
}
async function destroySession(token) {
  if (token) await pool.query("DELETE FROM sessions WHERE token = $1", [token]);
}
/** 从 `Authorization: Bearer xxx` 请求头中取出令牌（无则返回空串） */
function bearerToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

/* ---------------- 操作日志 ----------------
 * 所有"写操作"都会调用 logOp 留痕，用于事后追溯「谁在何时做了什么」。
 * 日志动作表（ACTION_LABELS）同时也是前端筛选下拉的数据源。
 * 写日志失败只打印错误、绝不影响主流程（见 logOp 内部 try/catch）。
 */
const ACTION_LABELS = {
  login: "登录系统",
  create_hazard: "登记隐患",
  update_hazard: "修改隐患",
  start_rectify: "开始整改",
  review_hazard: "复查闭环",
  delete_hazard: "删除隐患",
  create_user: "新增用户",
  update_user_role: "修改角色",
  reset_password: "重置密码",
  delete_user: "删除用户",
  export_hazard: "导出隐患台账",
  cleanup_photos: "清理无引用图片",
};
async function logOp(user, action, opts = {}) {
  try {
    await pool.query(
      `INSERT INTO operation_log (id,user_id,user_name,action,target_type,target_id,target_code,detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [genId(), user?.id || null, user?.user_name || user?.userName || null, action,
        opts.targetType || null, opts.targetId || null, opts.targetCode || null, opts.detail || null]
    );
  } catch (err) {
    console.error("[LOG] 写操作日志失败:", err.message);
  }
}

/* ---------------- 权限矩阵 ----------------
 * 声明式权限：返回 null 表示「任意已登录用户即可」；
 * 返回角色数组表示「必须命中其中之一」，否则 403。
 * 注意：鉴权总闸在 HTTP 服务路由分发处（见文件末尾），
 *       这里只负责"哪种角色能做什么"。
 */
function requiredRoles(method, path) {
  // 用户管理（仅系统管理员）
  if (path === "/api/users") {
    if (method === "GET") return ["admin"];
    if (method === "POST") return ["admin"];
  }
  if (path.startsWith("/api/users/")) return ["admin"];
  // 隐患
  if (path === "/api/hazards") {
    if (method === "POST") return ["entry", "safety_admin", "admin"];
    return null; // GET 列表：任意已登录用户
  }
  if (path.startsWith("/api/hazards/")) {
    // 具体动作（复查 / 开始整改 / 字段修改）在 handler 内按角色细分
    if (method === "GET") return null;
    return ["entry", "reviewer", "safety_admin", "admin"];
  }
  // 统计
  if (path === "/api/stats") return null;
  if (path === "/api/seed") return ["admin"];
  // 操作日志（仅系统管理员）
  if (path === "/api/logs") return ["admin"];
  // 图片维护（仅系统管理员）
  if (path === "/api/photos") return ["admin"];
  // 导出
  if (path === "/api/export") return null;
  return null;
}

/* ---------------- 表 / 字段的中文注释 ----------------
 * 目的：让 DBeaver、psql 等工具**直接显示中文含义**，不必再对照文档查英文列名。
 * 实现：用 COMMENT ON 写入 PostgreSQL 系统目录，**幂等**——
 *      每次启动同步一遍，改动这里的文案后重启服务即可生效。
 * 格式：[对象类型, 表名, 列名(表级注释填 null), 注释内容]
 */
const SCHEMA_COMMENTS = [
  // ---------- hazard 隐患台账主表 ----------
  ["TABLE", "hazard", null, "隐患台账主表（排查发现 → 登记上报 → 整改实施 → 复查验收 → 闭环销号）"],
  ["COLUMN", "hazard", "id", "主键ID（随机24位十六进制）"],
  ["COLUMN", "hazard", "hazard_code", "隐患编号，格式 YH-YYYYMMDD-NNNN（按登记日期自动取号，不撞号）"],
  ["COLUMN", "hazard", "inspect_date", "排查日期 YYYY-MM-DD"],
  ["COLUMN", "hazard", "inspector", "排查人"],
  ["COLUMN", "hazard", "location", "隐患部位 / 地点"],
  ["COLUMN", "hazard", "description", "隐患描述"],
  ["COLUMN", "hazard", "category", "隐患类别：equipment设备设施 / operation作业行为 / fire消防安全 / electrical电气安全 / environment环境安全 / management安全管理"],
  ["COLUMN", "hazard", "level", "隐患等级：major重大 / serious较大 / general一般 / minor轻微"],
  ["COLUMN", "hazard", "rectify_measure", "整改措施"],
  ["COLUMN", "hazard", "rectify_person", "整改责任人"],
  ["COLUMN", "hazard", "rectify_fund", "整改资金（单位：元）"],
  ["COLUMN", "hazard", "plan_deadline", "计划完成日期；未闭环且已过此日期即判为「逾期」（逾期是实时计算的派生状态，不落库）"],
  ["COLUMN", "hazard", "emergency_plan", "应急预案"],
  ["COLUMN", "hazard", "status", "状态：pending待整改 / rectifying整改中 / closed已闭环"],
  ["COLUMN", "hazard", "actual_complete_date", "实际完成整改的日期"],
  ["COLUMN", "hazard", "reviewer", "复查（验收）人"],
  ["COLUMN", "hazard", "review_date", "复查日期"],
  ["COLUMN", "hazard", "review_result", "复查意见"],
  ["COLUMN", "hazard", "closed_at", "闭环时间（看板「闭环耗时」= closed_at − created_at）"],
  ["COLUMN", "hazard", "created_at", "创建（登记入库）时间"],
  ["COLUMN", "hazard", "updated_at", "最后更新时间"],
  ["COLUMN", "hazard", "hazard_photos", "隐患照片路径数组（JSON 字符串，元素形如 /uploads/xxx.jpg，最多6张）"],
  ["COLUMN", "hazard", "rectify_photos", "整改照片路径数组（JSON 字符串，最多6张）"],

  // ---------- users 用户表 ----------
  ["TABLE", "users", null, "用户账号表"],
  ["COLUMN", "users", "id", "主键ID"],
  ["COLUMN", "users", "user_id", "登录账号（唯一）"],
  ["COLUMN", "users", "user_name", "用户姓名（唯一，操作日志中显示的就是它）"],
  ["COLUMN", "users", "role", "角色：entry录入人员 / reviewer复查人员 / safety_admin安全管理员 / admin系统管理员"],
  ["COLUMN", "users", "salt", "口令盐值（随机24位十六进制）"],
  ["COLUMN", "users", "password_hash", "口令散列值 = SHA-256(salt::明文口令)"],
  ["COLUMN", "users", "must_change_password", "是否强制修改密码（新建用户、重置密码后为 true，首次登录须改密）"],
  ["COLUMN", "users", "created_at", "创建时间"],

  // ---------- operation_log 操作日志表 ----------
  ["TABLE", "operation_log", null, "操作日志表（所有写操作留痕，用于事后追溯「谁在何时做了什么」）"],
  ["COLUMN", "operation_log", "id", "主键ID"],
  ["COLUMN", "operation_log", "user_id", "操作人ID"],
  ["COLUMN", "operation_log", "user_name", "操作人姓名"],
  ["COLUMN", "operation_log", "action", "操作类型：login登录 / create_hazard登记 / update_hazard修改 / start_rectify开始整改 / review_hazard复查闭环 / delete_hazard删除 / create_user新增用户 / update_user_role改角色 / reset_password重置密码 / delete_user删除用户 / export_hazard导出 / cleanup_photos清理图片"],
  ["COLUMN", "operation_log", "target_type", "操作对象类型（如 hazard 隐患 / user 用户）"],
  ["COLUMN", "operation_log", "target_id", "操作对象ID"],
  ["COLUMN", "operation_log", "target_code", "操作对象编号（如隐患编号 YH-YYYYMMDD-NNNN）"],
  ["COLUMN", "operation_log", "detail", "操作详情（如「状态：待整改 → 整改中」）"],
  ["COLUMN", "operation_log", "created_at", "操作时间"],

  // ---------- sessions 会话表 ----------
  ["TABLE", "sessions", null, "登录会话表（服务端令牌鉴权，令牌放于 Authorization: Bearer 请求头）"],
  ["COLUMN", "sessions", "token", "会话令牌（主键，随机24字节十六进制）"],
  ["COLUMN", "sessions", "user_id", "所属用户ID"],
  ["COLUMN", "sessions", "created_at", "令牌签发时间"],
  ["COLUMN", "sessions", "expires_at", "过期时间（默认签发后 7 天；清理此表可强制所有人重新登录）"],

  // ---------- counters 编号计数器 ----------
  ["TABLE", "counters", null, "隐患编号计数器（按登记日期原子取号，避免并发撞号）"],
  ["COLUMN", "counters", "date_part", "日期 YYYYMMDD"],
  ["COLUMN", "counters", "n", "该日期已发放的编号数量（下一个编号 = n + 1）"],
];

/** SQL 字符串字面量转义（COMMENT 是工具命令，无法用 $1 占位符） */
const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** 把所有表 / 字段注释同步到数据库（幂等，可重复执行） */
async function applySchemaComments() {
  for (const [kind, table, col, text] of SCHEMA_COMMENTS) {
    const sql = kind === "TABLE"
      ? `COMMENT ON TABLE ${table} IS ${sq(text)}`
      : `COMMENT ON COLUMN ${table}.${col} IS ${sq(text)}`;
    await pool.query(sql);
  }
  console.log(`[DB] 已同步 ${SCHEMA_COMMENTS.length} 条表/字段中文注释`);
}

/* ---------------- 数据库初始化 ----------------
 * 幂等：可重复执行。流程
 *   ① 先用维护库 postgres 连上去，若目标库不存在则 CREATE DATABASE；
 *   ② 切换到目标库建表（IF NOT EXISTS）+ 补列（ALTER ... ADD COLUMN IF NOT EXISTS，
 *      用于兼容早期版本已存在的库）；
 *   ③ 同步表 / 字段的中文注释（见上方 SCHEMA_COMMENTS）；
 *   ④ 若 users 表为空则播种默认管理员 admin / 123456。
 */
async function initDatabase() {
  // 1) 自动建库（连到 postgres 维护库）
  const admin = new Client({ ...CFG.db, database: "postgres" });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [CFG.db.database]);
  if (exists.rowCount === 0) {
    await admin.query(`CREATE DATABASE "${CFG.db.database}"`);
    console.log(`[DB] 已创建数据库 ${CFG.db.database}`);
  }
  await admin.end();

  // 2) 建表
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hazard (
      id TEXT PRIMARY KEY,
      hazard_code TEXT NOT NULL UNIQUE,
      inspect_date TEXT NOT NULL,
      inspector TEXT NOT NULL,
      location TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      level TEXT NOT NULL,
      rectify_measure TEXT NOT NULL,
      rectify_person TEXT NOT NULL,
      rectify_fund NUMERIC(14,2) NOT NULL DEFAULT 0,
      plan_deadline TEXT NOT NULL,
      emergency_plan TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      actual_complete_date TEXT,
      reviewer TEXT,
      review_date TEXT,
      review_result TEXT,
      closed_at TIMESTAMPTZ,
      hazard_photos TEXT,
      rectify_photos TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE hazard ADD COLUMN IF NOT EXISTS hazard_photos TEXT;
    ALTER TABLE hazard ADD COLUMN IF NOT EXISTS rectify_photos TEXT;
    CREATE INDEX IF NOT EXISTS idx_hazard_status ON hazard(status);
    CREATE INDEX IF NOT EXISTS idx_hazard_inspect_date ON hazard(inspect_date);
    CREATE INDEX IF NOT EXISTS idx_hazard_plan_deadline ON hazard(plan_deadline);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      user_name TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS counters (
      date_part TEXT PRIMARY KEY,
      n INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operation_log (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      user_name TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      target_code TEXT,
      detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_oplog_created ON operation_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_oplog_target ON operation_log(target_id);
  `);

  // 3) 写入表 / 字段中文注释（幂等，每次启动同步一遍）
  await applySchemaComments();

  // 4) 播种默认管理员
  const c = await pool.query("SELECT COUNT(*)::int AS c FROM users");
  if (c.rows[0].c === 0) {
    const salt = genId();
    await pool.query(
      "INSERT INTO users (id,user_id,user_name,role,salt,password_hash,must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [genId(), "u_admin", "admin", "admin", salt, hashPassword(DEFAULT_INITIAL_PASSWORD, salt), false]
    );
    console.log("[DB] 已创建默认管理员 admin / 123456");
  }
}

const pool = new Pool(CFG.db);

/* ---------------- 业务处理 ----------------
 * 每个 handler 都遵循同一约定：
 *   - 入参 user 为当前登录用户（由路由分发处的鉴权总闸注入）；
 *   - 内部会做更细粒度的角色判断（比 requiredRoles 更精确，例如"复查"vs"修改内容"）；
 *   - 所有写操作都会调用 logOp() 留痕；
 *   - 参数校验失败一律返回 400，且提示文案面向业务人员。
 */

/** 登录 / 登出 / 会话查询 / 修改密码 */
async function handleAuth(req, res, url) {
  if (req.method !== "POST") return sendJson(res, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持的方法" } }, 405);
  const action = url.searchParams.get("action") || "";
  let body;
  try { body = await readBody(req); } catch (e) { return badRequest(res, e.message); }

  if (action === "login") {
    const userName = String(body.userName || "").trim();
    const password = String(body.password || "");
    if (!userName || !password) return badRequest(res, "账号或密码错误");
    const r = await pool.query("SELECT * FROM users WHERE user_name = $1", [userName]);
    const u = r.rows[0];
    if (!u || hashPassword(password, u.salt) !== u.password_hash) return badRequest(res, "账号或密码错误");
    const token = await createSession(u.id);
    await logOp({ id: u.id, user_name: u.user_name }, "login", { targetType: "user", targetId: u.id, targetCode: u.user_name, detail: `角色：${u.role}` });
    return sendJson(res, {
      success: true,
      token,
      user: { id: u.id, userId: u.user_id, userName: u.user_name, role: u.role, createdAt: new Date(u.created_at).toISOString() },
      mustChangePassword: Boolean(u.must_change_password),
    });
  }

  if (action === "logout") {
    await destroySession(bearerToken(req));
    return sendJson(res, { success: true });
  }

  if (action === "session") {
    const u = await getSessionUser(bearerToken(req));
    if (!u) return sendJson(res, { loggedIn: false, user: null, mustChangePassword: false });
    return sendJson(res, {
      loggedIn: true,
      user: { id: u.id, userId: u.user_id, userName: u.user_name, role: u.role, createdAt: new Date(u.created_at).toISOString() },
      mustChangePassword: Boolean(u.must_change_password),
    });
  }

  if (action === "change-password") {
    const { id, oldPassword, newPassword } = body;
    if (!id || !oldPassword || !newPassword) return badRequest(res, "参数不完整");
    if (String(newPassword).length < 6) return badRequest(res, "新密码至少6位");
    const r = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
    const u = r.rows[0];
    if (!u) return notFound(res, "用户不存在");
    if (hashPassword(String(oldPassword), u.salt) !== u.password_hash) return badRequest(res, "旧密码错误");
    const salt = genId();
    await pool.query("UPDATE users SET salt=$1, password_hash=$2, must_change_password=FALSE WHERE id=$3",
      [salt, hashPassword(String(newPassword), salt), id]);
    return sendJson(res, { success: true });
  }
  return notFound(res, "未知操作");
}

/**
 * 用户管理（仅系统管理员 admin 可访问，见 requiredRoles）。
 *   GET    /api/users        列表
 *   POST   /api/users        新增（初始密码 123456，首次登录强制修改；姓名唯一）
 *   DELETE /api/users/:id    删除
 *   PATCH  /api/users/:id    改角色；`{action:"reset-password"}` 重置为初始密码
 * 注意：DEFAULT_INITIAL_PASSWORD 为全局初始密码，重置后 must_change_password=true。
 */
async function handleUsers(req, res, url, id, user) {
  if (!id) {
    if (req.method === "GET") {
      const r = await pool.query("SELECT * FROM users ORDER BY created_at ASC");
      return sendJson(res, r.rows.map(rowToUser));
    }
    if (req.method === "POST") {
      let body;
      try { body = await readBody(req); } catch (e) { return badRequest(res, e.message); }
      const userName = String(body.userName || "").trim();
      if (!userName) return badRequest(res, "请输入用户姓名");
      if (userName.length > 100) return badRequest(res, "用户姓名过长");
      if (!ROLES.includes(body.role)) return badRequest(res, "角色非法");
      const dup = await pool.query("SELECT 1 FROM users WHERE user_name = $1", [userName]);
      if (dup.rowCount > 0) return badRequest(res, "用户姓名已存在");
      const salt = genId(); const uid = genId(); const userId = body.userId || `u_${Date.now()}`;
      await pool.query(
        "INSERT INTO users (id,user_id,user_name,role,salt,password_hash,must_change_password) VALUES ($1,$2,$3,$4,$5,$6,TRUE)",
        [uid, userId, userName, body.role, salt, hashPassword(DEFAULT_INITIAL_PASSWORD, salt)]
      );
      const created = await pool.query("SELECT * FROM users WHERE id = $1", [uid]);
      await logOp(user, "create_user", { targetType: "user", targetId: uid, targetCode: userName, detail: `角色：${body.role}` });
      return sendJson(res, rowToUser(created.rows[0]), 201);
    }
    return sendJson(res, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持的方法" } }, 405);
  }

  const found = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
  if (found.rowCount === 0) return notFound(res, "用户不存在");

  if (req.method === "DELETE") {
    await pool.query("DELETE FROM users WHERE id = $1", [id]);
    await logOp(user, "delete_user", { targetType: "user", targetId: id, targetCode: found.rows[0].user_name, detail: `角色：${found.rows[0].role}` });
    return sendJson(res, { success: true });
  }
  if (req.method === "PATCH") {
    let body;
    try { body = await readBody(req); } catch (e) { return badRequest(res, e.message); }
    if (body.action === "reset-password") {
      const salt = genId();
      await pool.query("UPDATE users SET salt=$1, password_hash=$2, must_change_password=TRUE WHERE id=$3",
        [salt, hashPassword(DEFAULT_INITIAL_PASSWORD, salt), id]);
      await logOp(user, "reset_password", { targetType: "user", targetId: id, targetCode: found.rows[0].user_name, detail: "重置为初始密码" });
      return sendJson(res, { success: true });
    }
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role)) return badRequest(res, "角色非法");
      const r = await pool.query("UPDATE users SET role=$1 WHERE id=$2 RETURNING *", [body.role, id]);
      await logOp(user, "update_user_role", { targetType: "user", targetId: id, targetCode: found.rows[0].user_name, detail: `角色：${found.rows[0].role} → ${body.role}` });
      return sendJson(res, rowToUser(r.rows[0]));
    }
    return badRequest(res, "未提供可更新字段");
  }
  return sendJson(res, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持的方法" } }, 405);
}

/**
 * 统计看板数据。一次性返回前端所需的全部聚合结果：
 *   - 概览：total / unclosed / overdue / completionRate
 *   - byLevel    等级分布（环形图）
 *   - byCategory 类别分布（条形图）
 *   - monthlyTrend 近 12 个月的新增/闭环条数（双折线，带数值标注）
 *   - closureDist  闭环耗时分布 [{days, count}]（柱状图：横轴耗时天数、纵轴隐患条数）
 * overdue 与 rowToHazard 使用同一判定逻辑（未闭环且已过时限），保证与列表口径一致。
 */
async function handleStats(res) {
  const today = localDateStr();
  const r = await pool.query("SELECT * FROM hazard");
  const all = r.rows;
  const total = all.length;
  const closed = all.filter((h) => h.status === "closed").length;
  const overdue = all.filter((h) => h.status !== "closed" && h.plan_deadline < today).length;
  const completionRate = total === 0 ? 0 : Math.round((closed / total) * 1000) / 10;

  const levelMap = {}; const catMap = {};
  for (const h of all) {
    levelMap[h.level] = (levelMap[h.level] || 0) + 1;
    catMap[h.category] = (catMap[h.category] || 0) + 1;
  }
  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  const newMap = {}; const closedMap = {};
  for (const h of all) {
    const nm = (h.inspect_date || "").slice(0, 7);
    if (nm) newMap[nm] = (newMap[nm] || 0) + 1;
    if (h.status === "closed" && h.closed_at) {
      const cm = new Date(h.closed_at).toISOString().slice(0, 7);
      closedMap[cm] = (closedMap[cm] || 0) + 1;
    }
  }
  // 闭环时长分布：横轴=耗时天数，纵轴=隐患条数
  const distMap = {};
  for (const h of all) {
    if (h.status !== "closed" || !h.closed_at) continue;
    const days = Math.max(0, Math.round((new Date(h.closed_at).getTime() - new Date(h.created_at).getTime()) / 86400000));
    distMap[days] = (distMap[days] || 0) + 1;
  }
  const closureDist = Object.keys(distMap).map(Number).sort((a, b) => a - b)
    .map((days) => ({ days, count: distMap[days] }));

  return sendJson(res, {
    total, unclosed: total - closed, overdue, completionRate,
    byLevel: LEVELS.map((level) => ({ level, count: levelMap[level] || 0 })),
    byCategory: CATEGORIES.map((category) => ({ category, count: catMap[category] || 0 })),
    monthlyTrend: months.map((month) => ({ month, newCount: newMap[month] || 0, closedCount: closedMap[month] || 0 })),
    closureDist,
  });
}

/**
 * 隐患台账核心接口。id 为空时操作"集合"，否则操作"单条"。
 *   GET    /api/hazards              列表（筛选 + 分页，任意登录用户）
 *   POST   /api/hazards              登记（entry / safety_admin / admin）
 *   GET    /api/hazards/:id          详情（任意登录用户）
 *   PATCH  /api/hazards/:id          见下方三个分支
 *   DELETE /api/hazards/:id          删除（safety_admin / admin）
 *
 * PATCH 的三个分支（通过 body.action 区分）：
 *   - action:"review"         复查闭环 → 要求先处于「整改中」
 *   - action:"start-rectify"  开始整改 → 待整改 → 整改中
 *   - 其余为普通字段修改（仅 safety_admin / admin）
 * 列表筛选支持伪状态 unclosed（未闭环）；编号取号使用 UPSERT 原子自增。
 */
async function handleHazards(req, res, url, id, user) {
  const today = localDateStr();

  if (!id) {
    if (req.method === "GET") {
      const q = url.searchParams;
      const page = Math.max(1, Number(q.get("page")) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(q.get("pageSize")) || 10));
      const r = await pool.query("SELECT * FROM hazard");
      let rows = r.rows.map((x) => rowToHazard(x, today));
      const level = q.get("level"); const category = q.get("category"); const status = q.get("status");
      const dateFrom = q.get("dateFrom"); const dateTo = q.get("dateTo");
      const keyword = (q.get("keyword") || "").trim().toLowerCase();
      if (level) rows = rows.filter((h) => h.level === level);
      if (category) rows = rows.filter((h) => h.category === category);
      if (status) rows = rows.filter((h) => matchStatus(h, status));
      if (dateFrom) rows = rows.filter((h) => h.inspectDate >= dateFrom);
      if (dateTo) rows = rows.filter((h) => h.inspectDate <= dateTo);
      if (keyword) rows = rows.filter((h) => [h.hazardCode, h.description, h.location, h.inspector, h.rectifyPerson].join(" ").toLowerCase().includes(keyword));
      rows.sort((a, b) => (b.inspectDate || "").localeCompare(a.inspectDate || "") || (b.createdAt || "").localeCompare(a.createdAt || ""));
      const total = rows.length;
      const start = (page - 1) * pageSize;
      return sendJson(res, { items: rows.slice(start, start + pageSize), total, page, pageSize });
    }

    if (req.method === "POST") {
      let body;
      try { body = await readBody(req); } catch (e) { return badRequest(res, e.message); }
      const required = ["inspectDate", "inspector", "location", "description", "category", "level", "rectifyMeasure", "rectifyPerson", "rectifyFund", "planDeadline"];
      for (const k of required) {
        if (body[k] === undefined || body[k] === null || String(body[k]).trim() === "") return badRequest(res, `字段 ${k} 不能为空`);
      }
      if (!LEVELS.includes(body.level)) return badRequest(res, "隐患等级非法");
      if (!CATEGORIES.includes(body.category)) return badRequest(res, "隐患类别非法");
      const fund = Number(body.rectifyFund);
      if (isNaN(fund) || fund < 0) return badRequest(res, "整改资金格式错误");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.inspectDate)) return badRequest(res, "排查日期格式错误");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.planDeadline)) return badRequest(res, "计划完成时限格式错误");

      const datePart = today.replace(/-/g, "");
      // 原子取号（UPSERT ... RETURNING）
      const seqRes = await pool.query(
        "INSERT INTO counters (date_part, n) VALUES ($1, 1) ON CONFLICT (date_part) DO UPDATE SET n = counters.n + 1 RETURNING n",
        [datePart]
      );
      const hazardCode = `YH-${datePart}-${String(seqRes.rows[0].n).padStart(4, "0")}`;

      const newId = genId();
      const hazardPhotos = normalizePhotos(body.hazardPhotos);
      const rectifyPhotos = normalizePhotos(body.rectifyPhotos);
      await pool.query(
        `INSERT INTO hazard (id,hazard_code,inspect_date,inspector,location,description,category,level,
          rectify_measure,rectify_person,rectify_fund,plan_deadline,emergency_plan,status,hazard_photos,rectify_photos)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14,$15)`,
        [newId, hazardCode, body.inspectDate, String(body.inspector).trim(), String(body.location).trim(),
          String(body.description).trim(), body.category, body.level, String(body.rectifyMeasure).trim(),
          String(body.rectifyPerson).trim(), String(fund), body.planDeadline,
          body.emergencyPlan ? String(body.emergencyPlan).trim() : null,
          hazardPhotos.length ? JSON.stringify(hazardPhotos) : null,
          rectifyPhotos.length ? JSON.stringify(rectifyPhotos) : null]
      );
      const created = await pool.query("SELECT * FROM hazard WHERE id = $1", [newId]);
      const rec = rowToHazard(created.rows[0], today);
      await logOp(user, "create_hazard", {
        targetType: "hazard", targetId: newId, targetCode: hazardCode,
        detail: `${String(body.location).trim()}｜${String(body.description).trim().slice(0, 40)}`,
      });
      return sendJson(res, rec, 201);
    }
    return sendJson(res, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持的方法" } }, 405);
  }

  const found = await pool.query("SELECT * FROM hazard WHERE id = $1", [id]);
  if (found.rowCount === 0) return notFound(res, "隐患不存在");
  const row = found.rows[0];

  if (req.method === "GET") return sendJson(res, rowToHazard(row, today));

  if (req.method === "DELETE") {
    if (!["safety_admin", "admin"].includes(user.role)) {
      return sendJson(res, { error: { code: "FORBIDDEN", message: "仅安全管理员/系统管理员可删除隐患" } }, 403);
    }
    await pool.query("DELETE FROM hazard WHERE id = $1", [id]);
    await logOp(user, "delete_hazard", { targetType: "hazard", targetId: id, targetCode: row.hazard_code, detail: row.location });
    return sendJson(res, { success: true });
  }

  if (req.method === "PATCH") {
    let body;
    try { body = await readBody(req); } catch (e) { return badRequest(res, e.message); }

    // —— 复查闭环 ——
    if (body.action === "review") {
      if (!["reviewer", "safety_admin", "admin"].includes(user.role)) {
        return sendJson(res, { error: { code: "FORBIDDEN", message: "仅复查人员/安全管理员/系统管理员可执行复查闭环" } }, 403);
      }
      for (const k of ["actualCompleteDate", "reviewer", "reviewDate", "reviewResult"]) {
        if (!body[k] || String(body[k]).trim() === "") return badRequest(res, `字段 ${k} 不能为空`);
      }
      if (row.status === "closed") return badRequest(res, "该隐患已闭环");
      if (row.status === "pending") return badRequest(res, "请先「开始整改」，再进行复查闭环");
      await pool.query(
        `UPDATE hazard SET status='closed', actual_complete_date=$1, reviewer=$2, review_date=$3, review_result=$4,
          closed_at=NOW(), updated_at=NOW() WHERE id=$5`,
        [body.actualCompleteDate, String(body.reviewer).trim(), body.reviewDate, String(body.reviewResult).trim(), id]
      );
      await logOp(user, "review_hazard", { targetType: "hazard", targetId: id, targetCode: row.hazard_code, detail: "复查闭环，验收合格" });
      const updated = await pool.query("SELECT * FROM hazard WHERE id = $1", [id]);
      return sendJson(res, rowToHazard(updated.rows[0], today));
    }

    // —— 开始整改（待整改 → 整改中）——
    if (body.action === "start-rectify") {
      if (!["entry", "safety_admin", "admin"].includes(user.role)) {
        return sendJson(res, { error: { code: "FORBIDDEN", message: "当前角色无权开始整改" } }, 403);
      }
      if (row.status === "closed") return badRequest(res, "该隐患已闭环，无法再整改");
      if (row.status === "rectifying") return badRequest(res, "该隐患已在整改中");
      await pool.query("UPDATE hazard SET status='rectifying', updated_at=NOW() WHERE id=$1", [id]);
      await logOp(user, "start_rectify", { targetType: "hazard", targetId: id, targetCode: row.hazard_code, detail: "状态：待整改 → 整改中" });
      const updated = await pool.query("SELECT * FROM hazard WHERE id = $1", [id]);
      return sendJson(res, rowToHazard(updated.rows[0], today));
    }

    // —— 普通字段修改（仅管理员）——
    if (!["safety_admin", "admin"].includes(user.role)) {
      return sendJson(res, { error: { code: "FORBIDDEN", message: "仅安全管理员/系统管理员可修改隐患内容" } }, 403);
    }

    const sets = []; const vals = [];
    const map = {
      inspectDate: "inspect_date", inspector: "inspector", location: "location", description: "description",
      rectifyMeasure: "rectify_measure", rectifyPerson: "rectify_person", planDeadline: "plan_deadline", emergencyPlan: "emergency_plan",
    };
    for (const [k, col] of Object.entries(map)) {
      if (body[k] !== undefined) { vals.push(body[k]); sets.push(`${col} = $${vals.length}`); }
    }
    for (const [k, col] of [["hazardPhotos", "hazard_photos"], ["rectifyPhotos", "rectify_photos"]]) {
      if (body[k] !== undefined) {
        const p = normalizePhotos(body[k]);
        vals.push(p.length ? JSON.stringify(p) : null);
        sets.push(`${col} = $${vals.length}`);
      }
    }
    if (body.level !== undefined) {
      if (!LEVELS.includes(body.level)) return badRequest(res, "隐患等级非法");
      vals.push(body.level); sets.push(`level = $${vals.length}`);
    }
    if (body.category !== undefined) {
      if (!CATEGORIES.includes(body.category)) return badRequest(res, "隐患类别非法");
      vals.push(body.category); sets.push(`category = $${vals.length}`);
    }
    if (body.rectifyFund !== undefined) {
      const fund = Number(body.rectifyFund);
      if (isNaN(fund) || fund < 0) return badRequest(res, "整改资金格式错误");
      vals.push(String(fund)); sets.push(`rectify_fund = $${vals.length}`);
    }
    if (body.status !== undefined) {
      if (body.status === "closed") return badRequest(res, "闭环请通过复查接口完成");
      if (!STATUSES.includes(body.status)) return badRequest(res, "状态非法");
      vals.push(body.status); sets.push(`status = $${vals.length}`);
    }
    if (sets.length === 0) return badRequest(res, "未提供可更新字段");
    sets.push("updated_at = NOW()");
    vals.push(id);
    await pool.query(`UPDATE hazard SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
    await logOp(user, "update_hazard", {
      targetType: "hazard", targetId: id, targetCode: row.hazard_code,
      detail: `修改字段：${Object.keys(body).filter((k) => k !== "action").join("、")}`,
    });
    const updated = await pool.query("SELECT * FROM hazard WHERE id = $1", [id]);
    return sendJson(res, rowToHazard(updated.rows[0], today));
  }

  return sendJson(res, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持的方法" } }, 405);
}

/**
 * 一键灌入示例数据（仅管理员）。**幂等**：已有隐患则直接跳过。
 * 生成 7 条示例 + 2 条已闭环 + 2 条整改中，用于快速体验台账/看板/流程。
 */
async function handleSeed(req, res) {
  if (req.method !== "POST") return sendJson(res, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持的方法" } }, 405);
  const cnt = await pool.query("SELECT COUNT(*)::int AS c FROM hazard");
  if (cnt.rows[0].c > 0) return sendJson(res, { seeded: false, message: "已有数据，跳过灌入" });

  const today = localDateStr();
  const datePart = today.replace(/-/g, "");
  const SAMPLES = [
    { d: -3, inspector: "王建国", location: "主井提升机", description: "主井提升机钢丝绳出现断丝、磨损超标，存在断绳风险", category: "equipment", level: "major", measure: "更换主井提升机钢丝绳并做探伤检测", person: "张伟", fund: "86000", deadline: 14, plan: "断绳时立即停机并撤出井口作业人员" },
    { d: -2, inspector: "李明", location: "井下中央变电所", description: "井下中央变电所高压电缆外皮老化开裂，存在漏电隐患", category: "electrical", level: "serious", measure: "更换老化电缆并加装绝缘护套", person: "赵强", fund: "32000", deadline: 9 },
    { d: -6, inspector: "陈立", location: "2号采场顶板", description: "2号采场顶板出现纵向裂隙，宽约3cm，有冒落风险", category: "environment", level: "major", measure: "增设液压支柱支护，加密顶板沉降监测", person: "孙勇", fund: "120000", deadline: -2, plan: "裂隙扩大立即撤人并启动顶板应急预案" },
    { d: -1, inspector: "周敏", location: "地面办公楼消防通道", description: "办公楼消防通道堆放杂物，堵塞疏散通道", category: "fire", level: "general", measure: "清理通道杂物并设置禁止堆放标识", person: "吴刚", fund: "2000", deadline: 19 },
    { d: -1, inspector: "郑涛", location: "3号作业面", description: "作业人员高空作业未按规定系挂安全带", category: "operation", level: "serious", measure: "现场立即整改并开展安全教育培训", person: "刘洋", fund: "0", deadline: 7 },
    { d: -5, inspector: "孙丽", location: "安全管理部", description: "安全生产责任制台账未及时更新，制度版本陈旧", category: "management", level: "minor", measure: "修订安全生产责任制并重新发布", person: "马超", fund: "1000", deadline: 24 },
    { d: -4, inspector: "冯强", location: "尾矿库排水沟", description: "尾矿库排水沟局部堵塞，雨天易造成积水", category: "environment", level: "general", measure: "疏通排水沟并加固沟壁", person: "杨帆", fund: "15000", deadline: 17 },
  ];

  let i = 0; const inserted = [];
  for (const s of SAMPLES) {
    i += 1;
    const newId = genId();
    await pool.query(
      `INSERT INTO hazard (id,hazard_code,inspect_date,inspector,location,description,category,level,
        rectify_measure,rectify_person,rectify_fund,plan_deadline,emergency_plan,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending')`,
      [newId, `YH-${datePart}-${String(i).padStart(4, "0")}`, shiftDate(s.d), s.inspector, s.location, s.description,
        s.category, s.level, s.measure, s.person, s.fund, shiftDate(s.deadline), s.plan || null]
    );
    inserted.push({ id: newId, deadline: shiftDate(s.deadline) });
  }
  const candidates = inserted.filter((x) => x.deadline >= today);
  const toClose = candidates.slice(0, 2);
  const toRectify = candidates.slice(2, 4);
  for (const x of toClose) {
    await pool.query(
      `UPDATE hazard SET status='closed', actual_complete_date=$1, reviewer=$2, review_date=$3, review_result=$4,
        closed_at=NOW(), updated_at=NOW() WHERE id=$5`,
      [today, "验收助手", today, "已完成整改，现场复查合格，同意闭环", x.id]
    );
  }
  for (const x of toRectify) {
    await pool.query("UPDATE hazard SET status='rectifying', updated_at=NOW() WHERE id=$1", [x.id]);
  }
  await pool.query(
    "INSERT INTO counters (date_part, n) VALUES ($1,$2) ON CONFLICT (date_part) DO UPDATE SET n = $2",
    [datePart, SAMPLES.length]
  );
  return sendJson(res, { seeded: true, count: SAMPLES.length, closed: toClose.length, rectifying: toRectify.length }, 201);
}

/* ---------------- 操作日志查询 ---------------- */
async function handleLogs(res, url) {
  const q = url.searchParams;
  const page = Math.max(1, Number(q.get("page")) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(q.get("pageSize")) || 20));
  const action = q.get("action") || "";
  const keyword = (q.get("keyword") || "").trim();

  const where = []; const vals = [];
  if (action) { vals.push(action); where.push(`action = $${vals.length}`); }
  if (keyword) {
    vals.push(`%${keyword}%`);
    where.push(`(user_name ILIKE $${vals.length} OR target_code ILIKE $${vals.length} OR detail ILIKE $${vals.length})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRes = await pool.query(`SELECT COUNT(*)::int AS c FROM operation_log ${whereSql}`, vals);
  const rows = await pool.query(
    `SELECT * FROM operation_log ${whereSql} ORDER BY created_at DESC LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}`,
    [...vals, pageSize, (page - 1) * pageSize]
  );
  return sendJson(res, {
    items: rows.rows.map((r) => ({
      id: r.id, userName: r.user_name, action: r.action, actionLabel: ACTION_LABELS[r.action] || r.action,
      targetType: r.target_type, targetCode: r.target_code, detail: r.detail,
      createdAt: new Date(r.created_at).toISOString(),
    })),
    total: totalRes.rows[0].c, page, pageSize,
  });
}

/* ---------------- 极简 XLSX 生成（零依赖，ZIP stored） ----------------
 * 为什么自己写而不用第三方库？
 *   本系统部署在**内网**，希望保持"仅一个 npm 依赖（pg）"，避免额外依赖与体积。
 * 实现要点：
 *   - XLSX 本质是一个 ZIP，内部包含若干固定 XML 部件；
 *   - 这里只用 `stored`（不压缩）方式打包，因此无需 zlib，只需 CRC32 校验；
 *   - 单元格文本用 `inlineStr` 内联字符串，避免维护共享字符串表。
 * 结构：CRC_TABLE/crc32 → zipStore() → buildXlsx()
 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}
function zipStore(files) {
  const chunks = []; const central = []; let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data); const size = f.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, f.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + size;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}
const xmlEsc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
function colName(n) { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function buildXlsx(headers, dataRows, sheetName) {
  const sheetRows = [];
  sheetRows.push(`<row r="1">${headers.map((h, i) => `<c r="${colName(i + 1)}1" t="inlineStr"><is><t>${xmlEsc(h)}</t></is></c>`).join("")}</row>`);
  dataRows.forEach((row, ri) => {
    const r = ri + 2;
    sheetRows.push(`<row r="${r}">${row.map((v, ci) => {
      const ref = `${colName(ci + 1)}${r}`;
      if (typeof v === "number" && isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t>${xmlEsc(v)}</t></is></c>`;
    }).join("")}</row>`);
  });
  const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}"><sheetData>${sheetRows.join("")}</sheetData></worksheet>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  return zipStore([
    { name: "[Content_Types].xml", data: Buffer.from(ct, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rels, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbook, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(wbRels, "utf8") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheet, "utf8") },
  ]);
}

/* ---------------- 导出（xlsx / csv） ---------------- */
const LEVEL_LABELS = { major: "重大", serious: "较大", general: "一般", minor: "轻微" };
const CATEGORY_LABELS = { equipment: "设备设施", operation: "作业行为", fire: "消防安全", electrical: "电气安全", environment: "环境安全", management: "管理缺陷" };
const STATUS_LABELS = { pending: "待整改", rectifying: "整改中", closed: "已闭环", overdue: "逾期" };

/**
 * 导出隐患台账。支持与列表一致的筛选参数。
 *   GET /api/export?format=xlsx|csv   （xlsx 为默认）
 * xlsx：用自研 buildXlsx() 生成；csv：带 UTF-8 BOM，Excel 直接打开不乱码。
 * 导出行为本身也会写入操作日志（export_hazard）。
 */
async function handleExport(res, url, user) {
  const q = url.searchParams;
  const format = (q.get("format") || "xlsx").toLowerCase();
  const today = localDateStr();

  const r = await pool.query("SELECT * FROM hazard");
  let rows = r.rows.map((x) => rowToHazard(x, today));
  const level = q.get("level"); const category = q.get("category"); const status = q.get("status");
  const dateFrom = q.get("dateFrom"); const dateTo = q.get("dateTo");
  const keyword = (q.get("keyword") || "").trim().toLowerCase();
  if (level) rows = rows.filter((h) => h.level === level);
  if (category) rows = rows.filter((h) => h.category === category);
  if (status) rows = rows.filter((h) => matchStatus(h, status));
  if (dateFrom) rows = rows.filter((h) => h.inspectDate >= dateFrom);
  if (dateTo) rows = rows.filter((h) => h.inspectDate <= dateTo);
  if (keyword) rows = rows.filter((h) => [h.hazardCode, h.description, h.location, h.inspector, h.rectifyPerson].join(" ").toLowerCase().includes(keyword));
  rows.sort((a, b) => (b.inspectDate || "").localeCompare(a.inspectDate || "") || (b.createdAt || "").localeCompare(a.createdAt || ""));

  const headers = ["隐患编号", "排查日期", "排查人员", "所在部位", "隐患描述", "隐患类别", "隐患等级",
    "整改措施", "整改责任人", "整改资金(元)", "计划完成时限", "状态",
    "实际完成日期", "复查人员", "复查日期", "复查结果", "闭环时间"];
  const data = rows.map((h) => [
    h.hazardCode, h.inspectDate, h.inspector, h.location, h.description,
    CATEGORY_LABELS[h.category] || h.category, LEVEL_LABELS[h.level] || h.level,
    h.rectifyMeasure, h.rectifyPerson, Number(h.rectifyFund) || 0, h.planDeadline,
    STATUS_LABELS[h.status] || h.status, h.actualCompleteDate || "", h.reviewer || "",
    h.reviewDate || "", h.reviewResult || "", h.closedAt ? new Date(h.closedAt).toLocaleString("zh-CN") : "",
  ]);

  await logOp(user, "export_hazard", { targetType: "hazard", detail: `导出 ${rows.length} 条（${format.toUpperCase()}）` });

  const stamp = localDateStr().replace(/-/g, "");
  if (format === "csv") {
    const csv = "\ufeff" + [headers, ...data]
      .map((row) => row.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const buf = Buffer.from(csv, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/csv;charset=utf-8",
      "Content-Disposition": `attachment; filename="hazard_${stamp}.csv"`,
      "Content-Length": buf.length,
    });
    return res.end(buf);
  }
  const buf = buildXlsx(headers, data, "隐患台账");
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="hazard_${stamp}.xlsx"`,
    "Content-Length": buf.length,
  });
  return res.end(buf);
}

/* ---------------- 图片上传 ----------------
 * 前端会先用 canvas 压缩（长边 1600px / JPEG 0.82）再以 dataURL 提交，
 * 因此这里收到的一般是几百 KB；仍做类型 + 体积双重校验。
 */
const IMAGE_EXT = { "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 单张解码后上限 8MB

/**
 * POST /api/upload  { dataUrl: "data:image/png;base64,..." }
 * 落盘为 uploads/<随机24位hex>.<ext>，返回 { url: "/uploads/xxx", size }。
 * 文件名随机 → 不可枚举；不校验登录后才能读图（因 <img> 无法携带鉴权头）。
 */
async function handleUpload(req, res, user) {
  if (req.method !== "POST") return sendJson(res, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持的方法" } }, 405);
  let body;
  try { body = await readBody(req, MAX_IMAGE_BYTES * 2); } catch (e) { return badRequest(res, e.message); }

  const dataUrl = String(body.dataUrl || "");
  const m = dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!m) return badRequest(res, "图片格式错误（需为 dataURL）");
  const mime = m[1].toLowerCase();
  const ext = IMAGE_EXT[mime];
  if (!ext) return badRequest(res, "仅支持 JPG / PNG / WEBP / GIF 图片");

  let buf;
  try { buf = Buffer.from(m[2].replace(/\s/g, ""), "base64"); } catch { return badRequest(res, "图片解码失败"); }
  if (buf.length === 0) return badRequest(res, "图片内容为空");
  if (buf.length > MAX_IMAGE_BYTES) return badRequest(res, `图片过大（限 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB）`);

  const filename = `${genId()}${ext}`;
  try {
    await fs.promises.writeFile(path.join(UPLOAD_DIR, filename), buf);
  } catch (e) {
    console.error("[UPLOAD]", e);
    return sendJson(res, { error: { code: "INTERNAL_ERROR", message: "图片保存失败" } }, 500);
  }
  console.log(`[UPLOAD] ${user?.user_name || "-"} → ${filename} (${(buf.length / 1024).toFixed(0)}KB)`);
  return sendJson(res, { url: `/uploads/${filename}`, size: buf.length }, 201);
}

/* ---------------- 图片维护：统计 / 清理无引用图片 ----------------
 * 背景：照片是"选择即上传"，用户若只上传未提交表单就会留下**孤儿文件**。
 *   GET  /api/photos  统计（文件总数 / 占用空间 / 被引用 / 无引用）
 *   POST /api/photos  删除所有无引用文件并写日志
 * 安全保证：只删除"磁盘上存在、但任何隐患记录的 hazard_photos / rectify_photos
 *           都未引用"的文件；**被引用的图片绝不会被删**。
 * 仅系统管理员可访问。
 */

/** 汇总数据库里所有被引用的图片文件名（去掉 /uploads/ 前缀，便于与磁盘文件名比对） */
async function getReferencedPhotos() {
  const r = await pool.query("SELECT hazard_photos, rectify_photos FROM hazard");
  const set = new Set();
  for (const row of r.rows) {
    for (const raw of [row.hazard_photos, row.rectify_photos]) {
      for (const u of parsePhotos(raw)) set.add(u.replace(/^\/uploads\//, ""));
    }
  }
  return set;
}
async function listUploadFiles() {
  try {
    const names = await fs.promises.readdir(UPLOAD_DIR);
    const out = [];
    for (const n of names) {
      const st = await fs.promises.stat(path.join(UPLOAD_DIR, n)).catch(() => null);
      if (st && st.isFile()) out.push({ name: n, size: st.size });
    }
    return out;
  } catch { return []; }
}
async function handlePhotosMaintenance(req, res, user) {
  const files = await listUploadFiles();
  const referenced = await getReferencedPhotos();
  const orphans = files.filter((f) => !referenced.has(f.name));
  const referencedFiles = files.length - orphans.length;   // 磁盘上确实被引用的文件数
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  const orphanSize = orphans.reduce((s, f) => s + f.size, 0);

  if (req.method === "GET") {
    return sendJson(res, {
      total: files.length, totalSize,
      referenced: referencedFiles,
      orphanCount: orphans.length, orphanSize,
      orphans: orphans.slice(0, 50).map((f) => f.name),
    });
  }
  if (req.method === "POST") {
    let deleted = 0; let freed = 0;
    for (const f of orphans) {
      try {
        await fs.promises.unlink(path.join(UPLOAD_DIR, f.name));
        deleted += 1; freed += f.size;
      } catch (e) {
        console.error("[CLEANUP]", f.name, e.message);
      }
    }
    if (deleted > 0) {
      await logOp(user, "cleanup_photos", {
        targetType: "system",
        detail: `清理无引用图片 ${deleted} 张，释放 ${(freed / 1024).toFixed(0)}KB`,
      });
    }
    console.log(`[CLEANUP] ${user?.user_name || "-"} 清理 ${deleted} 张，释放 ${(freed / 1024).toFixed(0)}KB`);
    return sendJson(res, { deleted, freed });
  }
  return sendJson(res, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持的方法" } }, 405);
}

/* ---------------- 个人中心：我的提醒 ----------------
 * GET /api/reminders → { summary:{rectify,review,closure}, rectify[], review[], closure[] }
 * 三类提醒的口径：
 *   rectify 整改提醒：**我是整改责任人**且未闭环（按计划完成时限升序）
 *   review  复查提醒：状态为「整改中」、等待复查闭环
 *   closure 闭环提醒：未闭环且（已逾期 或 3 天内到期）—— 催办清单
 * 每类最多返回 20 条，附带 overdue 标记便于前端标红。
 */
async function handleReminders(res, user) {
  const today = localDateStr();
  const soon = localDateStr(new Date(Date.now() + 3 * 24 * 3600 * 1000)); // 3 天内到期也算临期

  const r = await pool.query("SELECT * FROM hazard");
  const all = r.rows.map((x) => rowToHazard(x, today));

  // ① 整改提醒：我是整改责任人且未闭环
  const rectify = all.filter((h) => h.status !== "closed" && h.rectifyPerson === user.user_name);
  // ② 复查提醒：处于「整改中」，等待复查闭环
  const review = all.filter((h) => h.status === "rectifying");
  // ③ 闭环提醒：未闭环，且已逾期或 3 天内到期（催办）
  const closure = all.filter((h) => h.status !== "closed" && h.planDeadline <= soon);

  const byDeadline = (a, b) => (a.planDeadline || "").localeCompare(b.planDeadline || "");
  rectify.sort(byDeadline); review.sort(byDeadline); closure.sort(byDeadline);

  const slim = (h) => ({
    id: h.id, hazardCode: h.hazardCode, location: h.location, level: h.level,
    status: h.status, planDeadline: h.planDeadline, rectifyPerson: h.rectifyPerson,
    overdue: h.planDeadline < today,
  });

  return sendJson(res, {
    summary: { rectify: rectify.length, review: review.length, closure: closure.length },
    rectify: rectify.slice(0, 20).map(slim),
    review: review.slice(0, 20).map(slim),
    closure: closure.slice(0, 20).map(slim),
  });
}

/* ---------------- 静态文件 ----------------
 * 两类静态资源：
 *   /uploads/*  用户上传的图片（不做登录校验，因为 <img> 无法带鉴权头）
 *   其余        前端页面资源，找不到时对"带扩展名的请求"返回 404，
 *               对"无扩展名路径"按 SPA 路由兜底返回 index.html
 */
const MIME = {
  ".html": "text/html;charset=utf-8", ".css": "text/css;charset=utf-8", ".js": "application/javascript;charset=utf-8",
  ".json": "application/json;charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".map": "application/json",
};
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // 带扩展名的静态资源未找到 → 明确 404（避免返回 HTML 造成误解）
      if (path.extname(filePath)) { res.writeHead(404); return res.end("Not Found"); }
      // 其余视为前端路由 → SPA 兜底
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, html) => {
        if (e2) { res.writeHead(404); return res.end("Not Found"); }
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
}

/* 上传目录托管（图片以 <img> 引用，无法带鉴权头，故不校验登录；文件名随机不可枚举） */
function serveUpload(res, pathname) {
  const name = decodeURIComponent(pathname.slice("/uploads/".length));
  if (!/^[A-Za-z0-9._-]+$/.test(name)) { res.writeHead(400); return res.end("Bad Request"); }
  const fp = path.join(UPLOAD_DIR, name);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not Found"); }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(fp).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000",
    });
    res.end(data);
  });
}

/* ---------------- HTTP 服务 ----------------
 * 请求处理顺序（很重要）：
 *   ① 解析 URL；
 *   ② /api/health、/api/auth 直接放行（登录前也要能用）；
 *   ③ 其余 /api/* 统一鉴权：校验 Bearer 令牌 → 401；再查 requiredRoles → 403；
 *   ④ 按路径分发到具体 handler；
 *   ⑤ 非 /api 请求走静态文件 / SPA 兜底；
 *   ⑥ 任一 handler 抛错 → 统一 500（并打印堆栈）。
 */
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || "localhost"}`); }
  catch { return badRequest(res, "非法请求"); }
  const p = url.pathname;

  res.on("finish", () => {
    if (p.startsWith("/api/")) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${p}${url.search} → ${res.statusCode} (${Date.now() - started}ms)`);
    }
  });

  let sessionUser = null;
  try {
    if (p === "/api/health") return sendJson(res, { ok: true, time: new Date().toISOString() });
    // 应用基础信息（公开接口，无需登录）：公司名称等"本地化"信息，
    // 目的是让代码仓库里不含任何公司标识，部署时由 config.json 提供。
    if (p === "/api/app-info") return sendJson(res, { companyName: CFG.companyName || "" });
    if (p === "/api/auth") return await handleAuth(req, res, url);

    // ---- 服务端鉴权（除健康检查与登录外，一律要求有效会话令牌）----
    if (p.startsWith("/api/")) {
      sessionUser = await getSessionUser(bearerToken(req));
      if (!sessionUser) return sendJson(res, { error: { code: "UNAUTHORIZED", message: "未登录或登录已过期，请重新登录" } }, 401);
      const need = requiredRoles(req.method, p);
      if (need && !need.includes(sessionUser.role)) {
        return sendJson(res, { error: { code: "FORBIDDEN", message: "当前角色无权限执行此操作" } }, 403);
      }
    }

    if (p === "/api/stats") return await handleStats(res);
    if (p === "/api/logs") return await handleLogs(res, url);
    if (p === "/api/export") return await handleExport(res, url, sessionUser);
    if (p === "/api/upload") return await handleUpload(req, res, sessionUser);
    if (p === "/api/photos") return await handlePhotosMaintenance(req, res, sessionUser);
    if (p === "/api/reminders") return await handleReminders(res, sessionUser);
    if (p === "/api/seed") return await handleSeed(req, res);
    if (p === "/api/users") return await handleUsers(req, res, url, null, sessionUser);
    if (p.startsWith("/api/users/")) return await handleUsers(req, res, url, decodeURIComponent(p.slice("/api/users/".length)), sessionUser);
    if (p === "/api/hazards") return await handleHazards(req, res, url, null, sessionUser);
    if (p.startsWith("/api/hazards/")) return await handleHazards(req, res, url, decodeURIComponent(p.slice("/api/hazards/".length)), sessionUser);
    if (p.startsWith("/uploads/")) return serveUpload(res, p);
    if (p.startsWith("/api/")) return notFound(res, "接口不存在");
    return serveStatic(req, res, p);
  } catch (err) {
    console.error("[ERROR]", err);
    if (!res.headersSent) sendJson(res, { error: { code: "INTERNAL_ERROR", message: "服务器内部错误" } }, 500);
  }
});

/* ---------------- 启动 ----------------
 * 带重试的数据库初始化：开机时 PostgreSQL 服务可能比本服务晚就绪，
 * 因此失败后每 5 秒重试，最多 6 次（约 30 秒），全部失败才退出。
 */
async function initDatabaseWithRetry(attempts = 6, delayMs = 5000) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await initDatabase();
      return;
    } catch (err) {
      if (i === attempts) throw err;
      console.warn(`[DB] 第 ${i} 次连接失败（${err.message}），${delayMs / 1000}s 后重试...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

(async () => {
  try {
    await initDatabaseWithRetry();
  } catch (err) {
    console.error("======================================================");
    console.error("  ❌ 数据库连接/初始化失败");
    console.error("======================================================");
    console.error(`  错误信息: ${err.message}`);
    console.error(`  连接配置: ${CFG.db.user}@${CFG.db.host}:${CFG.db.port}/${CFG.db.database}`);
    console.error("  请检查 config.json 中的数据库密码是否正确、PostgreSQL 服务是否已启动。");
    console.error("======================================================");
    process.exit(1);
  }

  server.listen(CFG.port, CFG.host, () => {
    const os = require("node:os");
    const ips = [];
    for (const k in os.networkInterfaces()) {
      for (const a of os.networkInterfaces()[k]) {
        if (a.family === "IPv4" && !a.internal) ips.push(a.address);
      }
    }
    console.log("======================================================");
    console.log("  矿山安全隐患排查治理台账系统 — 本地服务已启动");
    console.log("======================================================");
    console.log(`  本机访问:   http://localhost:${CFG.port}`);
    ips.forEach((ip) => console.log(`  局域网访问: http://${ip}:${CFG.port}`));
    console.log(`  数据库:     PostgreSQL ${CFG.db.user}@${CFG.db.host}:${CFG.db.port}/${CFG.db.database}`);
    console.log(`  默认账号:   admin / 123456`);
    console.log("  按 Ctrl+C 停止服务");
    console.log("======================================================");
  });
})();

process.on("SIGINT", () => { console.log("\n正在关闭服务..."); server.close(() => pool.end().then(() => process.exit(0))); });
process.on("SIGTERM", () => { server.close(() => pool.end().then(() => process.exit(0))); });
