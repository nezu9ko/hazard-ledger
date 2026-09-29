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
 * 【代码结构导航】（2026-09-29 起按功能拆分到 lib/ 下）
 *   本文件只做三件事：起 HTTP 服务 → 解析 URL/鉴权/分发路由 → 启动与优雅退出。
 *   具体实现见 lib/：
 *     lib/config.js              配置加载（端口 / 数据库连接）与枚举常量
 *     lib/util.js                sendJson / readBody / 日期与口令散列工具
 *     lib/models.js              rowToHazard / rowToUser / parsePhotos（行 ↔ 前端 JSON）
 *     lib/authz.js               会话令牌 / 权限矩阵 requiredRoles / 操作日志 logOp
 *     lib/db.js                  连接池 / initDatabase() 建库建表 + 播种 admin
 *     lib/xlsx.js                零依赖 xlsx 写出（ZIP/CRC/图片嵌入）
 *     lib/forms.js               四张纸质表单版式
 *     lib/handlers/auth-users.js handleAuth / handleUsers / handleDepartments
 *     lib/handlers/hazards.js    handleHazards / handleStats / handleLogs / handleReminders / handleSeed
 *     lib/handlers/export.js     handleExport
 *     lib/handlers/files.js      handleUpload / handlePhotosMaintenance / 静态托管
 *     lib/handlers/import.js     handleImport
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
/* ---------------------------------------------------------------------------
 * 业务模块
 *   server.js 现在只负责三件事：① 起 HTTP 服务 ② 解析 URL/鉴权/分发路由 ③ 启动。
 *   具体业务都拆到 lib/ 下（拆分时间 2026-09-29）：
 *     lib/config.js              配置与枚举常量
 *     lib/util.js                口令散列 / 日期 / 响应 / 读请求体
 *     lib/models.js              行 ↔ JSON 映射、筛选 SQL、附件规范化
 *     lib/authz.js               会话令牌、权限矩阵、操作日志
 *     lib/db.js                  连接池、建库建表、字段注释
 *     lib/xlsx.js                零依赖 xlsx 写出（ZIP/CRC）
 *     lib/forms.js               四张纸质表单版式
 *     lib/handlers/*.js          各接口的具体实现
 * ------------------------------------------------------------------------- */
const { CFG } = require("./lib/config.js");
const { sendJson, badRequest, notFound, readBody } = require("./lib/util.js");
const { getSessionUser, bearerToken, requiredRoles } = require("./lib/authz.js");
const { initDatabase, pool } = require("./lib/db.js");
const { handleExport } = require("./lib/handlers/export.js");
const { MAX_UPLOAD_BYTES, handleUpload, handlePhotosMaintenance, serveStatic, serveUpload } = require("./lib/handlers/files.js");
const { handleAuth, handleUsers, handleDepartments } = require("./lib/handlers/auth-users.js");
const { handleStats, handleHazards, handleSeed, handleLogs, handleReminders } = require("./lib/handlers/hazards.js");
const { handleImport } = require("./lib/handlers/import.js");
const http = require("node:http");

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
        const dr = await pool.query("SELECT name FROM departments ORDER BY sort_order, name");
        return sendJson(res, {
          departments: dr.rows.map((x) => x.name),
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
    if (p === "/api/departments") return await handleDepartments(req, res, url, null, sessionUser);
    if (p.startsWith("/api/departments/")) return await handleDepartments(req, res, url, p.slice("/api/departments/".length), sessionUser);
    if (p === "/api/import") {
      let b; try { b = await readBody(req, MAX_UPLOAD_BYTES * 2); } catch (e) { return badRequest(res, e.message); }
      return await handleImport(req, res, b, sessionUser);
    }
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

