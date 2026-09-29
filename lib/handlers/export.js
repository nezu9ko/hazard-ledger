/**
 * 导出接口 /api/export（xlsx 四张表单 / csv 明细，与列表共用筛选口径）
 *
 * ⚠️ 本文件原在 `server.js` 里，2026-09-29 按功能拆分到 lib/ 下。
 *    顶部的 require 是"本文件实际用到什么就引什么"生成的；
 *    想知道本模块跟谁耦合，看顶部那几行就够了。
 */

"use strict";

const { localDateStr, sendJson } = require("../util.js");
const { buildHazardWhere, rowToHazard } = require("../models.js");
const { logOp } = require("../authz.js");
const { pool } = require("../db.js");
const { XS, buildXlsx } = require("../xlsx.js");
const { LEVEL_LABELS, CATEGORY_LABELS, STATUS_LABELS, cnDate, sheetNotice, sheetClosure, sheetLedger, sheetRaw, sheetAll } = require("../forms.js");
const path = require("node:path");
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


module.exports = {
  handleExport,
};
