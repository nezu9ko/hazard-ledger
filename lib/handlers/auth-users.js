/**
 * 登录/会话（/api/auth）+ 用户管理（/api/users）+ 部门字典（/api/departments）
 *
 * ⚠️ 本文件原在 `server.js` 里，2026-09-29 按功能拆分到 lib/ 下。
 *    顶部的 require 是"本文件实际用到什么就引什么"生成的；
 *    想知道本模块跟谁耦合，看顶部那几行就够了。
 */

"use strict";

const { DEFAULT_INITIAL_PASSWORD, ROLES } = require("../config.js");
const { makePasswordHash, verifyPassword, MAX_LOGIN_FAILS, LOGIN_LOCK_MINUTES, loginLockRemain, recordLoginFail, clearLoginFails, genId, sendJson, badRequest, notFound, readBody } = require("../util.js");
const { rowToUser } = require("../models.js");
const { createSession, getSessionUser, destroySession, bearerToken, logOp } = require("../authz.js");
const { pool } = require("../db.js");

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
/* ---------------- 部门字典 ----------------
 *   GET    /api/departments            列出（任意已登录用户即可 —— 选择器和筛选都要用）
 *   POST   /api/departments            新增（仅 admin）
 *   PATCH  /api/departments/:name      改名（仅 admin）—— 会同步改所有用户身上的部门名
 *   DELETE /api/departments/:name      删除（仅 admin）—— 还有人挂在这个部门下就拒绝
 *
 * 为什么改成存库：原来是写死在代码里的常量，加个部门要找开发改代码、重启服务。
 * 现在管理员在「用户管理 → 部门管理」里自己维护。
 */
async function handleDepartments(req, res, url, name, user) {
  if (!name) {
    if (req.method === "GET") {
      const r = await pool.query("SELECT name FROM departments ORDER BY sort_order, name");
      return sendJson(res, { items: r.rows.map((x) => x.name) });
    }
    if (req.method === "POST") {
      let body;
      try { body = await readBody(req); } catch (e) { return badRequest(res, e.message); }
      const nm = String(body.name || "").trim();
      if (!nm) return badRequest(res, "请输入部门名称");
      if (nm.length > 30) return badRequest(res, "部门名称过长（不超过 30 字）");
      if (/[\r\n\t]/.test(nm)) return badRequest(res, "部门名称不能包含换行或制表符");
      const dup = await pool.query("SELECT 1 FROM departments WHERE name = $1", [nm]);
      if (dup.rowCount > 0) return badRequest(res, `部门「${nm}」已存在`);
      const mx = await pool.query("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM departments");
      await pool.query("INSERT INTO departments (name, sort_order) VALUES ($1,$2)", [nm, mx.rows[0].n]);
      await logOp(user, "create_department", { targetType: "department", targetCode: nm, detail: `新增部门：${nm}` });
      return sendJson(res, { success: true, name: nm }, 201);
    }
    return sendJson(res, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持的方法" } }, 405);
  }

  // 带名字：改名 / 删除
  const old = decodeURIComponent(name);
  const found = await pool.query("SELECT * FROM departments WHERE name = $1", [old]);
  if (found.rowCount === 0) return notFound(res, "部门不存在");

  if (req.method === "DELETE") {
    const used = await pool.query("SELECT COUNT(*)::int AS c FROM users WHERE department = $1", [old]);
    if (used.rows[0].c > 0) {
      return badRequest(res, `还有 ${used.rows[0].c} 个用户属于「${old}」，请先把他们改到别的部门再删除`);
    }
    await pool.query("DELETE FROM departments WHERE name = $1", [old]);
    await logOp(user, "delete_department", { targetType: "department", targetCode: old, detail: `删除部门：${old}` });
    return sendJson(res, { success: true });
  }

  if (req.method === "PATCH") {
    let body;
    try { body = await readBody(req); } catch (e) { return badRequest(res, e.message); }
    const nm = String(body.name || "").trim();
    if (!nm) return badRequest(res, "请输入新的部门名称");
    if (nm.length > 30) return badRequest(res, "部门名称过长（不超过 30 字）");
    if (nm === old) return sendJson(res, { success: true, name: nm });
    const dup = await pool.query("SELECT 1 FROM departments WHERE name = $1", [nm]);
    if (dup.rowCount > 0) return badRequest(res, `部门「${nm}」已存在`);
    // 改名要**同时改用户身上的部门**，否则这些用户会变成"不属于任何部门"（部门筛选就查不到了）
    const moved = await pool.query("UPDATE users SET department = $1 WHERE department = $2", [nm, old]);
    await pool.query("UPDATE departments SET name = $1 WHERE name = $2", [nm, old]);
    await logOp(user, "rename_department", {
      targetType: "department", targetCode: old,
      detail: `部门改名：${old} → ${nm}（同步更新 ${moved.rowCount} 个用户）`,
    });
    return sendJson(res, { success: true, name: nm, usersMoved: moved.rowCount });
  }
  return sendJson(res, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持的方法" } }, 405);
}

module.exports = {
  handleAuth,
  handleUsers,
  handleDepartments,
};
