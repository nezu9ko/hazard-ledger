/**
 * 台账导入：把 xlsx 解析成系统的隐患字段
 *
 * 设计原则（重要）
 *   1. **按表头文字认列，不按列号**。公司纸质表各版本列序不一样（我们手上的这份就有
 *      三张表描述同一批隐患、列数分别是 6/11/14），写死列号必错。
 *   2. **纯函数**：只做解析与映射，不碰数据库。这样能单独跑（`node tools/xlsx-import.js 文件`）
 *      先看解析结果对不对，再决定要不要入库。
 *   3. **能补则补**：主表若缺「部位」「资金」，而工作簿里另一张表有（且能按描述对上），
 *      就补齐 —— 并在 notes 里说明补了什么。
 *   4. **不猜得太狠**：拿不准的宁可不填，交给上层报「待补」，不要往库里塞脏数据。
 */

const { readXlsx } = require("./xlsx-read");

/* ---------------- 表头识别 ---------------- */

/** 字段 → 可能的表头写法（按优先级；先精确匹配，再包含匹配） */
const COL_HINTS = {
  // 「日期」放最后：它有被「检查日期」「整改完成时间」抢走的风险，只在不冲突时生效
  inspectDate: ["检查时间", "排查日期", "检查日期", "排查时间", "检查日"],
  inspector: ["检查人", "排查人员", "排查人"],
  location: ["具体地点", "检查部位", "所在部位", "部位", "地点", "位置"],
  description: ["存在隐患或问题", "存在的问题或隐患", "现场具体隐患", "具体隐患", "隐患描述", "问题或隐患", "隐患内容", "存在问题", "描述"],
  levelOrCategory: ["隐患类别", "隐患等级", "等级", "类别"],
  rectifyMeasure: ["整改措施", "整改要求", "措施"],
  rectifyPerson: ["整改责任人", "责任人"],
  rectifyFund: ["整改资金", "资金"],
  planDeadline: ["整改完成时间", "计划完成时限", "完成时间", "整改期限", "计划完成", "时限"],
  reviewer: ["复查人"],
  reviewDate: ["复查时间", "复查日期"],
  reviewResult: ["复查结果", "复查情况", "完成情况"],
  actualCompleteDate: ["实际完成日期", "实际完成时间", "完成日期"],
  hazardCode: ["隐患编号", "编号"],
};

/** 主键列：没有「描述」列的 sheet 不可能是台账数据表 */
const KEY_FIELD = "description";

const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, "").replace(/[（）()]/g, "");

/** 表头判定：必须有「描述」类列，且至少再命中一个别的可识别字段。
 *  ⚠️ 不能强求「检查时间/检查人」——公司的《整改通知单》表里就没有这两列，
 *     但它恰恰是唯一带「具体地点」和「整改资金」的表，放松条件才能把它当补齐表用上。 */
const HEADER_COMPANION = ["inspectDate", "inspector", "rectifyPerson", "planDeadline", "levelOrCategory", "rectifyMeasure"];
function findHeaderRow(rows) {
  for (let r = 0; r < Math.min(rows.length, 15); r += 1) {
    const cells = (rows[r] || []).map(norm);
    const has = (field) => COL_HINTS[field].some((h) => cells.some((c) => c.includes(norm(h))));
    if (has(KEY_FIELD) && HEADER_COMPANION.some(has)) return r;
  }
  return -1;
}

/** 表头行 → { 字段: 列号 }。两轮：先精确相等，再退到"包含"；一列只能被一个字段占用。
 *  精确优先是为了防止「复查时间」把「整改完成时间」这类更长的表头抢走。 */
function mapColumns(headerCells) {
  const cells = headerCells.map(norm);
  const cols = {};
  const used = new Set();
  const assign = (exact) => {
    Object.entries(COL_HINTS).forEach(([field, hints]) => {
      if (cols[field] !== undefined) return;
      const ordered = hints.map(norm);
      const idx = cells.findIndex((c, i) => c && !used.has(i) && (exact ? ordered.includes(c) : ordered.some((h) => c.includes(h))));
      if (idx >= 0) { cols[field] = idx; used.add(idx); }
    });
  };
  assign(true);
  assign(false);
  return cols;
}

/** 判断某一行是不是"数据行"：有描述、且不是签字/落款/表头重复行 */
function isDataRow(desc) {
  const d = String(desc || "").trim();
  if (d.length < 4) return false;
  if (/签字|负责人|盖章|签发|填表人|审核人/.test(d)) return false;
  if (COL_HINTS[KEY_FIELD].some((h) => norm(d).includes(norm(h)))) return false;   // 表头重复行
  if (/^[\s·—\-－_]+$/.test(d)) return false;
  return true;
}

/* ---------------- 取值映射 ---------------- */

const LEVEL_BY_TEXT = { 一般: "general", 一般隐患: "general", 重大: "major", 重大隐患: "major" };
const CATEGORY_BY_TEXT = {
  设备设施: "equipment", 作业行为: "operation", 违章行为: "operation",
  消防安全: "fire", 电气安全: "electrical", 环境安全: "environment",
  管理缺陷: "management", 安全管理: "management",
};
const DEFAULT_CATEGORY = "management";     // 表里没写内部类别、按描述也猜不出来时的兜底

/** 按隐患描述猜内部类别。
 *  ⚠️ 这是**启发式猜测**，不保证对。已经在导入预览里逐条列出来，用户可以看着改。
 *  规则按"越具体越靠前"排：同一句话里出现火灾和电气时，火灾优先。 */
const CATEGORY_RULES = [
  ["fire", /火灾|消防|灭火|可燃|易燃|杂草|动火|烟感|疏散|防火/],
  ["electrical", /电气|电源|接地|电线|线路|电缆|配电|用电|漏电|带电|短路|老化.*线/],
  ["operation", /违章|违规|未佩戴|未正确|未按规定|劳保|防护用品|擅自|无证|操作不当|违反|未采取隔离|未设置隔离|隔离措施|警戒带|围挡/],
  ["equipment", /设备|设施|机械|管道|阀门|钢丝绳|提升机|卷扬|皮带|警示牌|标识牌|护栏|围栏|支护|支架/],
  ["environment", /尾矿|坝体|边坡|塌陷|扬尘|废水|噪声|排水|环保|污染|采空区/],
];
function inferCategory(description) {
  const t = String(description || "");
  for (const [key, re] of CATEGORY_RULES) if (re.test(t)) return key;
  return DEFAULT_CATEGORY;
}

/** 把「一般/重大」当等级，「设备设施/违章行为…」当类别，两者都认 */
function splitLevelCategory(text) {
  const t = norm(text);
  if (!t) return { level: "", category: "" };
  if (LEVEL_BY_TEXT[t]) return { level: LEVEL_BY_TEXT[t], category: "" };
  if (CATEGORY_BY_TEXT[t]) return { level: "", category: CATEGORY_BY_TEXT[t] };
  for (const [k, v] of Object.entries(LEVEL_BY_TEXT)) if (t.includes(k)) return { level: v, category: "" };
  for (const [k, v] of Object.entries(CATEGORY_BY_TEXT)) if (t.includes(k)) return { level: "", category: v };
  return { level: "", category: "" };
}

/** 各种日期写法归一成 YYYY-MM-DD；认不出返回 "" */
function normDate(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return "";
}
const isDateStr = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s + "T00:00:00Z").getTime());
const addDays = (dateStr, n) => {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/* ---------------- 主解析 ---------------- */

/**
 * @param {Buffer} buf  xlsx 文件内容
 * @returns {Object} 解析结果（明细见文件末尾 README 注释）
 */
function parseHazardWorkbook(buf) {
  const book = readXlsx(buf);
  const notes = [];

  // ① 找出所有"像台账"的 sheet，并给每张表打分
  //    打分规则：核心字段（日期/排查人/描述/时限/责任人）权重 2，其它可识别字段权重 1。
  //    为什么要打分：这份文件里三张表各 11 行，只按"行数最多"选会挑到字段最少的《原始检查记录》，
  //    结果日期和责任人都缺。
  const CORE = ["inspectDate", "inspector", "description", "planDeadline", "rectifyPerson"];
  const USEFUL = ["inspectDate", "inspector", "location", "description", "levelOrCategory",
    "rectifyMeasure", "rectifyPerson", "rectifyFund", "planDeadline", "reviewer"];
  const candidates = book.sheets.map((sheet) => {
    const hr = findHeaderRow(sheet.rows);
    if (hr < 0) return null;
    const cols = mapColumns(sheet.rows[hr]);
    const dataRows = [];
    for (let r = hr + 1; r < sheet.rowCount; r += 1) {
      const row = sheet.rows[r] || [];
      const desc = cols[KEY_FIELD] === undefined ? "" : String(row[cols[KEY_FIELD]] || "");
      if (isDataRow(desc)) dataRows.push(r);
    }
    if (!dataRows.length) return null;
    const score = USEFUL.reduce((n, f) => (cols[f] === undefined ? n : n + (CORE.includes(f) ? 2 : 1)), 0);
    return { sheet, hr, cols, dataRows, score };
  }).filter(Boolean);

  const sheetInfo = book.sheets.map((s) => ({ name: s.name, rowCount: s.rowCount, colCount: s.colCount }));
  if (!candidates.length) {
    return {
      ok: false,
      error: "这份文件里没找到可导入的台账表格。需要有一张表：表头含「隐患描述／存在隐患或问题／现场具体隐患」这类列名，且下面一行一条数据。",
      sheets: sheetInfo, items: [], okItems: [], badItems: [], notes,
    };
  }
  candidates.sort((a, b) => (b.score - a.score) || (b.dataRows.length - a.dataRows.length));
  const primary = candidates[0];
  if (candidates.length > 1) {
    notes.push(`文件里有 ${candidates.length} 张像台账的表，按"字段最全"选中了「${primary.sheet.name}」（${primary.dataRows.length} 条，字段分 ${primary.score}）。`);
  }

  // ② 通用补齐：主表缺哪个字段，就从别的表按**隐患描述**逐条借
  //    （描述在两表里通常一字不差，比按行号对齐可靠）
  const missing = USEFUL.filter((f) => primary.cols[f] === undefined);
  const supp = {};
  if (missing.length) {
    const donors = [];
    candidates.filter((c) => c !== primary).forEach((donor) => {
      let n = 0;
      donor.dataRows.forEach((r) => {
        const row = donor.sheet.rows[r];
        const desc = String(row[donor.cols[KEY_FIELD]] || "").trim();
        if (!desc) return;
        const rec = supp[desc] = supp[desc] || {};
        missing.forEach((f) => {
          if (donor.cols[f] === undefined || rec[f]) return;
          const v = String(row[donor.cols[f]] == null ? "" : row[donor.cols[f]]).trim();
          if (v) { rec[f] = v; n += 1; }
        });
      });
      if (n) donors.push(`「${donor.sheet.name}」${n} 项`);
    });
    if (donors.length) {
      notes.push(`主表缺 ${missing.length} 个字段（${missing.join("、")}），已从 ${donors.join("、")} 按隐患描述逐条补齐。`);
    }
    const stillMissing = missing.filter((f) => !Object.values(supp).some((r) => r[f]));
    if (stillMissing.length) notes.push(`⚠️ 这些字段在所有表里都找不到，需要导入后手工补：${stillMissing.join("、")}`);
  }

  // ③ 逐行映射
  const items = [];
  primary.dataRows.forEach((r) => {
    const row = primary.sheet.rows[r] || [];
    const desc0 = String(row[primary.cols[KEY_FIELD]] || "").trim();
    /** 取值：主表有就用主表的，主表没有/为空就查补齐索引 */
    const raw = (f) => {
      if (primary.cols[f] !== undefined) {
        const v = String(row[primary.cols[f]] == null ? "" : row[primary.cols[f]]).trim();
        if (v) return v;
      }
      const rec = supp[desc0] || {};
      return rec[f] ? String(rec[f]).trim() : "";
    };
    const problems = [];

    const description = desc0;
    const location = raw("location");
    const inspectDate = normDate(raw("inspectDate"));

    // 等级 / 类别：同一列文字可能填等级（一般/重大）也可能填类别（设备设施/违章行为…）
    const lcText = raw("levelOrCategory");
    const lc = splitLevelCategory(lcText);
    const level = lc.level || "general";
    // 类别：表里明确写了就用表里的；没写就按描述猜（并标注"猜测"来源，方便用户复核）
    const guessed = !lc.category;
    const category = lc.category || inferCategory(description);
    if (lcText && !lc.level && !lc.category) problems.push(`「${lcText}」认不出是等级还是类别，已按 一般处理`);

    // 计划完成时限：优先日期；若那一列填的是"天数"，用 排查日期 + 天数 换算
    let planDeadline = normDate(raw("planDeadline"));
    let limitDaysNote = "";
    if (!planDeadline) {
      const days = Number(raw("planDeadline"));
      if (Number.isFinite(days) && days > 0 && isDateStr(inspectDate)) {
        planDeadline = addDays(inspectDate, days);
        limitDaysNote = `时限列是「${days}」（天数），按排查日期+${days}天换算为 ${planDeadline}`;
      }
    }
    // 最后兜底：有些表把计划日期写在「复查时间」列
    if (!planDeadline) planDeadline = normDate(raw("reviewDate"));

    if (!inspectDate) problems.push("没有可识别的排查日期");
    if (!location) problems.push("没有所在部位");
    if (!planDeadline) problems.push("没有可识别的计划完成时限");
    if (inspectDate && planDeadline && planDeadline < inspectDate) {
      problems.push(`计划完成时限 ${planDeadline} 早于排查日期 ${inspectDate}`);
    }

    items.push({
      rowNo: r + 1,
      sourceSheet: primary.sheet.name,
      hazardCode: raw("hazardCode"),
      inspectDate,
      inspector: raw("inspector") || "未填写",
      location,
      description,
      level,
      category,
      categoryGuessed: guessed,
      levelOrCategoryText: lcText,
      rectifyMeasure: raw("rectifyMeasure"),
      rectifyPerson: raw("rectifyPerson"),
      rectifyFund: raw("rectifyFund") || "0",
      planDeadline,
      reviewer: raw("reviewer"),
      reviewResult: raw("reviewResult"),
      actualCompleteDate: normDate(raw("actualCompleteDate")),
      note: limitDaysNote,
      _problems: problems,
    });
  });

  const okItems = items.filter((it) => !it._problems.length);
  const badItems = items.filter((it) => it._problems.length);
  return {
    ok: true,
    sheetName: primary.sheet.name,
    headerRow: primary.hr + 1,
    colMap: primary.cols,
    sheets: sheetInfo,
    hasImages: book.hasImages,
    imageCount: book.imageCount,
    items, okItems, badItems,
    skipped: [],
    notes,
    total: items.length,
  };
}

module.exports = { parseHazardWorkbook, normDate, splitLevelCategory, inferCategory, findHeaderRow, mapColumns };

/* 命令行直跑：先看解析结果，不碰数据库
 *   node tools/xlsx-import.js <xlsx> [--full]
 */
if (require.main === module) {
  const fs = require("node:fs");
  const file = process.argv[2];
  if (!file) { console.log("用法: node tools/xlsx-import.js <xlsx 文件> [--full]"); process.exit(1); }
  const r = parseHazardWorkbook(fs.readFileSync(file));
  if (!r.ok) { console.log("❌", r.error); console.log("文件里的 sheet:", JSON.stringify(r.sheets)); process.exit(1); }
  console.log(`✅ 数据表: 「${r.sheetName}」  表头第 ${r.headerRow} 行`);
  console.log(`   文件里共 ${r.sheets.length} 个 sheet；嵌入图片 ${r.imageCount} 张`);
  console.log(`   识别到的列映射: ${JSON.stringify(r.colMap)}`);
  r.notes.forEach((n) => console.log("   · " + n));
  console.log(`\n解析出 ${r.total} 条：可直接导入 ${r.okItems.length} 条，需留意 ${r.badItems.length} 条\n`);
  const show = process.argv[3] === "--full" ? r.items : r.items.slice(0, 6);
  show.forEach((it, i) => {
    console.log(`${String(i + 1).padStart(2)}. 行${String(it.rowNo).padStart(3)}  ${it.inspectDate}  ${it.level}/${it.category}`);
    console.log(`    部位: ${it.location || "（缺）"}`);
    console.log(`    描述: ${it.description}`);
    console.log(`    责任人: ${it.rectifyPerson || "（缺）"}   资金: ${it.rectifyFund}   时限: ${it.planDeadline || "（缺）"}`);
    if (it._problems.length) console.log(`    ⚠️ ${it._problems.join("；")}`);
  });
  if (show.length < r.items.length) console.log(`\n（只显示前 ${show.length} 条，加 --full 看全部）`);
}
