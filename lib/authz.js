/**
 * 鉴权与会话（令牌签发/校验、权限矩阵、操作日志落库）
 *
 * ⚠️ 本文件原在 `server.js` 里，2026-09-29 按功能拆分到 lib/ 下。
 *    顶部的 require 是"本文件实际用到什么就引什么"生成的；
 *    想知道本模块跟谁耦合，看顶部那几行就够了。
 */

"use strict";

const { genId } = require("./util.js");
const { pool } = require("./db.js");
const path = require("node:path");
const crypto = require("node:crypto");

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
  if (path === "/api/import") return ["admin"];      // 批量导入：仅系统管理员
  // 部门字典：看得到就行（选择器/筛选都要用）；增删改仅系统管理员
  if (path === "/api/departments") return method === "GET" ? null : ["admin"];
  if (path.startsWith("/api/departments/")) return ["admin"];
  // 操作日志（仅系统管理员）
  if (path === "/api/logs") return ["admin"];
  // 图片维护（仅系统管理员）
  if (path === "/api/photos") return ["admin"];
  // 导出
  if (path === "/api/export") return null;
  return null;
}

module.exports = {
  SESSION_TTL_MS,
  createSession,
  getSessionUser,
  destroySession,
  bearerToken,
  ACTION_LABELS,
  logOp,
  requiredRoles,
};
