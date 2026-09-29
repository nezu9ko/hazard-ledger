/**
 * 台账导入 /api/import（xlsx → 系统；两段式：先预览，commit 才写库）
 *
 * ⚠️ 本文件原在 `server.js` 里，2026-09-29 按功能拆分到 lib/ 下。
 *    顶部的 require 是"本文件实际用到什么就引什么"生成的；
 *    想知道本模块跟谁耦合，看顶部那几行就够了。
 */

"use strict";

const { UPLOAD_DIR, DEFAULT_INITIAL_PASSWORD } = require("../config.js");
const { makePasswordHash, genId, localDateStr, sendJson, badRequest } = require("../util.js");
const { logOp } = require("../authz.js");
const { pool } = require("../db.js");
const { MB, MAX_UPLOAD_BYTES, UPLOAD_IMAGE_EXTS } = require("./files.js");
const fs = require("node:fs");
const path = require("node:path");
const { parseHazardWorkbook } = require("../../tools/xlsx-import");
/* ---------------- 台账导入 ----------------
 *   POST /api/import        （仅系统管理员）
 *
 * 两段式设计（重要）：
 *   ① body.commit !== true  → **只解析不写库**，返回"将会发生什么"：能导几条、哪些重复、
 *      哪些缺字段、要新建哪些用户、每条的字段预览。前端先给用户看这个。
 *   ② body.commit === true  → 真正写库。
 * 为什么不做成一步：导入是**批量写**，一旦选错文件/选错 sheet 就是脏数据，
 * 预览一次的成本远低于事后清理。
 *
 * 支持的文件：.xlsx（零依赖自研读取器，见 tools/xlsx-read.js）。
 */
async function handleImport(req, res, body, user) {
  if (req.method !== "POST") return sendJson(res, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持的方法" } }, 405);

  const dataUrl = String(body.dataUrl || "");
  const m = dataUrl.match(/^data:([a-zA-Z0-9/+.\-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!m) return badRequest(res, "文件格式错误（需为 dataURL）");
  const mime = m[1].toLowerCase();
  if (!/spreadsheetml|ms-excel|sheet/.test(mime)) {
    return badRequest(res, `只支持 .xlsx 文件（当前是 ${mime}）。老式 .xls 请先用 Excel 另存为 .xlsx`);
  }
  let buf;
  try { buf = Buffer.from(m[2].replace(/\s/g, ""), "base64"); } catch { return badRequest(res, "文件解码失败"); }
  if (!buf.length) return badRequest(res, "文件内容为空");
  if (buf.length > MAX_UPLOAD_BYTES) return badRequest(res, `文件过大（上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB）`);

  // —— 解析（纯函数，不碰库）——
  let parsed;
  try {
    parsed = parseHazardWorkbook(buf);
  } catch (e) {
    return badRequest(res, `读取失败：${e.message}`);
  }
  if (!parsed.ok) return sendJson(res, { ok: false, error: parsed.error, sheets: parsed.sheets }, 400);

  const today = localDateStr();
  const opt = body.options || {};
  const reviewerName = String(opt.reviewer || "").trim();          // 统一指定的复查人
  const createMissing = opt.createMissingUsers !== false;          // 默认自动建缺的人
  const newUserDept = String(opt.newUserDepartment || "安全部").trim();
  const allowDup = opt.allowDuplicates === true;                   // 默认跳过重复

  // —— 存量：已有用户（按姓名找）与已有隐患（判重）——
  const ur = await pool.query("SELECT id, user_name, role, department FROM users");
  const userByName = {};
  ur.rows.forEach((u) => { userByName[u.user_name] = u; });

  const existing = await pool.query("SELECT location, description FROM hazard");
  const dupKeys = new Set(existing.rows.map((r) => `${String(r.location || "").trim()}|${String(r.description || "").trim()}`));

  // —— 逐条体检：能不能导、缺什么、责任人/复查人对不对得上 ——
  const preview = [];
  const missingPersons = new Set();
  let dupCount = 0;
  for (const it of parsed.items) {
    const issues = [...it._problems];
    let action = "create";

    if (!allowDup && dupKeys.has(`${it.location}|${it.description}`)) { action = "skip"; dupCount += 1; issues.push("库中已有同样「部位+描述」的记录，默认跳过"); }
    else if (it._problems.length) { action = "skip"; }

    const rp = it.rectifyPerson ? userByName[it.rectifyPerson] : null;
    if (it.rectifyPerson && !rp) {
      if (createMissing) { missingPersons.add(it.rectifyPerson); issues.push(`系统里没有「${it.rectifyPerson}」，导入时会自动建账号`); }
      else issues.push(`系统里没有「${it.rectifyPerson}」，将只记录姓名、不绑定账号`);
    }
    if (reviewerName && !userByName[reviewerName]) issues.push(`指定的复查人「${reviewerName}」不在系统里`);

    preview.push({
      rowNo: it.rowNo, action, issues,
      inspectDate: it.inspectDate, inspector: it.inspector, location: it.location,
      description: it.description, level: it.level, category: it.category,
      categoryGuessed: it.categoryGuessed,
      rectifyPerson: it.rectifyPerson, rectifyFund: it.rectifyFund, planDeadline: it.planDeadline,
      rectifyMeasureLen: (it.rectifyMeasure || "").length,
      photoCount: (it.photoIds || []).length,
      photoNames: (it.photos || []).map((x) => x.name).filter(Boolean),
      reviewer: it.reviewer || "",
      linkedUser: rp ? rp.id : null,
    });
  }

  const willCreate = preview.filter((p) => p.action === "create");
  const summary = {
    ok: true,
    commit: false,
    file: { sheets: parsed.sheets, sheetName: parsed.sheetName, headerRow: parsed.headerRow, imageCount: parsed.imageCount },
    notes: parsed.notes,
    total: parsed.total,
    creatable: willCreate.length,
    duplicated: dupCount,
    problematic: parsed.badItems.length,
    willCreateUsers: [...missingPersons],
    reviewer: reviewerName || "(未指定)",
    photoTotal: parsed.photoTotal || 0,
    preview,
  };
  if (body.commit !== true) return sendJson(res, summary, 200);

  // ================= 真正写库 =================
  // ① 先把缺的责任人建出来（复用系统的用户创建口径：初始口令 + 首登强制改密）
  const createdUsers = [];
  for (const name of missingPersons) {
    const uid = genId();
    const ph = makePasswordHash(DEFAULT_INITIAL_PASSWORD);
    try {
      await pool.query(
        "INSERT INTO users (id,user_id,user_name,role,department,salt,password_hash,must_change_password) VALUES ($1,$2,$3,'user',$4,$5,$6,TRUE)",
        [uid, `u_${Date.now()}${Math.floor(Math.random() * 1000)}`, name, newUserDept, ph.salt, ph.hash]
      );
      userByName[name] = { id: uid, user_name: name, role: "user", department: newUserDept };
      createdUsers.push(name);
      await logOp(user, "create_user", { targetType: "user", targetId: uid, targetCode: name, detail: `导入台账时自动创建｜部门：${newUserDept}` });
    } catch (e) {
      console.error("[IMPORT] 建用户失败:", name, e.message);
    }
  }

  // ② 逐条插入（每条单独 try，一条坏不影响其余，最后汇总）
  const reviewerUser = reviewerName ? userByName[reviewerName] : null;
  let created = 0;
  let photosSaved = 0;
  const errors = [];
  for (const it of parsed.items) {
    if (!allowDup && dupKeys.has(`${it.location}|${it.description}`)) continue;
    if (it._problems.length) { errors.push({ rowNo: it.rowNo, msg: it._problems.join("；") }); continue; }
    try {
      // 编号按**排查日期**发，不是按今天 —— 导入的历史数据应当保持"那天发现的"这一口径
      const datePart = it.inspectDate.replace(/-/g, "");
      const seq = await pool.query(
        "INSERT INTO counters (date_part, n) VALUES ($1,1) ON CONFLICT (date_part) DO UPDATE SET n = counters.n + 1 RETURNING n",
        [datePart]
      );
      const hazardCode = `YH-${datePart}-${String(seq.rows[0].n).padStart(4, "0")}`;

      const rp = it.rectifyPerson ? userByName[it.rectifyPerson] : null;
      // 复查人：原表填了就用原表的；否则用调用方统一指定的那位
      const rvName = it.reviewer || (reviewerUser ? reviewerUser.user_name : "");
      const rv = rvName ? userByName[rvName] : null;
      // 原表已填了复查结果的，按"已闭环"导入，否则一律"待整改"
      const closed = !!(it.reviewResult && (it.actualCompleteDate || it.reviewResult));
      const status = closed ? "closed" : "pending";

      // 先把这一行的嵌入图落到 uploads/，再入库（图片写失败不影响这条隐患本身，但要记下来）
      const hazardPhotos = [];
      for (const ph of it.photos || []) {
        const src = parsed.images[ph.id];
        if (!src || !src.buffer) continue;
        const ext = "." + (src.ext || "jpg");
        // 只收系统本身就支持的那几种图片扩展名（从 UPLOAD_TYPES 反推，避免两处各写一份名单）
        if (!UPLOAD_IMAGE_EXTS.has(ext)) {
          errors.push({ rowNo: it.rowNo, msg: `图片格式不支持（${ext}），已跳过该图` });
          continue;
        }
        if (src.buffer.length > 8 * MB) {
          errors.push({ rowNo: it.rowNo, msg: `图片过大（${Math.round(src.buffer.length / 1024 / 1024)}MB > 8MB），已跳过该图` });
          continue;
        }
        // 文件名沿用系统的 24 位随机命名（不可枚举）；展示名用 WPS 里填的描述
        const fn = `${genId()}${ext}`;
        try {
          await fs.promises.writeFile(path.join(UPLOAD_DIR, fn), src.buffer);
          const label = /^\d+$/.test(ph.name || "") ? "现场照片" : (ph.name || "现场照片");
          hazardPhotos.push({ u: `/uploads/${fn}`, n: `${label}${ext}` });
        } catch (e) {
          errors.push({ rowNo: it.rowNo, msg: `图片保存失败：${e.message}` });
        }
      }

      const newId = genId();
      await pool.query(
        `INSERT INTO hazard (id,hazard_code,inspect_date,inspector,location,description,category,level,
          rectify_measure,rectify_person,rectify_user_id,rectify_fund,plan_deadline,
          reviewer,reviewer_user_id,status,actual_complete_date,review_date,review_result,closed_at,created_at,
          hazard_photos)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [
          newId, hazardCode, it.inspectDate, it.inspector, it.location, it.description, it.category, it.level,
          it.rectifyMeasure || null, it.rectifyPerson || null, rp ? rp.id : null, String(it.rectifyFund || "0"),
          it.planDeadline,
          rvName || null, rv ? rv.id : null, status,
          closed ? (it.actualCompleteDate || today) : null,
          closed ? (it.reviewDate || it.actualCompleteDate || today) : null,
          closed ? it.reviewResult : null,
          closed ? new Date() : null,
          // 登记时间也按排查日期回填，避免"8 月发现的隐患显示成今天登记"
          new Date(it.inspectDate + "T09:00:00"),
          hazardPhotos.length ? JSON.stringify(hazardPhotos) : null,
        ]
      );
      dupKeys.add(`${it.location}|${it.description}`);
      created += 1;
      photosSaved += hazardPhotos.length;
    } catch (e) {
      errors.push({ rowNo: it.rowNo, msg: e.message });
    }
  }

  await logOp(user, "import_hazard", {
    targetType: "hazard", targetCode: parsed.sheetName,
    detail: `从「${String(body.fileName || "xlsx").slice(0, 60)}」导入 ${created} 条（含图片 ${photosSaved} 张）｜新建用户 ${createdUsers.length} 个｜跳过 ${dupCount} 条｜失败 ${errors.length} 条`,
  });
  console.log(`[IMPORT] ${user?.user_name || "-"} → 成功 ${created} 条（图片 ${photosSaved} 张），新建用户 ${createdUsers.length} 个，失败 ${errors.length} 条`);

  return sendJson(res, Object.assign({}, summary, {
    commit: true, created, usersCreated: createdUsers, skipped: dupCount, photosSaved, errors,
  }), 201);
}


module.exports = {
  handleImport,
};
