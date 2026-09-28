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
const LEVELS = ["major", "general"];                                                      // 隐患等级：重大/一般（二级）
const CATEGORIES = ["equipment", "operation", "fire", "electrical", "environment", "management"]; // 隐患类别
const STATUSES = ["pending", "rectifying", "closed"];                                   // 数据库可存的三种状态（overdue 为派生状态，不入库）
// 角色只分两类：系统管理员（可管用户/删隐患/应急代办）与普通用户（业务操作）。
// 登记、整改、复查都不再按角色授权，而是**按人**：整改填本人、复查由指定复查人。
const ROLES = ["user", "admin"];

/** 部门列表（一级菜单）；责任人下拉按此分组，人名作为二级 */
const DEPARTMENTS = [
  "地测部", "安全部", "通风部", "环保部", "机电部", "生产技术部",
  "采矿车间", "基建部", "选矿厂", "财务部", "综合管理部",
];

/* ---------------- 工具 ---------------- */
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
/* ---------- 口令散列（scrypt 慢哈希） ----------
 * 为什么不用 SHA-256：快哈希一秒能算上亿次，数据库文件一旦泄露，
 * 口令可被离线暴力破解。scrypt 是**故意设计得慢**的内存困难型算法，
 * 且 Node 内置（crypto.scryptSync），**无需新增任何依赖**。
 *
 * 存储格式（自描述，便于日后调参或换算法）：
 *   scrypt$N$r$p$<盐hex>$<派生密钥hex>
 * 兼容旧格式：早期数据是 SHA-256(salt::password)，
 * 用户下次登录校验通过时会**自动就地升级**为 scrypt（见 handleAuth）。
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SCRYPT_PREFIX = "scrypt$";

/** 生成新口令散列；同时返回盐（盐已内嵌在 hash 里，salt 列仅作可观测用途） */
function makePasswordHash(pwd) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(pwd), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return {
    hash: `${SCRYPT_PREFIX}${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("hex")}$${dk.toString("hex")}`,
    salt: salt.toString("hex"),
  };
}

/** 旧版快哈希 —— 仅用于校验历史数据、以及校验通过后触发升级 */
const hashPasswordLegacy = (pwd, salt) => sha256(`${salt}::${pwd}`);

/**
 * 校验口令。
 * @returns {{ ok: boolean, legacy: boolean }} legacy=true 表示这条记录还是旧格式，
 *          调用方应在校验成功后把它升级成 scrypt。
 * 比较使用 crypto.timingSafeEqual（恒定时间），避免通过响应时间侧信道推测口令。
 */
function verifyPassword(pwd, row) {
  const stored = String(row.password_hash || "");
  if (stored.startsWith(SCRYPT_PREFIX)) {
    const parts = stored.split("$");
    if (parts.length !== 6) return { ok: false, legacy: false };
    const [, N, r, p, saltHex, hashHex] = parts;
    try {
      const dk = crypto.scryptSync(String(pwd), Buffer.from(saltHex, "hex"), hashHex.length / 2,
        { N: Number(N), r: Number(r), p: Number(p) });
      const want = Buffer.from(hashHex, "hex");
      return { ok: dk.length === want.length && crypto.timingSafeEqual(dk, want), legacy: false };
    } catch { return { ok: false, legacy: false }; }
  }
  // 旧格式：SHA-256(salt::pwd)
  const a = Buffer.from(hashPasswordLegacy(pwd, row.salt || ""));
  const b = Buffer.from(stored);
  return { ok: a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b), legacy: true };
}

/* ---------- 登录失败限制 ----------
 * 连续输错 MAX_LOGIN_FAILS 次后，锁定该账号 LOGIN_LOCK_MINUTES 分钟。
 * 计数保存在内存（进程重启即清空）—— 对局域网内部系统足够：
 * 攻击者无法重启服务，而管理员重启反而是一种应急解锁手段。
 * 成功登录会清零计数。
 */
const MAX_LOGIN_FAILS = 5;                  // 允许的连续失败次数
const LOGIN_LOCK_MINUTES = 15;              // 锁定分钟数
const loginFails = new Map();               // userName -> { count, lockedUntil }

/** 查询某账号是否处于锁定中；返回剩余毫秒（0 表示未锁定） */
function loginLockRemain(userName) {
  const rec = loginFails.get(userName);
  if (!rec || !rec.lockedUntil) return 0;
  const remain = rec.lockedUntil - Date.now();
  if (remain <= 0) { loginFails.delete(userName); return 0; }
  return remain;
}
/** 记一次失败；返回剩余可尝试次数（0 表示本次已触发锁定） */
function recordLoginFail(userName) {
  const rec = loginFails.get(userName) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_LOGIN_FAILS) { rec.lockedUntil = Date.now() + LOGIN_LOCK_MINUTES * 60 * 1000; rec.count = 0; }
  loginFails.set(userName, rec);
  return rec.lockedUntil ? 0 : MAX_LOGIN_FAILS - rec.count;
}
const clearLoginFails = (userName) => loginFails.delete(userName);
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
/**
 * 校验 YYYY-MM-DD 是否为**真实存在**的日期。
 * 只做正则是不够的：2026-02-30、2026-13-01 都能通过正则，但不是有效日期。
 */
function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
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
function normalizePhotos(input, max = 6) {
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

  const status = q.get("status");
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
  login_fail: "登录失败",
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
    if (method === "POST") return ["user", "admin"];      // 登记：任意登录用户
    return null; // GET 列表：任意已登录用户
  }
  if (path.startsWith("/api/hazards/")) {
    // 具体动作（复查 / 开始整改 / 字段修改）在 handler 内按角色细分
    if (method === "GET") return null;
    return ["user", "admin"];
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
  ["COLUMN", "hazard", "level", "隐患等级：major重大 / general一般"],
  ["COLUMN", "hazard", "rectify_measure", "整改措施（登记时不填，由整改责任人「开始整改」时填写）"],
  ["COLUMN", "hazard", "rectify_person", "整改责任人姓名（登记时从系统用户中选择，冗余存姓名便于打印/导出）"],
  ["COLUMN", "hazard", "rectify_user_id", "整改责任人用户ID（与 rectify_person 对应；用于「我的待办」按账号精确匹配。历史数据可能为空）"],
  ["COLUMN", "hazard", "rectify_fund", "整改资金（单位：元）"],
  ["COLUMN", "hazard", "plan_deadline", "计划完成日期；未闭环且已过此日期即判为「逾期」（逾期是实时计算的派生状态，不落库）"],
  ["COLUMN", "hazard", "emergency_plan", "应急预案"],
  ["COLUMN", "hazard", "status", "状态：pending待整改 / rectifying整改中 / closed已闭环"],
  ["COLUMN", "hazard", "actual_complete_date", "实际完成整改的日期"],
  ["COLUMN", "hazard", "reviewer", "复查（验收）人姓名（登记时指定，冗余存姓名便于打印/导出）"],
  ["COLUMN", "hazard", "reviewer_user_id", "复查人用户ID（与 reviewer 对应；只有该人可执行复查闭环，管理员可代办）"],
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
  ["COLUMN", "users", "role", "角色：user普通用户 / admin系统管理员"],
  ["COLUMN", "users", "department", "所属部门（如 安全部/机电部）；责任人下拉按部门分组展示"],
  ["COLUMN", "users", "salt", "口令盐值（scrypt 格式自描述串时可为空）"],
  ["COLUMN", "users", "password_hash", "口令散列值（scrypt 慢哈希，自描述格式；兼容旧 SHA-256）"],
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
 *   ④ 若 users 表为空则播种初始管理员 admin（初始口令见 DEFAULT_INITIAL_PASSWORD，
 *      刻意不在控制台/日志里打印，见下方 console.log 处的说明）。
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
      rectify_measure TEXT,                            -- 登记时不填，由整改责任人在「开始整改」时填写
      rectify_person TEXT NOT NULL,
      rectify_fund NUMERIC(14,2) NOT NULL DEFAULT 0,
      plan_deadline TEXT NOT NULL,
      emergency_plan TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      actual_complete_date TEXT,
      reviewer TEXT,
      reviewer_user_id TEXT,
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
    ALTER TABLE hazard ADD COLUMN IF NOT EXISTS rectify_user_id TEXT;   -- 整改责任人用户ID（用于按账号匹配"我的待办"）
    -- 流程调整：登记时只填隐患信息，整改措施改由整改责任人在「开始整改」时填写，
    -- 因此老库上原有的 NOT NULL 约束要去掉（新库建表时已允许为空）。
    ALTER TABLE hazard ALTER COLUMN rectify_measure DROP NOT NULL;
    -- 复查人也需要绑定账号（只有指定的人能复查闭环）
    ALTER TABLE hazard ADD COLUMN IF NOT EXISTS reviewer_user_id TEXT;
    -- 角色收敛为「user普通用户 / admin系统管理员」两种；
    -- 原来的 entry/reviewer/safety_admin 一律并入 user（登记、整改、复查已改成按"人"授权）。
    ALTER TABLE users ADD COLUMN IF NOT EXISTS department TEXT;
    UPDATE users SET role = 'user' WHERE role NOT IN ('user', 'admin');
    -- 首次升级时把现有人员统一归入「安全部」（管理员之后可在用户管理里改）
    UPDATE users SET department = '安全部' WHERE department IS NULL;
    -- 老数据（当初只手填了姓名、没选用户）按姓名自动匹配绑定；
    -- 匹配不上的保持为空，此时仅系统管理员可代办（见 PATCH 权限判断）。
    UPDATE hazard h SET rectify_user_id = u.id
      FROM users u WHERE h.rectify_user_id IS NULL AND h.rectify_person = u.user_name;
    UPDATE hazard h SET reviewer_user_id = u.id
      FROM users u WHERE h.reviewer_user_id IS NULL AND h.reviewer = u.user_name;
    CREATE INDEX IF NOT EXISTS idx_hazard_status ON hazard(status);
    CREATE INDEX IF NOT EXISTS idx_hazard_inspect_date ON hazard(inspect_date);
    CREATE INDEX IF NOT EXISTS idx_hazard_plan_deadline ON hazard(plan_deadline);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      user_name TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      department TEXT,
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
      const ph = makePasswordHash(DEFAULT_INITIAL_PASSWORD);
      await pool.query(
        "INSERT INTO users (id,user_id,user_name,role,salt,password_hash,must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [genId(), "u_admin", "admin", "admin", ph.salt, ph.hash, false]
      );
      // 这里**故意不打印口令**：控制台/日志文件会被无关人员看到，口令请查《维护手册》。
      console.log("[DB] 已创建初始管理员账号 admin（初始口令见《维护手册》，首次登录后请立即修改）");
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

      // —— 登录失败限制：锁定期间直接拒绝，不查库、也不比对口令 ——
      const remainMs = loginLockRemain(userName);
      if (remainMs > 0) {
        const mins = Math.ceil(remainMs / 60000);
        return sendJson(res, {
          error: { code: "LOGIN_LOCKED", message: `密码连续输错 ${MAX_LOGIN_FAILS} 次，账号已锁定，请 ${mins} 分钟后再试` },
        }, 429);
      }

      const r = await pool.query("SELECT * FROM users WHERE user_name = $1", [userName]);
      const u = r.rows[0];
      // 用户不存在时也走一次散列校验（避免通过响应快慢判断账号是否存在）
      const v = u ? verifyPassword(password, u) : { ok: false, legacy: false };

      if (!v.ok) {
        const left = recordLoginFail(userName);
        await logOp({ id: u ? u.id : null, user_name: userName }, "login_fail", {
          targetType: "user", targetCode: userName,
          detail: left > 0
            ? `密码错误，还可尝试 ${left} 次`
            : `密码连续输错 ${MAX_LOGIN_FAILS} 次，账号锁定 ${LOGIN_LOCK_MINUTES} 分钟`,
        });
        return badRequest(res, left > 0
          ? `账号或密码错误（还可尝试 ${left} 次）`
          : `密码连续输错 ${MAX_LOGIN_FAILS} 次，账号已锁定 ${LOGIN_LOCK_MINUTES} 分钟`);
      }
      clearLoginFails(userName);

      // —— 历史数据的旧格式散列（SHA-256）在登录成功时就地升级为 scrypt，用户无感知 ——
      if (v.legacy) {
        try {
          const ph = makePasswordHash(password);
          await pool.query("UPDATE users SET salt=$1, password_hash=$2 WHERE id=$3", [ph.salt, ph.hash, u.id]);
          console.log(`[AUTH] 用户 ${u.user_name} 的口令散列已自动升级为 scrypt`);
        } catch (e) { console.error("[AUTH] 口令散列升级失败:", e.message); }
      }

      const token = await createSession(u.id);
    await logOp({ id: u.id, user_name: u.user_name }, "login", { targetType: "user", targetId: u.id, targetCode: u.user_name, detail: `角色：${u.role}` });
    return sendJson(res, {
      success: true,
      token,
      user: { id: u.id, userId: u.user_id, userName: u.user_name, role: u.role, department: u.department || "", createdAt: new Date(u.created_at).toISOString() },
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
      if (!verifyPassword(String(oldPassword), u).ok) return badRequest(res, "旧密码错误");
      const ph = makePasswordHash(String(newPassword));
      await pool.query("UPDATE users SET salt=$1, password_hash=$2, must_change_password=FALSE WHERE id=$3",
        [ph.salt, ph.hash, id]);
      return sendJson(res, { success: true });
    }
  return notFound(res, "未知操作");
}

/**
 * 用户管理（仅系统管理员 admin 可访问，见 requiredRoles）。
 *   GET    /api/users        列表
 *   POST   /api/users        新增（初始口令见 DEFAULT_INITIAL_PASSWORD，首次登录强制修改；姓名唯一）
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
          const uid = genId(); const userId = body.userId || `u_${Date.now()}`;
          const ph = makePasswordHash(DEFAULT_INITIAL_PASSWORD);
          const dept = String(body.department || "").trim() || null;
          await pool.query(
            "INSERT INTO users (id,user_id,user_name,role,department,salt,password_hash,must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)",
            [uid, userId, userName, body.role, dept, ph.salt, ph.hash]
          );
        const created = await pool.query("SELECT * FROM users WHERE id = $1", [uid]);
        await logOp(user, "create_user", { targetType: "user", targetId: uid, targetCode: userName, detail: `部门：${dept || "（未指定）"}｜角色：${body.role}` });
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
        const ph = makePasswordHash(DEFAULT_INITIAL_PASSWORD);
        await pool.query("UPDATE users SET salt=$1, password_hash=$2, must_change_password=TRUE WHERE id=$3",
          [ph.salt, ph.hash, id]);
      await logOp(user, "reset_password", { targetType: "user", targetId: id, targetCode: found.rows[0].user_name, detail: "重置为初始密码" });
      return sendJson(res, { success: true });
    }
      if (body.role !== undefined) {
        if (!ROLES.includes(body.role)) return badRequest(res, "角色非法");
        const r = await pool.query("UPDATE users SET role=$1 WHERE id=$2 RETURNING *", [body.role, id]);
        await logOp(user, "update_user_role", { targetType: "user", targetId: id, targetCode: found.rows[0].user_name, detail: `角色：${found.rows[0].role} → ${body.role}` });
        return sendJson(res, rowToUser(r.rows[0]));
      }
      if (body.department !== undefined) {
        const dept = String(body.department).trim() || null;
        const r = await pool.query("UPDATE users SET department=$1 WHERE id=$2 RETURNING *", [dept, id]);
        await logOp(user, "update_user_dept", { targetType: "user", targetId: id, targetCode: found.rows[0].user_name, detail: `部门：${found.rows[0].department || "（空）"} → ${dept || "（空）"}` });
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
 *   POST   /api/hazards              登记（任意登录用户即可，不分角色）
 *   GET    /api/hazards/:id          详情（任意登录用户）
 *   PATCH  /api/hazards/:id          见下方三个分支
 *   DELETE /api/hazards/:id          删除（仅系统管理员 admin）
 *
 * PATCH 的三个分支（通过 body.action 区分）：
 *   - action:"start-rectify"  填写整改信息 → 待整改 → 整改中
 *                             权限：该隐患 rectify_user_id 本人，或 admin 应急代办
 *   - action:"review"         复查闭环 → 要求先处于「整改中」
 *                             权限：该隐患 reviewer_user_id 本人，或 admin 应急代办
 *   - 其余为普通字段修改（仅 admin）
 * 注意：登记/整改/复查**不按角色授权，而是按"人"**——见各分支内的 isOwner 判断。
 * 列表筛选支持伪状态 unclosed（未闭环）；编号取号使用 UPSERT 原子自增。
 */
async function handleHazards(req, res, url, id, user) {
  const today = localDateStr();

  if (!id) {
    if (req.method === "GET") {
      const q = url.searchParams;
      const page = Math.max(1, Number(q.get("page")) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(q.get("pageSize")) || 10));
      const { where, params } = buildHazardWhere(q, today);

      // 筛选与计数都在数据库完成，只把当前页取回内存（见 buildHazardWhere 注释）
      const cnt = await pool.query(`SELECT COUNT(*)::int AS c FROM hazard WHERE ${where}`, params);
      const pageRes = await pool.query(
        `SELECT * FROM hazard WHERE ${where} ORDER BY inspect_date DESC, created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, (page - 1) * pageSize]
      );
      return sendJson(res, {
        items: pageRes.rows.map((x) => rowToHazard(x, today)),
        total: cnt.rows[0].c, page, pageSize,
      });
    }

    if (req.method === "POST") {
      let body;
      try { body = await readBody(req); } catch (e) { return badRequest(res, e.message); }

      // —— 批量删除（台账页多选后调用；仅安全管理员/系统管理员）——
      if (body.action === "batch-delete") {
        if (user.role !== "admin") return badRequest(res, "仅系统管理员可删除隐患");
        const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string" && x) : [];
        if (ids.length === 0) return badRequest(res, "请先选择要删除的隐患");
        if (ids.length > 200) return badRequest(res, "单次最多删除 200 条");
        const info = await pool.query(
          "SELECT id, hazard_code FROM hazard WHERE id = ANY($1)", [ids]
        );
        await pool.query("DELETE FROM hazard WHERE id = ANY($1)", [ids]);
        await logOp(user, "delete_hazard", {
          targetId: null, targetCode: "",
          detail: `批量删除 ${info.rowCount} 条隐患：${info.rows.map((r) => r.hazard_code).slice(0, 10).join("、")}${info.rowCount > 10 ? " 等" : ""}`,
        });
        return sendJson(res, { deleted: info.rowCount });
      }

      // 登记环节只填**隐患信息** + 整改责任人 + 计划完成时限；
      // 整改措施 / 整改资金 / 应急预案 由整改责任人在「开始整改」时填写（见 PATCH action=start-rectify）。
      const required = ["inspectDate", "inspector", "location", "description", "category", "level",
        "rectifyPerson", "planDeadline", "reviewer"];
      for (const k of required) {
        if (body[k] === undefined || body[k] === null || String(body[k]).trim() === "") return badRequest(res, `字段 ${k} 不能为空`);
      }
      if (!LEVELS.includes(body.level)) return badRequest(res, "隐患等级非法");
      if (!CATEGORIES.includes(body.category)) return badRequest(res, "隐患类别非法");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.inspectDate)) return badRequest(res, "排查日期格式错误");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.planDeadline)) return badRequest(res, "计划完成时限格式错误");
      if (!isRealDate(body.inspectDate)) return badRequest(res, "排查日期不是有效日期");
      if (!isRealDate(body.planDeadline)) return badRequest(res, "计划完成时限不是有效日期");
      // 日期先后关系校验：计划完成时限不能早于排查日期
      if (body.planDeadline < body.inspectDate) return badRequest(res, "计划完成时限不能早于排查日期");

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
          rectify_person,rectify_user_id,plan_deadline,reviewer,reviewer_user_id,status,hazard_photos,rectify_photos)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14,$15)`,
        [newId, hazardCode, body.inspectDate, String(body.inspector).trim(), String(body.location).trim(),
          String(body.description).trim(), body.category, body.level,
          String(body.rectifyPerson).trim(), body.rectifyUserId ? String(body.rectifyUserId).trim() : null,
          body.planDeadline,
          String(body.reviewer).trim(), body.reviewerUserId ? String(body.reviewerUserId).trim() : null,
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
      if (user.role !== "admin") {
        return sendJson(res, { error: { code: "FORBIDDEN", message: "仅系统管理员可删除隐患" } }, 403);
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
      // 权限：**只有登记时指定的复查人本人**可执行；系统管理员可代办（应急）。
      // 其他安全管理员/复查人员一律不行 —— 做到"谁复查、谁签字"。
      // 老数据没绑定账号的，仅系统管理员可代办。
      const isReviewer = !!(row.reviewer_user_id && row.reviewer_user_id === user.id);
      const isAdmin = user.role === "admin";
      if (!isReviewer && !isAdmin) {
        const who = row.reviewer ? `（${row.reviewer}）` : "（未指定，需管理员先指派）";
        return sendJson(res, {
          error: { code: "FORBIDDEN", message: `只有复查人${who}本人可以执行复查闭环` },
        }, 403);
      }
      for (const k of ["actualCompleteDate", "reviewer", "reviewDate", "reviewResult"]) {
        if (!body[k] || String(body[k]).trim() === "") return badRequest(res, `字段 ${k} 不能为空`);
      }
      if (row.status === "closed") return badRequest(res, "该隐患已闭环");
      if (row.status === "pending") return badRequest(res, "请先由整改责任人「开始整改」并填写整改信息，再进行复查闭环");
      if (!row.rectify_measure || !String(row.rectify_measure).trim()) {
        return badRequest(res, "该隐患尚未填写整改措施（应由整改责任人开始整改时填写），无法复查");
      }
      await pool.query(
        `UPDATE hazard SET status='closed', actual_complete_date=$1, reviewer=$2, review_date=$3, review_result=$4,
          closed_at=NOW(), updated_at=NOW() WHERE id=$5`,
        [body.actualCompleteDate, String(body.reviewer).trim(), body.reviewDate, String(body.reviewResult).trim(), id]
      );
      await logOp(user, "review_hazard", { targetType: "hazard", targetId: id, targetCode: row.hazard_code, detail: "复查闭环，验收合格" });
      const updated = await pool.query("SELECT * FROM hazard WHERE id = $1", [id]);
      return sendJson(res, rowToHazard(updated.rows[0], today));
    }

    // —— 开始整改：由**整改责任人**在此填写整改信息（整改措施/资金/应急预案）——
    // 隐患登记时只填隐患信息，整改信息在真正动手整改时才由责任人补齐。
    if (body.action === "start-rectify") {
      // 权限：**只有被指定的整改责任人本人**可填；系统管理员可代办（应急）。
      // 其他安全管理员一律不行 —— 做到"谁整改、谁填写"。
      // 老数据没绑定账号的，仅系统管理员可代办。
      const isOwner = !!(row.rectify_user_id && row.rectify_user_id === user.id);
      const isAdmin = user.role === "admin";
      if (!isOwner && !isAdmin) {
        const who = row.rectify_person ? `（${row.rectify_person}）` : "（未指定，需管理员先指派）";
        return sendJson(res, {
          error: { code: "FORBIDDEN", message: `只有整改责任人${who}本人可以填写整改信息` },
        }, 403);
      }
      if (row.status === "closed") return badRequest(res, "该隐患已闭环，无法再整改");
      if (row.status === "rectifying") return badRequest(res, "该隐患已在整改中");

      const measure = String(body.rectifyMeasure ?? "").trim();
      if (!measure) return badRequest(res, "请填写整改措施");
      const fundRaw = body.rectifyFund;
      const fund = (fundRaw === undefined || fundRaw === null || String(fundRaw).trim() === "") ? 0 : Number(fundRaw);
      if (Number.isNaN(fund) || fund < 0) return badRequest(res, "整改资金格式错误");
      const emergency = body.emergencyPlan ? String(body.emergencyPlan).trim() : null;
      // 整改照片：责任人可在填整改信息时一并上传（也可之后在复查前补充）
      const hasPhotos = body.rectifyPhotos !== undefined;
      const rPhotos = hasPhotos ? normalizePhotos(body.rectifyPhotos) : null;

      await pool.query(
        hasPhotos
          ? `UPDATE hazard SET status='rectifying', rectify_measure=$1, rectify_fund=$2, emergency_plan=$3,
               rectify_photos=$4, updated_at=NOW() WHERE id=$5`
          : `UPDATE hazard SET status='rectifying', rectify_measure=$1, rectify_fund=$2, emergency_plan=$3,
               updated_at=NOW() WHERE id=$4`,
        hasPhotos
          ? [measure, String(fund), emergency, rPhotos.length ? JSON.stringify(rPhotos) : null, id]
          : [measure, String(fund), emergency, id]
      );
      await logOp(user, "start_rectify", {
        targetType: "hazard", targetId: id, targetCode: row.hazard_code,
        detail: `填写整改信息并开始整改（措施 ${measure.slice(0, 30)}｜资金 ${fund} 元`
          + (hasPhotos && rPhotos.length ? `｜整改照片 ${rPhotos.length} 张` : "") + "）",
      });
      const updated = await pool.query("SELECT * FROM hazard WHERE id = $1", [id]);
      return sendJson(res, rowToHazard(updated.rows[0], today));
    }

      // —— 普通字段修改（仅系统管理员）——
      if (user.role !== "admin") {
        return sendJson(res, { error: { code: "FORBIDDEN", message: "仅系统管理员可修改隐患内容" } }, 403);
      }

    const sets = []; const vals = [];
    const map = {
      inspectDate: "inspect_date", inspector: "inspector", location: "location", description: "description",
      rectifyMeasure: "rectify_measure", rectifyPerson: "rectify_person", rectifyUserId: "rectify_user_id",
      reviewer: "reviewer", reviewerUserId: "reviewer_user_id",
      planDeadline: "plan_deadline", emergencyPlan: "emergency_plan",
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
      // 日期校验：取"本次要写入的值"与"数据库现有值"中的实际生效值做先后比对
      // （只改其中一个字段时，另一方沿用原值，否则会漏检）
      const effInspect = body.inspectDate !== undefined ? String(body.inspectDate) : row.inspect_date;
      const effDeadline = body.planDeadline !== undefined ? String(body.planDeadline) : row.plan_deadline;
      if (!isRealDate(effInspect)) return badRequest(res, "排查日期不是有效日期");
      if (!isRealDate(effDeadline)) return badRequest(res, "计划完成时限不是有效日期");
      if (effDeadline < effInspect) return badRequest(res, "计划完成时限不能早于排查日期");
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
    { d: -2, inspector: "李明", location: "井下中央变电所", description: "井下中央变电所高压电缆外皮老化开裂，存在漏电隐患", category: "electrical", level: "general", measure: "更换老化电缆并加装绝缘护套", person: "赵强", fund: "32000", deadline: 9 },
    { d: -6, inspector: "陈立", location: "2号采场顶板", description: "2号采场顶板出现纵向裂隙，宽约3cm，有冒落风险", category: "environment", level: "major", measure: "增设液压支柱支护，加密顶板沉降监测", person: "孙勇", fund: "120000", deadline: -2, plan: "裂隙扩大立即撤人并启动顶板应急预案" },
    { d: -1, inspector: "周敏", location: "地面办公楼消防通道", description: "办公楼消防通道堆放杂物，堵塞疏散通道", category: "fire", level: "general", measure: "清理通道杂物并设置禁止堆放标识", person: "吴刚", fund: "2000", deadline: 19 },
    { d: -1, inspector: "郑涛", location: "3号作业面", description: "作业人员高空作业未按规定系挂安全带", category: "operation", level: "general", measure: "现场立即整改并开展安全教育培训", person: "刘洋", fund: "0", deadline: 7 },
    { d: -5, inspector: "孙丽", location: "安全管理部", description: "安全生产责任制台账未及时更新，制度版本陈旧", category: "management", level: "general", measure: "修订安全生产责任制并重新发布", person: "马超", fund: "1000", deadline: 24 },
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

/**
 * 单元格样式索引 —— 与 styles.xml 中 cellXfs 的顺序**必须一一对应**。
 * 0 默认 / 1 大标题 / 2 表头 / 3 正文居中 / 4 正文左对齐 / 5 说明段落（左上）
 * 6 粗体 / 7 右对齐（垂直居中）/ 8 右对齐+底端对齐（落款右下角）
 * 9 左对齐+顶端 / 10 右对齐+右缩进 5 字（签字处留白）
 */
const XS = {
  DEFAULT: 0, TITLE: 1, TH: 2, CENTER: 3, LEFT: 4, NOTE: 5,
  BOLD: 6, RIGHT: 7, RIGHT_BOTTOM: 8, LEFT_TOP: 9, RIGHT_SIGN: 10,
};

/** styles.xml：字体/填充/边框/单元格格式四张表，供上面 XS 索引导用 */
const XLSX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
  + `<fonts count="5">`
  + `<font><sz val="11"/><name val="&#23435;&#20307;"/><charset val="134"/></font>`
  + `<font><b/><sz val="11"/><name val="&#23435;&#20307;"/><charset val="134"/></font>`
  + `<font><b/><sz val="16"/><name val="&#23435;&#20307;"/><charset val="134"/></font>`
  + `<font><b/><sz val="11"/><color rgb="FFC00000"/><name val="&#23435;&#20307;"/><charset val="134"/></font>`
  + `<font><sz val="9"/><name val="&#23435;&#20307;"/><charset val="134"/></font>`
  + `</fonts>`
  + `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>`
  + `<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill></fills>`
  + `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>`
  + `<border><left style="thin"><color indexed="64"/></left><right style="thin"><color indexed="64"/></right>`
  + `<top style="thin"><color indexed="64"/></top><bottom style="thin"><color indexed="64"/></bottom><diagonal/></border></borders>`
  + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
  + `<cellXfs count="11">`
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`                                                                                            // 0 默认
  + `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>`   // 1 标题
  + `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>`  // 2 表头
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>`  // 3 居中
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>`    // 4 左对齐
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>`                       // 5 说明段（左上）
  + `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>`       // 6 粗体
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>`                                // 7 右对齐
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="bottom" wrapText="1"/></xf>`                   // 8 右对齐+底端（落款右下角）
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>`                       // 9 左对齐+顶端
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="center" indent="5" wrapText="1"/></xf>`        // 10 右对齐+右缩进5字（签字留白）
  + `</cellXfs>`
  // cellStyles 必须显式声明「常规」样式，否则 Excel/openpyxl 会报 "no default style"
  // （dxfs 也一并声明，部分阅读器要求其存在）
  + `<cellStyles count="1"><cellStyle name="&#24120;&#35268;" xfId="0" builtinId="0"/></cellStyles>`
  + `<dxfs count="0"/>`
  + `</styleSheet>`;

/**
 * 生成 XLSX（零依赖，ZIP stored）。**支持多工作表**。
 * 相比最初的单表头版本，这里补齐了中式表格真正需要的东西：
 *   ① 样式（标题/表头/正文/说明段/落款/缩进）  ② 合并单元格
 *   ③ 列宽（按印版像素折算）  ④ 自动换行  ⑤ 行高  ⑥ **多 sheet**
 * @param {object|object[]} sheets 单个 sheet 定义，或 sheet 数组
 *   sheet.sheetName {string}  工作表名（Excel 限制 ≤31 字符、不含 : \ / ? * [ ]）
 *   sheet.cols      {number[]} 列宽（字符数）
 *   sheet.rows      {Array<{h?:number, cells: Array<null|string|number|{v:any,s?:number}>}>}
 *   sheet.merges    {string[]} 合并区域（A1 记法）
 *   sheet.freeze    {string}   冻结窗格起点（如 "A4"）
 */
function buildXlsx(sheets) {
  const list = (Array.isArray(sheets) ? sheets : [sheets]).filter(Boolean);
  const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

  // —— 图片：跨表统一编号（media 文件同处一个目录）——
  let mediaSeq = 0;
  const mediaParts = [];      // {name, data}
  const sheetImgs = list.map((o) => (o.images || []).map((im) => {
    let bytes = null;
    try { bytes = fs.readFileSync(im.file); } catch { return null; }
    const ext = path.extname(im.file).toLowerCase();
    if (!IMG_MIME[ext]) return null;              // pdf/word 等不能嵌入，交给文字兜底
    const nat = imageSize(bytes) || { w: 200, h: 150 };
    mediaSeq += 1;
    mediaParts.push({ name: `xl/media/image${mediaSeq}${ext}`, data: bytes });
    return { ...im, seq: mediaSeq, ext, nat };
  }).filter(Boolean));

  // —— 每个 sheet 生成一份 worksheet XML ——
  const sheetXmls = list.map((o, si) => {
    const rows = o.rows || [];
    const colsXml = (o.cols && o.cols.length)
      ? `<cols>${o.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w > 0 ? w : 8.43}" customWidth="1"/>`).join("")}</cols>`
      : "";
    const rowXml = rows.map((row, ri) => {
      const r = ri + 1;
      const cells = (row.cells || []).map((c, ci) => {
        if (c === null || c === undefined || c === "") return "";
        const v = (typeof c === "object") ? c.v : c;
        const s = (typeof c === "object" && c.s !== undefined) ? c.s : XS.DEFAULT;
        if (v === null || v === undefined || v === "") return s ? `<c r="${colName(ci + 1)}${r}" s="${s}"/>` : "";
        const ref = `${colName(ci + 1)}${r}`;
        const sAttr = s ? ` s="${s}"` : "";
        if (typeof v === "number" && isFinite(v)) return `<c r="${ref}"${sAttr}><v>${v}</v></c>`;
        return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
      }).join("");
      const hAttr = row.h ? ` ht="${row.h}" customHeight="1"` : "";
      return `<row r="${r}"${hAttr}>${cells}</row>`;
    }).join("");
    const mergesXml = (o.merges && o.merges.length)
      ? `<mergeCells count="${o.merges.length}">${o.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>`
      : "";
    const freezeXml = o.freeze
      ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${Number(o.freeze.replace(/\D/g, "")) - 1}" topLeftCell="${o.freeze}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
      : "";
    // 有图片就必须在表末尾引用绘图；<drawing> 必须排在 mergeCells 之后
    const drawingXml = (sheetImgs[si] || []).length ? `<drawing r:id="rId1"/>` : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
      + freezeXml + colsXml + `<sheetData>${rowXml}</sheetData>` + mergesXml + drawingXml + `</worksheet>`;
  });

  // —— 绘图 XML：把图片锚在指定单元格左上角，按设计尺寸摆放 ——
  const drawXmls = sheetImgs.map((imgs, si) => {
    if (!imgs.length) return null;
    const anchors = imgs.map((im, i) => {
      // 设计尺寸：按行高与列宽留出的空间做等比缩放（每张图片单独算）
      const w = im.w || 120; const h = im.h || 80;
      return `<xdr:oneCellAnchor><xdr:from><xdr:col>${im.col}</xdr:col><xdr:colOff>${px2emu(im.offX || 0)}</xdr:colOff>`
        + `<xdr:row>${im.row}</xdr:row><xdr:rowOff>${px2emu(im.offY || 0)}</xdr:rowOff></xdr:from>`
        + `<xdr:ext cx="${px2emu(w)}" cy="${px2emu(h)}"/>`
        + `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 1}" name="图片${i + 1}"/>`
        + `<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>`
        + `<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId${i + 1}"/>`
        + `<a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`
        + `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${px2emu(w)}" cy="${px2emu(h)}"/></a:xfrm>`
        + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`;
    }).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${anchors}</xdr:wsDr>`;
  });
  const drawRels = sheetImgs.map((imgs, si) => {
    if (!imgs.length) return null;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + imgs.map((im, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${im.seq}${im.ext}"/>`).join("")
      + `</Relationships>`;
  });
  const sheetRels = sheetImgs.map((imgs, si) => imgs.length
    ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${si + 1}.xml"/></Relationships>`
    : null);

  // —— workbook / rels / content-types 按 sheet 数量动态拼 ——
  const sheetTags = list.map((o, i) => {
    // 工作表名做一次清洗：Excel 不允许 : \ / ? * [ ]，且长度 ≤31
    const nm = String(o.sheetName || `Sheet${i + 1}`).replace(/[:\\/?*[\]]/g, "_").slice(0, 31);
    return `<sheet name="${xmlEsc(nm)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`;
  }).join("");
  const styleRid = `rId${list.length + 1}`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags}</sheets></workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")
    + `<Relationship Id="${styleRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const imgExts = [...new Set(mediaParts.map((m) => path.extname(m.name).slice(1).toLowerCase()))];
  // 只对实际用到的图片扩展名声明 Default（PNG 无扩展名分支 → 用 png 占位不影响读取）
  const imgTypes = (imgExts.length ? imgExts : ["png"])
    .map((e) => `<Default Extension="${e}" ContentType="${IMG_MIME["." + e] || "image/png"}"/>`).join("");
  const drawingTypes = drawXmls.some(Boolean)
    ? `<Default Extension="drawing" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>` : "";
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
    + imgTypes + drawingTypes
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
    + list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")
    + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

  const parts = [
    { name: "[Content_Types].xml", data: Buffer.from(ct, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rels, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbook, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(wbRels, "utf8") },
    { name: "xl/styles.xml", data: Buffer.from(XLSX_STYLES, "utf8") },
    ...sheetXmls.map((xml, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(xml, "utf8") })),
    ...mediaParts,                                                   // 图片本体
  ];
  // 绘图与关系：仅对"有图片"的表输出
  drawXmls.forEach((xml, i) => { if (xml) parts.push({ name: `xl/drawings/drawing${i + 1}.xml`, data: Buffer.from(xml, "utf8") }); });
  drawRels.forEach((xml, i) => { if (xml) parts.push({ name: `xl/drawings/_rels/drawing${i + 1}.xml.rels`, data: Buffer.from(xml, "utf8") }); });
  sheetRels.forEach((xml, i) => { if (xml) parts.push({ name: `xl/worksheets/_rels/sheet${i + 1}.xml.rels`, data: Buffer.from(xml, "utf8") }); });
  return zipStore(parts);
}

/* ---------------- 导出（xlsx / csv） ---------------- */
const LEVEL_LABELS = { major: "重大", general: "一般" };
const CATEGORY_LABELS = { equipment: "设备设施", operation: "作业行为", fire: "消防安全", electrical: "电气安全", environment: "环境安全", management: "管理缺陷" };
const STATUS_LABELS = { pending: "待整改", rectifying: "整改中", closed: "已闭环", overdue: "逾期" };

/* ---------------- 三套中式表单导出 ----------------
 * 格式严格对照公司现行纸质表单《安全检查隐患问题整改通知单、销号单、登记表》：
 *   ① notice  检查隐患问题整改通知单  （14 列，含标题、检查说明段与签发落款）
 *   ② closure 检查问题销号申请单      （13 列，含单位/日期行与负责人落款）
 *   ③ ledger  安全隐患整改治理台账    （11 列，含单位行）
 *
 * ⚠️ 口径说明：纸质表单中「**隐患类别**」列填的是「一般」这类**等级**值，
 *    因此这里填系统的 level（重大/一般）；系统内部的 category（设备设施/作业行为…）
 *    不见于纸质表单，属于系统内部管理字段，不出现在导出件里。
 */
const ORG_NAME = () => String(CFG.companyName || "").trim();

/**
 * 通知单落款部门。
 * 优先取配置项 `noticeDept`（写在 config.json 里，不进版本库）；
 * 未配置则由公司全称推导「简称 + 安全部」，例如
 *   ××旗××矿业有限责任公司 → ××矿业安全部
 * 之所以不硬编码：保证**代码仓库里不含任何公司标识**，可安全托管/对外交付。
 */
function noticeDept() {
  const cfgDept = String(CFG.noticeDept || "").trim();
  if (cfgDept) return cfgDept;
  const full = ORG_NAME();
  if (!full) return "安全部";
  const short = full
    .replace(/^[\u4e00-\u9fa5]{1,6}?(?:旗|县|市|区|省|盟|州)/, "")   // 去行政区划前缀
    .replace(/(?:有限责任|股份有限|集团)?公司$/, "");                  // 去公司后缀
  return `${short || full}安全部`;
}

/** 两个日期相差的自然日数（纸质表单「整改期限」填的是天数） */
function dayDiff(from, to) {
  if (!from || !to) return "";
  const a = Date.parse(`${from}T00:00:00`);
  const b = Date.parse(`${to}T00:00:00`);
  if (Number.isNaN(a) || Number.isNaN(b)) return "";
  return Math.round((b - a) / 86400000);
}
/** YYYY-MM-DD → YYYY/M/D（纸质表单的日期写法） */
function slashDate(s) {
  if (!s) return "";
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}/${Number(m[2])}/${Number(m[3])}` : String(s);
}
/** YYYY-MM-DD → YYYY年M月D日 */
function cnDate(s) {
  if (!s) return "";
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}年${Number(m[2])}月${Number(m[3])}日` : String(s);
}
/** 附件列表 → 可读文本（优先原文件名，退回落盘文件名） */
function attText(list) {
  return (Array.isArray(list) ? list : [])
    .map((p) => (p && p.n) || String((p && p.u) || "").split("/").pop() || "")
    .filter(Boolean).join("、");
}

/** 附件里能嵌入 Excel 的图片（pdf/word 等不能嵌，只列名） */
function imgAtts(list) {
  return (Array.isArray(list) ? list : []).filter((p) => {
    const u = (p && p.u) || p;
    return u && IMG_MIME[path.extname(String(u)).toLowerCase()];
  });
}

/**
 * 生成「把附件图片嵌到某单元格」所需的图片描述。
 * **按原始比例等比缩放**到单元格可用空间内，横向并排（最多 maxN 张），每张水平居中。
 * @param {Array} list  附件数组
 * @param {number} row  0-based 行号
 * @param {number} col  0-based 列号
 * @param {number} boxW 单元格可用宽（px）
 * @param {number} boxH 单元格可用高（px）
 */
function embedImages(list, row, col, boxW, boxH, maxN = 3) {
  const imgs = imgAtts(list).slice(0, maxN);
  if (!imgs.length) return [];
  const gap = 3;
  const slot = (boxW - gap * (imgs.length - 1)) / imgs.length;
  const availH = boxH - 4;
  return imgs.map((p, i) => {
    const file = path.join(UPLOAD_DIR, path.basename(String((p && p.u) || p)));
    let w = slot; let h = availH;
    try {
      const nat = imageSize(fs.readFileSync(file));
      if (nat && nat.w > 0 && nat.h > 0) {
        const k = Math.min(slot / nat.w, availH / nat.h);   // 等比缩放，整张图都放得下
        w = Math.max(16, Math.round(nat.w * k));
        h = Math.max(16, Math.round(nat.h * k));
      }
    } catch { /* 读不到尺寸就按格子大小放 */ }
    return {
      file, row, col,
      offX: Math.round(i * (slot + gap) + Math.max(0, (slot - w) / 2)),   // 每张在自己的格位里居中
      offY: 2,
      w, h,
    };
  });
}

/**
 * 附件列的文字内容：
 *   · 有可嵌入的图片 → 嵌图（同时把随附的非图片文件名列出来）
 *   · 只有非图片附件 → 列出文件名
 */
function attCellText(list) {
  const arr = Array.isArray(list) ? list : [];
  const imgs = imgAtts(arr);
  const others = arr.filter((p) => !imgs.includes(p));
  if (!imgs.length) return attText(arr);
  const extra = imgs.length > 3 ? `（共 ${imgs.length} 张）` : "";
  return attText(others) + extra;
}

/** 行高 pt → px（1pt = 1.333px），供嵌图算尺寸 */
const pt2px = (pt) => Math.round(Number(pt) * 1.333);
/** 列宽（字符）→ px（Excel 近似公式：px = 宽 × 7 + 5） */
const w2px = (w) => Math.round(Number(w) * 7 + 5);
/** 像素 → XLSX 字符宽（1 字符 ≈ 7px，下限 5） */
const pxToW = (px) => Math.max(5, Math.round(((Number(px) || 56) / 7) * 10) / 10);

/** 单行文本占几个"字符宽" —— 中文/全角按 2 算，其余按 1 算 */
const textWidth = (s) => [...String(s || "")].reduce((n, ch) => n + (/[\u1100-\u115f\u2e80-\ua4cf\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1), 0);

/**
 * 按表头文字自动撑宽列宽，保证**表头每个字都露得出来、不被遮挡**。
 * 取「印版列宽」与「表头所需宽度」的较大值；表头含换行时按最宽的一行计算。
 * @param {string[]} headers    表头文字（可含 \n）
 * @param {number[]} baseWidths 印版折算出的列宽
 */
function fitCols(headers, baseWidths) {
  return headers.map((h, i) => {
    const need = Math.max(...String(h ?? "").split("\n").map(textWidth)) + 2;   // +2 留内边距
    return Math.max(Number(baseWidths[i]) || 8.43, need);
  });
}

/** 表头行高：按表头最长行数留足高度（每行约 15pt + 上下边距） */
function headRowHeight(headers) {
  const maxLines = Math.max(...headers.map((h) => String(h ?? "").split("\n").length));
  return Math.max(32, maxLines * 15 + 10);
}

/** 四张表的表头（集中定义，供表头行与列宽自适应共用） */
const H_NOTICE = ["序号", "被检查单位", "具体地点", "隐患类别", "存在的问题或隐患", "问题或隐患图片",
  "整改措施", "整改期限", "整改责任人", "整改资金（元）", "复查\n时间", "完成\n情况", "复查人", "备注"];
const H_CLOSURE = ["序号", "被检查单位", "具体地点", "隐患类别", "存在隐患或问题", "采取的整改措施",
  "整改期限", "整改责任人", "整改情况", "完成时间", "复查人", "整改前图片", "整改后图片"];
const H_LEDGER = ["序号", "检查时间", "检查人", "隐患类别", "存在隐患或问题", "整改措施",
  "整改完成时间", "责任人", "复查时间", "复查人", "复查结果"];
const H_RAW = ["序号", "日期", "检查部位", "现场具体隐患", "检查人", "备注"];

/** 表头行对象（统一样式 2=表头） */
const thRow = (headers) => ({ h: headRowHeight(headers), cells: headers.map((v) => ({ v, s: XS.TH })) });

/* ---------------- 图片嵌入支持 ----------------
 * 纸质销号单/通知单里的「图片」列是真照片，所以导出件也要把照片**嵌进单元格**，
 * 而不是只写个文件名。这里实现最小可用的 XLSX 图片嵌入（零依赖）：
 *   · xl/media/imageN.<ext>                       图片本体
 *   · xl/drawings/drawingN.xml                    每表一份，用 oneCellAnchor 锚到单元格
 *   · xl/drawings/_rels/drawingN.xml.rels         图片关系
 *   · xl/worksheets/_rels/sheetN.xml.rels         表 → 绘图 关系
 *   · 工作表 XML 末尾加 <drawing r:id="..."/>
 *   · [Content_Types].xml 加 png/jpeg 的 Default
 */

/** 从文件头读出图片像素尺寸（PNG / JPEG / GIF）；读不出返回 null */
function imageSize(buf) {
  try {
    // PNG：IHDR 紧跟在 8 字节签名 + 4 字节长度 + 4 字节类型之后
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    // GIF：宽高为小端 16 位
    if (buf.length > 10 && buf.slice(0, 3).toString("latin1") === "GIF") {
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }
    // JPEG：扫描 SOFn 段
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        }
        i += 2 + len;
      }
    }
  } catch { /* 解析失败按未知处理 */ }
  return null;
}

/** 扩展名 → MIME（只支持可嵌入的图片类型） */
const IMG_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif" };

/** 把 px 换算成 EMU（1 px = 9525 EMU，Excel 的英制单位） */
const px2emu = (px) => Math.round(px * 9525);


/** 从隐患行取出三张表单共用的值 */
function formVals(h) {
  return {
    loc: h.location || "",
    lvl: LEVEL_LABELS[h.level] || h.level || "",
    desc: h.description || "",
    measure: h.rectifyMeasure || "",
    person: h.rectifyPerson || "",
    fund: h.rectifyFund === "" || h.rectifyFund == null ? "" : Number(h.rectifyFund),
    reviewer: h.reviewer || "",
    reviewDate: slashDate(h.reviewDate),
    result: h.reviewResult || "",
    doneDate: slashDate(h.actualCompleteDate || h.reviewDate),
    term: dayDiff(h.inspectDate, h.planDeadline),
    before: attText(h.hazardPhotos),
    after: attText(h.rectifyPhotos),
  };
}

/** ① 检查隐患问题整改通知单（14 列）
 *  版式要点（按使用者要求调整过）：
 *    · 表头**只有一行**（第 3 行）；「复查时间」「完成情况」各是**一个单元格**，格内换行
 *    · 检查说明段在 A2:K2（左上对齐）；**落款（部门 + 日期）在 L2:N2，右对齐 + 底端对齐 = 右下角**
 *    · 表尾「签发单位负责人：」与「接收单位负责人：」**同一行、一左一右**
 *      （左段 A:F 左对齐，右段 H:N 右对齐；中间留空）
 */
function sheetNotice(rows, meta) {
  const ORG = ORG_NAME();
  const NCOL = 14;
  const cols = fitCols(H_NOTICE, [24, 44, 56, 56, 143, 100, 248, 66, 66, 59, 114, 49, 51, 63].map(pxToW));
  const out = [];
  const images = [];
  out.push({ h: 36, cells: [{ v: `${ORG}检查问题整改通知单`, s: XS.TITLE }] });
  // 行2：左=说明段（A:K），右=落款（L:N，右下角）
  out.push({
    h: 78, cells: [
      { v: meta.note, s: XS.LEFT_TOP }, null, null, null, null, null, null, null, null, null, null,
      { v: `${noticeDept()}\n${cnDate(meta.today)}`, s: XS.RIGHT_BOTTOM }, null, null,
    ],
  });
  // 行3：表头（单行；行高按换行行数自适应，保证字都露出来）
  out.push(thRow(H_NOTICE));
  rows.forEach((h, i) => {
    const v = formVals(h);
    const hasImg = imgAtts(h.hazardPhotos).length > 0;
    const rh = hasImg ? 70 : 56;
    const r0 = out.length;
    out.push({
      h: rh, cells: [
        { v: i + 1, s: XS.CENTER }, { v: ORG, s: XS.CENTER }, { v: v.loc, s: XS.CENTER }, { v: v.lvl, s: XS.CENTER },
        { v: v.desc, s: XS.LEFT },
        { v: attCellText(h.hazardPhotos), s: XS.CENTER },       // F 列：问题或隐患图片（嵌图）
        { v: v.measure, s: XS.LEFT },
        { v: v.term, s: XS.CENTER }, { v: v.person, s: XS.CENTER }, { v: v.fund, s: XS.CENTER },
        { v: v.reviewDate, s: XS.CENTER }, { v: v.result, s: XS.CENTER }, { v: v.reviewer, s: XS.CENTER }, { v: "", s: XS.CENTER },
      ],
    });
    images.push(...embedImages(h.hazardPhotos, r0, 5, w2px(cols[5]), pt2px(rh)));   // F 列 = 0-based 5
  });
  const foot = out.length + 1;
  // 表尾：左右两段同一行（左段 A:F，右段 H:N）
  out.push({
    h: 32, cells: [
      { v: "签发单位负责人：", s: XS.LEFT }, null, null, null, null, null, null,
      { v: "接收单位负责人：", s: XS.RIGHT_SIGN }, null, null, null, null, null, null,
    ],
  });
  return {
    sheetName: "检查隐患问题整改通知单",
    cols,
    rows: out,
    images,
    merges: [
      `A1:${colName(NCOL)}1`,
      `A2:K2`, `L2:${colName(NCOL)}2`,
      `A${foot}:F${foot}`, `H${foot}:${colName(NCOL)}${foot}`,
    ],
  };
}

/** ② 检查问题销号申请单（13 列）
 *  版式要点（按使用者要求调整过）：
 *    · 第 2 行：左段 A:F = 「单位：…」（左对齐），右段 H:M = 「日期：…」（右对齐）
 *    · 表头只有一行（第 3 行）
 *    · 表尾「整改单位负责人：」与「主管部门负责人：」**同一行、一左一右**
 *      （左段 A:F 左对齐，右段 H:M 右对齐）；其后 2 个合并空行
 */
function sheetClosure(rows, meta) {
  const ORG = ORG_NAME();
  const NCOL = 13;
  const cols = fitCols(H_CLOSURE, [24, 95, 70, 56, 200, 280, 60, 70, 60, 80, 60, 90, 90].map(pxToW));
  const out = [];
  const images = [];
  out.push({ h: 36, cells: [{ v: `${ORG}检查问题销号申请单`, s: XS.TITLE }] });
  // 行2：左=单位（A:F），右=日期（H:M）
  out.push({
    h: 26, cells: [
      { v: `单位：${ORG}`, s: XS.LEFT }, null, null, null, null, null, null,
      { v: `日期：${cnDate(meta.today)}`, s: XS.RIGHT }, null, null, null, null, null,
    ],
  });
  out.push(thRow(H_CLOSURE));
  rows.forEach((h, i) => {
    const v = formVals(h);
    // 有照片的行适当加高，保证图片看得清
    const hasImg = imgAtts(h.hazardPhotos).length > 0 || imgAtts(h.rectifyPhotos).length > 0;
    const rh = hasImg ? 70 : 56;
    const r0 = out.length;                       // 本行的 0-based 行号
    out.push({
      h: rh, cells: [
        { v: i + 1, s: XS.CENTER }, { v: ORG, s: XS.CENTER }, { v: v.loc, s: XS.CENTER }, { v: v.lvl, s: XS.CENTER },
        { v: v.desc, s: XS.LEFT }, { v: v.measure, s: XS.LEFT }, { v: v.term, s: XS.CENTER },
        { v: v.person, s: XS.CENTER }, { v: v.result, s: XS.CENTER }, { v: v.doneDate, s: XS.CENTER },
        { v: v.reviewer, s: XS.CENTER },
        { v: attCellText(h.hazardPhotos), s: XS.CENTER },      // L 列：整改前图片（嵌图，文字兜底）
        { v: attCellText(h.rectifyPhotos), s: XS.CENTER },     // M 列：整改后图片
      ],
    });
    // 把照片锚到 L / M 列（0-based 列号 11 / 12）
    images.push(...embedImages(h.hazardPhotos, r0, 11, w2px(cols[11]), pt2px(rh)));
    images.push(...embedImages(h.rectifyPhotos, r0, 12, w2px(cols[12]), pt2px(rh)));
  });
  // 表尾：左右两段同一行（左段 A:F，右段 H:M），其后 2 个合并空行
  const f1 = out.length + 1; const f2 = out.length + 2; const f3 = out.length + 3;
  out.push({
    h: 32, cells: [
      { v: "整改单位负责人：", s: XS.LEFT }, null, null, null, null, null, null,
      { v: "主管部门负责人：", s: XS.RIGHT_SIGN }, null, null, null, null, null,
    ],
  });
  out.push({ h: 20, cells: [{ v: "", s: XS.NOTE }] });
  out.push({ h: 20, cells: [{ v: "", s: XS.NOTE }] });
  return {
    sheetName: "检查问题销号申请单",
    cols,
    rows: out,
    images,
    merges: [
      `A1:${colName(NCOL)}1`,
      `A2:F2`, `H2:${colName(NCOL)}2`,
      `A${f1}:F${f1}`, `H${f1}:${colName(NCOL)}${f1}`,
      `A${f2}:M${f2}`, `A${f3}:M${f3}`,
    ],
  };
}

/** ③ 安全隐患整改治理台账（隐患登记，11 列） */
function sheetLedger(rows, meta) {
  const ORG = ORG_NAME();
  const NCOL = 11;
  const out = [];
  out.push({ h: 34, cells: [{ v: "安全隐患整改治理台账", s: XS.TITLE }] });
  out.push({ cells: [{ v: `单位：${ORG}`, s: XS.NOTE }] });
  out.push(thRow(H_LEDGER));
  rows.forEach((h, i) => {
    const v = formVals(h);
    out.push({
      h: 56, cells: [
        { v: i + 1, s: XS.CENTER }, { v: slashDate(h.inspectDate), s: XS.CENTER }, { v: h.inspector || "", s: XS.CENTER },
        { v: v.lvl, s: XS.CENTER }, { v: v.desc, s: XS.LEFT }, { v: v.measure, s: XS.LEFT },
        { v: v.doneDate, s: XS.CENTER }, { v: v.person, s: XS.CENTER }, { v: v.reviewDate, s: XS.CENTER },
        { v: v.reviewer, s: XS.CENTER }, { v: v.result, s: XS.CENTER },
      ],
    });
  });
  return {
    sheetName: "安全隐患整改治理台账",
    cols: fitCols(H_LEDGER, [44, 114, 119, 119, 236, 338, 116, 67, 116, 67, 73].map(pxToW)),
    images: [],
    rows: out,
    merges: [`A1:${colName(NCOL)}1`, `A2:${colName(NCOL)}2`],
  };
}

/** ④ 原始检查记录表（6 列）
 *  对应印版第 1 张表：只有标题、单行表头、数据，末行为「检查人员签字：」（A:F 合并）。
 */
function sheetRaw(rows) {
  const NCOL = 6;
  const out = [];
  out.push({ h: 34, cells: [{ v: "原始检查记录表", s: XS.TITLE }] });
  out.push(thRow(H_RAW));
  rows.forEach((h, i) => {
    out.push({
      h: 46, cells: [
        { v: i + 1, s: XS.CENTER }, { v: slashDate(h.inspectDate), s: XS.CENTER },
        { v: h.location || "", s: XS.CENTER }, { v: h.description || "", s: XS.LEFT },
        { v: h.inspector || "", s: XS.CENTER }, { v: "", s: XS.CENTER },
      ],
    });
  });
  const foot = out.length + 1;
  out.push({ h: 30, cells: [{ v: "检查人员签字：", s: XS.NOTE }] });
  return {
    sheetName: "原始检查记录",
    cols: fitCols(H_RAW, [44, 114, 130, 380, 120, 160].map(pxToW)),
    images: [],
    rows: out,
    merges: [`A1:F1`, `A${foot}:F${foot}`],
  };
}

/**
 * ⑤ 全部表单（合并导出）
 *  把四张表放进**同一个工作簿**，用 sheet 区分 —— 与公司印版工作簿的结构一致。
 *  sheet 顺序也照印版：原始检查记录 → 整改通知单 → 销号申请单 → 登记台账。
 */
const sheetAll = (rows, meta) => [sheetRaw(rows, meta), sheetNotice(rows, meta), sheetClosure(rows, meta), sheetLedger(rows, meta)];

/**
 * 导出隐患台账。支持与列表一致的筛选参数。
 *   GET /api/export?format=xlsx|csv&template=notice|closure|ledger
 *   · xlsx + template → 生成对应的**纸质表单**版式（表头与公司现行表单一一对应）
 *   · xlsx 无 template → 保留旧的扁平台账（17 列）
 *   · csv → 始终为扁平明细（便于二次处理）
 * 导出行为本身也会写入操作日志（export_hazard）。
 */
async function handleExport(res, url, user) {
  const q = url.searchParams;
  const format = (q.get("format") || "xlsx").toLowerCase();
  const today = localDateStr();

  // template：四张纸质表单 + 合并导出；未指定则导出旧的扁平台账
  const TEMPLATE_NAMES = {
    all: "安全检查隐患问题整改通知单、销号单、登记表",
    notice: "检查问题整改通知单",
    closure: "检查问题销号申请单",
    ledger: "安全隐患整改治理台账",
    raw: "原始检查记录表",
  };
  const TEMPLATE_BUILDERS = {
    all: sheetAll, notice: sheetNotice, closure: sheetClosure, ledger: sheetLedger, raw: sheetRaw,
  };
  const tRaw = (q.get("template") || "").trim().toLowerCase();
  const template = TEMPLATE_BUILDERS[tRaw] ? tRaw : "";

  const { where, params } = buildHazardWhere(q, today);
  // 与列表页共用同一套筛选 SQL（含「逾期/未闭环」派生状态），口径完全一致
  const r = await pool.query(
    `SELECT * FROM hazard WHERE ${where} ORDER BY inspect_date DESC, created_at DESC`, params
  );
  const rows = r.rows.map((x) => rowToHazard(x, today));

  // 表单抬头说明段：日期区间取本次实际导出的记录范围
  const dates = rows.map((h) => h.inspectDate).filter(Boolean).sort();
  const dFrom = dates[0] || today;
  const dTo = dates[dates.length - 1] || today;
  const rangeText = dFrom === dTo ? cnDate(dFrom) : `${cnDate(dFrom)}至${cnDate(dTo)}`;
  const meta = {
    today,
    note: `${rangeText}，我公司组织开展了安全隐患排查，共发现 ${rows.length} 项问题，`
      + "请各责任单位按照整改措施和时间要求认真整改，并将整改情况填写销号申请表及时反馈至安全部进行销号。",
  };

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

  await logOp(user, "export_hazard", {
    targetType: "hazard",
    detail: `导出 ${rows.length} 条（${format.toUpperCase()}${TEMPLATE_NAMES[template] ? "·" + TEMPLATE_NAMES[template] : ""}）`,
  });

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

  // 按 template 生成纸质表单版式；未指定则用旧的扁平台账
  const spec = template ? TEMPLATE_BUILDERS[template](rows, meta) : {
    sheetName: "隐患台账", cols: [], images: [], rows: [
      { h: 24, cells: headers.map((x) => ({ v: x, s: XS.TH })) },
      ...data.map((row) => ({ cells: row.map((v) => ({ v, s: XS.CENTER })) })),
    ], merges: [],
  };

  // format=json：把「版式规格」原样返回，供**打印**复用同一套版式（保证打印与导出格式一致）
  if (format === "json") {
    const toUrls = (s) => ({
      ...s,
      images: (s.images || []).map((im) => ({ ...im, url: `/uploads/${path.basename(im.file)}` })),
    });
    const sheets = (Array.isArray(spec) ? spec : [spec]).map(toUrls);
    return sendJson(res, { sheets, template: template || "", count: rows.length });
  }

  const buf = buildXlsx(spec);
  const fname = template ? `${TEMPLATE_NAMES[template]}_${stamp}.xlsx` : `hazard_${stamp}.xlsx`;
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${encodeURIComponent(fname)}"; filename*=UTF-8''${encodeURIComponent(fname)}`,
    "Content-Length": buf.length,
  });
  return res.end(buf);
}

/* ---------------- 附件上传 ----------------
 * 支持**图片**与**常用办公文档**两类附件。
 *   · 图片：前端先用 canvas 压缩（长边 1600px / JPEG 0.82）再上传，限 8MB
 *   · 文档：PDF / Word / Excel 原样上传（不压缩），限 20MB
 * 落盘文件名统一为「随机24位hex + 原扩展名」，不可枚举、不会重名。
 */
const MB = 1024 * 1024;
const UPLOAD_TYPES = {
  // —— 图片 ——
  "image/jpeg": { ext: ".jpg", kind: "image", max: 8 * MB },
  "image/jpg": { ext: ".jpg", kind: "image", max: 8 * MB },
  "image/png": { ext: ".png", kind: "image", max: 8 * MB },
  "image/webp": { ext: ".webp", kind: "image", max: 8 * MB },
  "image/gif": { ext: ".gif", kind: "image", max: 8 * MB },
  // —— 文档 ——
  "application/pdf": { ext: ".pdf", kind: "doc", max: 20 * MB },
  "application/msword": { ext: ".doc", kind: "doc", max: 20 * MB },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { ext: ".docx", kind: "doc", max: 20 * MB },
  "application/vnd.ms-excel": { ext: ".xls", kind: "doc", max: 20 * MB },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { ext: ".xlsx", kind: "doc", max: 20 * MB },
};
const MAX_UPLOAD_BYTES = 20 * MB;   // 单文件解码后上限（base64 传输时约需 1.4 倍）

/** 判断一个附件 URL 是否是图片（供前端之外的服务端场景复用） */
const IMAGE_URL_RE = /\.(jpe?g|png|webp|gif)$/i;

/**
 * POST /api/upload  { dataUrl: "data:image/png;base64,..." }
 * 落盘为 uploads/<随机24位hex>.<ext>，返回 { url: "/uploads/xxx", size }。
 * 文件名随机 → 不可枚举；不校验登录后才能读图（因 <img> 无法携带鉴权头）。
 */
  async function handleUpload(req, res, user) {
    if (req.method !== "POST") return sendJson(res, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持的方法" } }, 405);
    let body;
    try { body = await readBody(req, MAX_UPLOAD_BYTES * 2); } catch (e) { return badRequest(res, e.message); }

    const dataUrl = String(body.dataUrl || "");
    // 注意：MIME 里可能带 + - . 等字符（如 openxmlformats 那一长串），正则要放宽
    const m = dataUrl.match(/^data:([a-zA-Z0-9/+.\-]+);base64,([A-Za-z0-9+/=\s]+)$/);
    if (!m) return badRequest(res, "文件格式错误（需为 dataURL）");

    const mime = m[1].toLowerCase();
    const type = UPLOAD_TYPES[mime];
    if (!type) {
      return badRequest(res, `不支持的文件类型：${mime}。仅支持 JPG/PNG/WEBP/GIF 图片与 PDF/Word/Excel 文档`);
    }

    let buf;
    try { buf = Buffer.from(m[2].replace(/\s/g, ""), "base64"); } catch { return badRequest(res, "文件解码失败"); }
    if (buf.length === 0) return badRequest(res, "文件内容为空");
    if (buf.length > type.max) {
      return badRequest(res, `文件过大（${type.kind === "image" ? "图片" : "文档"}限 ${Math.round(type.max / 1024 / 1024)}MB）`);
    }

    const filename = `${genId()}${type.ext}`;
    try {
      await fs.promises.writeFile(path.join(UPLOAD_DIR, filename), buf);
    } catch (e) {
      console.error("[UPLOAD]", e);
      return sendJson(res, { error: { code: "INTERNAL_ERROR", message: "文件保存失败" } }, 500);
    }
    console.log(`[UPLOAD] ${user?.user_name || "-"} → ${filename} (${(buf.length / 1024).toFixed(0)}KB, ${type.kind})`);
    return sendJson(res, { url: `/uploads/${filename}`, size: buf.length, kind: type.kind, mime }, 201);
  }

/* ---------------- 图片维护：统计 / 清理无引用图片 ----------------
 * 背景：照片是"选择即上传"，用户若只上传未提交表单就会留下**孤儿文件**。
 *   GET  /api/photos  统计（文件总数 / 占用空间 / 被引用 / 无引用）
 *   POST /api/photos  删除所有无引用文件并写日志
 * 安全保证：只删除"磁盘上存在、但任何隐患记录的 hazard_photos / rectify_photos
 *           都未引用"的文件；**被引用的图片绝不会被删**。
 * 仅系统管理员可访问。
 */

/** 汇总数据库里所有被引用的图片文件名（去掉 /uploads/ 前缀，便于与磁盘文件名比对）
 *  ⚠️ parsePhotos() 返回的是 {u,n} 对象（兼容旧的纯字符串格式），
 *     这里必须取 .u，不能直接当字符串用 —— 曾经因为这一点导致本接口 500。 */
async function getReferencedPhotos() {
  const r = await pool.query("SELECT hazard_photos, rectify_photos FROM hazard");
  const set = new Set();
  for (const row of r.rows) {
    for (const raw of [row.hazard_photos, row.rectify_photos]) {
      for (const p of parsePhotos(raw)) set.add(p.u.replace(/^\/uploads\//, ""));
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

      // 「可选整改责任人」下拉数据：任意登录用户可用（录入人员也需要选责任人）。
      // 只回 id / 姓名 / 角色，不含任何凭据信息。
      // 可见性规则（2026-09-28 用户明确）：**admin 只有 admin 本人看得见**——
      //   请求者是管理员的 → 列表里带上 admin（他自己要能被选）；
      //   请求者是普通用户的 → 把 admin 过滤掉（普通员工选人时不该看到管理账号）。
      if (p === "/api/user-options") {
        const includeAdmin = sessionUser && sessionUser.role === "admin";
        const r = await pool.query(
          "SELECT id, user_name, role, department FROM users "
          + (includeAdmin ? "" : "WHERE role <> 'admin' ")
          + "ORDER BY COALESCE(department, '\uffff'), user_name"
        );
        return sendJson(res, {
          departments: DEPARTMENTS,
          items: r.rows.map((u) => ({ id: u.id, userName: u.user_name, role: u.role, department: u.department || "" })),
        });
      }

      // 未修改初始密码的用户：除「改密 / 登出 / 会话查询」（都在 /api/auth 下）外一律拒绝。
      // 说明：前端本来就会弹窗提醒改密，但那只是体验层，直接调 API 就能绕过；
      //       这里才是真正的强制点。
      if (sessionUser.must_change_password && p !== "/api/auth") {
        return sendJson(res, {
          error: { code: "MUST_CHANGE_PASSWORD", message: "请先修改初始密码后再使用系统" },
        }, 403);
      }

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
    // 启动横幅**不打印账号口令** —— 该窗口和 server-out.log 都可能被无关人员看到
    console.log("  按 Ctrl+C 停止服务");
    console.log("======================================================");
  });
})();

process.on("SIGINT", () => { console.log("\n正在关闭服务..."); server.close(() => pool.end().then(() => process.exit(0))); });
process.on("SIGTERM", () => { server.close(() => pool.end().then(() => process.exit(0))); });
