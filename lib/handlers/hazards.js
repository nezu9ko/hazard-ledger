/**
 * 隐患台账（列表/详情/登记/整改/复查/删除）+ 看板统计 + 操作日志 + 待办提醒 + 示例数据
 *
 * ⚠️ 本文件原在 `server.js` 里，2026-09-29 按功能拆分到 lib/ 下。
 *    顶部的 require 是"本文件实际用到什么就引什么"生成的；
 *    想知道本模块跟谁耦合，看顶部那几行就够了。
 */

"use strict";

const { LEVELS, CATEGORIES, STATUSES } = require("../config.js");
const { genId, localDateStr, isRealDate, shiftDate, sendJson, badRequest, notFound, readBody } = require("../util.js");
const { parsePhotos, MAX_PHOTOS, normalizePhotos, buildHazardWhere, rowToHazard } = require("../models.js");
const { ACTION_LABELS, logOp } = require("../authz.js");
const { pool } = require("../db.js");

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
    // 后期补附件：隐患照片 / 整改照片都可以登记之后再补
    // （现实里照片常常是事后才拿到；登记时强制传反而是形式主义）
    if (body.action === "add-photos") {
      const field = body.field === "rectifyPhotos" ? "rectifyPhotos" : "hazardPhotos";
      const col = field === "rectifyPhotos" ? "rectify_photos" : "hazard_photos";
      const incoming = normalizePhotos(body.photos);
      if (!incoming.length) return badRequest(res, "没有可添加的附件（只接受本站 /uploads/ 下的文件）");

      const cur = parsePhotos(row[col]);
      // 去重 + 卡上限，避免重复点按钮灌进来一堆同样的图
      const seen = new Set(cur.map((x) => x.u));
      const merged = cur.concat(incoming.filter((x) => !seen.has(x.u)));
      if (merged.length > MAX_PHOTOS) {
        return badRequest(res, `最多 ${MAX_PHOTOS} 个附件（当前已有 ${cur.length} 个，本次想加 ${incoming.length} 个）`);
      }
      const r = await pool.query(
        `UPDATE hazard SET ${col} = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [merged.length ? JSON.stringify(merged) : null, id]
      );
      await logOp(user, "update_hazard", {
        targetType: "hazard", targetId: id, targetCode: row.hazard_code,
        detail: `补充${field === "rectifyPhotos" ? "整改照片" : "隐患照片"} ${incoming.length} 个（共 ${merged.length} 个）`,
      });
      return sendJson(res, rowToHazard(r.rows[0], today));
    }

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


module.exports = {
  handleStats,
  handleHazards,
  handleSeed,
  handleLogs,
  handleReminders,
};
