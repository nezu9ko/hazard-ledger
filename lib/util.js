/**
 * 通用工具（口令散列、登录失败限流、日期、JSON 响应、请求体读取）
 *
 * ⚠️ 本文件原在 `server.js` 里，2026-09-29 按功能拆分到 lib/ 下。
 *    顶部的 require 是"本文件实际用到什么就引什么"生成的；
 *    想知道本模块跟谁耦合，看顶部那几行就够了。
 */

"use strict";

const crypto = require("node:crypto");
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


module.exports = {
  sha256,
  SCRYPT,
  SCRYPT_PREFIX,
  makePasswordHash,
  hashPasswordLegacy,
  verifyPassword,
  MAX_LOGIN_FAILS,
  LOGIN_LOCK_MINUTES,
  loginFails,
  loginLockRemain,
  recordLoginFail,
  clearLoginFails,
  genId,
  localDateStr,
  isRealDate,
  shiftDate,
  sendJson,
  badRequest,
  notFound,
  readBody,
};
