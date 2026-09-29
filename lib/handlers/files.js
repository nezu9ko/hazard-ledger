/**
 * 附件与静态资源：上传、图片维护（统计/清理无引用）、静态托管兜底
 *
 * ⚠️ 本文件原在 `server.js` 里，2026-09-29 按功能拆分到 lib/ 下。
 *    顶部的 require 是"本文件实际用到什么就引什么"生成的；
 *    想知道本模块跟谁耦合，看顶部那几行就够了。
 */

"use strict";

const { PUBLIC_DIR, UPLOAD_DIR } = require("../config.js");
const { genId, sendJson, badRequest, readBody } = require("../util.js");
const { parsePhotos } = require("../models.js");
const { logOp } = require("../authz.js");
const { pool } = require("../db.js");
const fs = require("node:fs");
const path = require("node:path");
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
/** 允许的图片扩展名集合（从 UPLOAD_TYPES 反推，供导入嵌入图时校验，避免两处各写一份名单） */
const UPLOAD_IMAGE_EXTS = new Set(Object.values(UPLOAD_TYPES).filter((t) => t.kind === "image").map((t) => t.ext));

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


module.exports = {
  MB,
  UPLOAD_TYPES,
  MAX_UPLOAD_BYTES,
  UPLOAD_IMAGE_EXTS,
  IMAGE_URL_RE,
  handleUpload,
  getReferencedPhotos,
  listUploadFiles,
  handlePhotosMaintenance,
  MIME,
  serveStatic,
  serveUpload,
};
