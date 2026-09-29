/**
 * 导出用的中文标签 + 四张纸质表单的版式构造（通知单/销号单/台账/原始记录）
 *
 * ⚠️ 本文件原在 `server.js` 里，2026-09-29 按功能拆分到 lib/ 下。
 *    顶部的 require 是"本文件实际用到什么就引什么"生成的；
 *    想知道本模块跟谁耦合，看顶部那几行就够了。
 */

"use strict";

const { UPLOAD_DIR, CFG } = require("./config.js");
const { colName, XS, imageSize, IMG_MIME } = require("./xlsx.js");
const fs = require("node:fs");
const path = require("node:path");
/* ---------------- 导出（xlsx / csv） ---------------- */
const LEVEL_LABELS = { major: "重大", general: "一般" };
const CATEGORY_LABELS = { equipment: "设备设施", operation: "违章行为", fire: "消防安全", electrical: "电气安全", environment: "环境安全", management: "管理缺陷" };
const STATUS_LABELS = { pending: "待整改", rectifying: "整改中", closed: "已闭环", overdue: "逾期" };

/* ---------------- 三套中式表单导出 ----------------
 * 格式严格对照公司现行纸质表单《安全检查隐患问题整改通知单、销号单、登记表》：
 *   ① notice  检查隐患问题整改通知单  （14 列，含标题、检查说明段与签发落款）
 *   ② closure 检查问题销号申请单      （13 列，含单位/日期行与负责人落款）
 *   ③ ledger  安全隐患整改治理台账    （11 列，含单位行）
 *
 * ⚠️ 口径说明：纸质表单中「**隐患类别**」列填的是「一般」这类**等级**值，
 *    因此这里填系统的 level（重大/一般）；系统内部的 category（设备设施/违章行为…）
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


module.exports = {
  LEVEL_LABELS,
  CATEGORY_LABELS,
  STATUS_LABELS,
  ORG_NAME,
  noticeDept,
  dayDiff,
  slashDate,
  cnDate,
  attText,
  imgAtts,
  embedImages,
  attCellText,
  pt2px,
  w2px,
  pxToW,
  textWidth,
  fitCols,
  headRowHeight,
  H_NOTICE,
  H_CLOSURE,
  H_LEDGER,
  H_RAW,
  thRow,
  formVals,
  sheetNotice,
  sheetClosure,
  sheetLedger,
  sheetRaw,
  sheetAll,
};
