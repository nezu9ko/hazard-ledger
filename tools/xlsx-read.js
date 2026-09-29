/**
 * 零依赖 xlsx 读取器
 *
 * 为什么自己写：本项目**不引入任何 npm 依赖**（内网离线部署，多一个包多一份风险）。
 * 导出侧的 xlsx 就是手写的，读取侧同样手写 —— 只实现「把单元格读成文本/日期」这一件事，
 * 不碰图表、公式引擎、样式渲染。
 *
 * 能力范围：
 *   - 读 .xlsx（ZIP + DEFLATE，用 Node 内置 zlib.inflateRawSync 解压）
 *   - 共享字符串表（sharedStrings.xml）与内联字符串（inlineStr）
 *   - 单元格按列引用（r="B7"）定位，空单元格不会错位
 *   - 日期识别：看 styles.xml 的 numFmtId / formatCode，把 Excel 序列号转成 YYYY-MM-DD
 *   - 列出每个 sheet 的名称、行列矩阵、以及是否含嵌入图片
 *
 * 不支持：.xls（老二进制格式）、.xlsm 的宏、加密工作簿。
 */

const zlib = require("node:zlib");

/* ---------------- ZIP 读取 ---------------- */

/**
 * 从 buffer 里解析出 ZIP 的所有条目。
 * 只走「中央目录」这一条正路（局部头里的长度字段在流式写入时可能是 0，不可靠）。
 */
function unzip(buf) {
  // 1) 从尾部找 EOCD 签名 0x06054b50（最多回退 64KB，兼容 zip 注释）
  let eocd = -1;
  const scanFrom = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= scanFrom; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 xlsx（找不到 ZIP 结尾记录）");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);          // 中央目录起始偏移

  const files = new Map();
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;   // 中央目录条目签名
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    // 2) 从局部头算出真实数据起点（局部头的 name/extra 长度可能与中央目录不同）
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    files.set(name, { method, raw });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** 取某个条目的文本内容（自动解压；method 0=存储 8=deflate） */
function readEntry(files, name) {
  const f = files.get(name);
  if (!f) return null;
  const data = f.method === 0 ? f.raw : zlib.inflateRawSync(f.raw);
  return data.toString("utf8");
}

/* ---------------- 轻量 XML 解析 ---------------- */
/* 只做「按标签名取值」这一件事，够读 xlsx 的几种固定结构。
 * 不用正则硬切整份 XML（大文件会爆栈/变慢），够用即可。 */

const XML_ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function unescapeXml(s) {
  if (!s || s.indexOf("&") < 0) return s || "";
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENT[e] !== undefined ? XML_ENT[e] : m;
  });
}

/** 取开始标签上的属性（只按 attr="value" 抓，xlsx 里足够） */
function attrs(tag) {
  const out = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(tag))) out[m[1]] = unescapeXml(m[2]);
  return out;
}

/** 把一段 XML 里所有 <tag ...>...</tag> 的「开始标签 + 内部文本」交给回调 */
function eachElement(xml, tag, cb) {
  const open = new RegExp(`<${tag}(\\s[^>]*?)?(/?)>`, "g");
  let m;
  while ((m = open.exec(xml))) {
    if (m[2] === "/") { cb(m[1] || "", "", m.index); continue; }   // 自闭合
    const end = xml.indexOf(`</${tag}>`, open.lastIndex);
    if (end < 0) break;
    cb(m[1] || "", xml.slice(open.lastIndex, end), m.index);
    open.lastIndex = end + tag.length + 3;
  }
}

/* ---------------- 列号 ↔ 列名 ---------------- */

/** "B7" → { col: 1, row: 6 }（0 基） */
function refToCell(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref || "");
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) - 1 };
}

/* ---------------- 日期识别 ---------------- */

/** 内置日期/时间格式的 numFmtId（Excel 规范里的固定值） */
const BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function looksLikeDateFormat(code) {
  if (!code) return false;
  // 去掉颜色/条件段与引号里的字面量，再找 y/m/d/h/s 占位符
  const cleaned = code.replace(/\[[^\]]*\]/g, "").replace(/"[^"]*"/g, "").replace(/\\./g, "");
  return /[ymdhs]/i.test(cleaned);
}

/** Excel 1900 日期系统序列号 → Date（含著名的 1900-02-29 幽灵日的补偿） */
function serialToDate(n) {
  const days = Math.floor(n);
  const frac = n - days;
  // Excel 把 1900 当闰年，序列号 60 = 不存在的 1900-02-29；>=61 的要减 1
  const epoch = Date.UTC(1899, 11, 30);
  const ms = epoch + (days - (days >= 61 ? 1 : 0)) * 86400000 + Math.round(frac * 86400000);
  return new Date(ms);
}
const pad2 = (n) => String(n).padStart(2, "0");
function fmtDate(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
function fmtDateTime(d) {
  return `${fmtDate(d)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/* ---------------- 单元格图片（WPS 的 =DISPIMG 嵌入图） ----------------
 * WPS 把「嵌入单元格的图片」放在两个地方：
 *   xl/cellimages.xml          每个 <xdr:pic> 里 cNvPr@name = 图片 ID（就是 DISPIMG 里那个）、
 *                              cNvPr@descr = 用户填的描述（如"坝体"），a:blip@r:embed = 关系号
 *   xl/_rels/cellimages.xml.rels   rId → media/imageN.jpeg
 * 单元格里存的是公式 `=DISPIMG("ID_XXXX",1)`，所以要把这两头对上才拿得到图。
 *
 * 注意：这是 WPS 的私有格式。Excel 365 的「置于单元格中的图片」用的是另一套
 * （richValue + xl/media），本函数不处理。
 */
function readCellImages(files) {
  const xml = readEntry(files, "xl/cellimages.xml");
  if (!xml) return {};
  const rels = {};
  const relXml = readEntry(files, "xl/_rels/cellimages.xml.rels");
  if (relXml) {
    eachElement(relXml, "Relationship", (a) => {
      const at = attrs(`<x ${a}>`);
      if (at.Id && at.Target) rels[at.Id] = at.Target.replace(/^\/?xl\//, "").replace(/^\//, "");
    });
  }
  const out = {};
  // 按 <xdr:pic> 切块，比按带前缀的标签名匹配更不容易踩命名空间的坑
  const blocks = xml.match(/<xdr:pic\b[\s\S]*?<\/xdr:pic>/g) || [];
  blocks.forEach((block) => {
    const nameM = /<xdr:cNvPr\b[^>]*\bname="([^"]+)"/.exec(block);
    const embedM = /<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(block);
    if (!nameM || !embedM) return;
    const id = unescapeXml(nameM[1]);
    const descrM = /<xdr:cNvPr\b[^>]*\bdescr="([^"]*)"/.exec(block);
    const target = rels[embedM[1]];
    if (!target) return;
    const p = "xl/" + target;
    const f = files.get(p);
    if (!f) return;
    let buffer;
    try { buffer = f.method === 0 ? f.raw : zlib.inflateRawSync(f.raw); } catch { return; }
    const m = /\.([A-Za-z0-9]+)$/.exec(p);
    let ext = m ? m[1].toLowerCase() : "jpg";
    if (ext === "jpeg") ext = "jpg";
    out[id] = { id, name: descrM ? unescapeXml(descrM[1]) : "", path: p, ext, size: buffer.length, buffer };
  });
  return out;
}

/* ---------------- 主入口 ---------------- */

/**
 * 读取 xlsx。
 * @returns {{ sheets: Array<{name, rows: string[][], rowCount, colCount}>, hasImages, imageCount }}
 *          rows 是二维字符串数组（第 0 行通常是表头）；日期已格式化成 YYYY-MM-DD。
 */
function readXlsx(buf, opt = {}) {
  const files = unzip(buf);

  // ① 共享字符串表
  const shared = [];
  const ssXml = readEntry(files, "xl/sharedStrings.xml");
  if (ssXml) {
    eachElement(ssXml, "si", (_a, inner) => {
      // 一个 si 可能由多个 <r><t> 片段拼成
      let text = "";
      eachElement(inner, "t", (_ta, t) => { text += unescapeXml(t); });
      shared.push(text);
    });
  }

  // ② 样式：numFmtId → 是否日期
  const styleIsDate = [];
  const stylesXml = readEntry(files, "xl/styles.xml");
  if (stylesXml) {
    const customDateFmt = new Set();
    eachElement(stylesXml, "numFmt", (a) => {
      const id = Number(a.match(/numFmtId="(\d+)"/) ? a.match(/numFmtId="(\d+)"/)[1] : NaN);
      const code = a.match(/formatCode="([^"]*)"/) ? unescapeXml(a.match(/formatCode="([^"]*)"/)[1]) : "";
      if (Number.isFinite(id) && looksLikeDateFormat(code)) customDateFmt.add(id);
    });
    // cellXfs 里的第 n 个 xf，对应单元格 s="n"
    const cellXfs = stylesXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
    if (cellXfs) {
      let idx = 0;
      eachElement(cellXfs[1], "xf", (a) => {
        const m = /numFmtId="(\d+)"/.exec(a);
        const id = m ? Number(m[1]) : 0;
        styleIsDate[idx] = BUILTIN_DATE_FMT.has(id) || customDateFmt.has(id);
        idx += 1;
      });
    }
  }

  // ③ 工作簿：sheet 名 + r:id 的顺序
  const wbXml = readEntry(files, "xl/workbook.xml");
  if (!wbXml) throw new Error("不是有效的 xlsx（缺 xl/workbook.xml）");
  const sheetDefs = [];
  eachElement(wbXml, "sheet", (a) => {
    const at = attrs(`<x ${a}>`);
    if (at.name) sheetDefs.push({ name: at.name, rid: at["r:id"] || at.id || "" });
  });

  // ④ r:id → 实际文件路径
  const ridTarget = {};
  const relXml = readEntry(files, "xl/_rels/workbook.xml.rels");
  if (relXml) {
    eachElement(relXml, "Relationship", (a) => {
      const at = attrs(`<x ${a}>`);
      if (at.Id && at.Target) ridTarget[at.Id] = at.Target.replace(/^\/?xl\//, "").replace(/^\//, "");
    });
  }

  // ⑤ 逐 sheet 读单元格
  const sheets = [];
  sheetDefs.forEach((sd, i) => {
    // 优先按关系找，找不到就按 sheetN.xml 顺序兜底
    let path = ridTarget[sd.rid] ? "xl/" + ridTarget[sd.rid] : "";
    if (!path || !files.has(path)) path = `xl/worksheets/sheet${i + 1}.xml`;
    const xml = readEntry(files, path);
    if (!xml) { sheets.push({ name: sd.name, rows: [], rowCount: 0, colCount: 0 }); return; }

    const grid = [];
    let maxCol = 0;
    eachElement(xml, "row", (rowAttrs, rowInner) => {
      const rAt = attrs(`<x ${rowAttrs}>`);
      const rowIdx = rAt.r ? Number(rAt.r) - 1 : grid.length;
      const cells = [];
      eachElement(rowInner, "c", (cAttrs, cInner) => {
        const cAt = attrs(`<x ${cAttrs}>`);
        const pos = refToCell(cAt.r);
        const col = pos ? pos.col : cells.length;
        const t = cAt.t || "";
        let val = "";

        if (t === "s") {                                   // 共享字符串
          const m = /<v>([\s\S]*?)<\/v>/.exec(cInner);
          val = m ? (shared[Number(unescapeXml(m[1]))] ?? "") : "";
        } else if (t === "inlineStr") {                    // 内联字符串
          eachElement(cInner, "t", (_ta, tt) => { val += unescapeXml(tt); });
        } else if (t === "str") {                          // 公式结果（字符串）
          const m = /<v>([\s\S]*?)<\/v>/.exec(cInner);
          val = m ? unescapeXml(m[1]) : "";
        } else if (t === "b") {
          const m = /<v>([\s\S]*?)<\/v>/.exec(cInner);
          val = m && m[1].trim() === "1" ? "TRUE" : "FALSE";
        } else {                                            // 数字 / 日期 / 空
          const m = /<v>([\s\S]*?)<\/v>/.exec(cInner);
          if (m) {
            const num = Number(unescapeXml(m[1]));
            const isDate = styleIsDate[Number(cAt.s || 0)] === true;
            if (isDate && Number.isFinite(num) && num > 0) {
              const d = serialToDate(num);
              val = num % 1 === 0 ? fmtDate(d) : fmtDateTime(d);
            } else {
              val = unescapeXml(m[1]).trim();
            }
          }
        }
        cells[col] = val;
        if (col + 1 > maxCol) maxCol = col + 1;
      });
      for (let k = 0; k < cells.length; k += 1) if (cells[k] === undefined) cells[k] = "";
      grid[rowIdx] = cells;
    });

    for (let k = 0; k < grid.length; k += 1) if (!grid[k]) grid[k] = [];
    // 统一补齐到最大列数
    grid.forEach((r) => { for (let k = r.length; k < maxCol; k += 1) r[k] = ""; });

    sheets.push({ name: sd.name, rows: grid, rowCount: grid.length, colCount: maxCol });
  });

  const mediaFiles = [...files.keys()].filter((n) => n.startsWith("xl/media/") && !n.endsWith("/"));
  // 只要「单元格图片」的 ID→文件 映射（导入要按 DISPIMG 的 ID 取图）；
  // 显式传 { images: true } 才把图片字节读进来，免得只想知道结构时白白加载十几 MB
  const images = opt.images ? readCellImages(files) : {};
  return {
    sheets,
    hasImages: mediaFiles.length > 0,
    imageCount: mediaFiles.length,
    cellImageCount: Object.keys(images).length,
    images,
    fileNames: [...files.keys()],
  };
}

module.exports = { readXlsx, unzip, readEntry, readCellImages, refToCell, serialToDate, fmtDate };

/* 允许直接命令行调用：node tools/xlsx-read.js <文件> [sheet序号] */
if (require.main === module) {
  const fs = require("node:fs");
  const file = process.argv[2];
  if (!file) { console.log("用法: node tools/xlsx-read.js <xlsx 文件> [sheet序号(1起)] [最多显示行数]"); process.exit(1); }
  const out = readXlsx(fs.readFileSync(file));
  console.log(`文件: ${file}`);
  console.log(`sheet 数: ${out.sheets.length}   嵌入图片: ${out.imageCount} 张`);
  console.log("");
  out.sheets.forEach((s, i) => {
    console.log(`【${i + 1}】${s.name}  —— ${s.rowCount} 行 × ${s.colCount} 列`);
  });
  const pick = process.argv[3] ? Number(process.argv[3]) - 1 : -1;
  if (pick >= 0 && out.sheets[pick]) {
    const s = out.sheets[pick];
    const limit = process.argv[4] ? Number(process.argv[4]) : 25;
    console.log(`\n===== ${s.name} 前 ${limit} 行 =====`);
    s.rows.slice(0, limit).forEach((r, ri) => {
      console.log(`${String(ri + 1).padStart(3)} | ${r.map((c) => (c === "" ? "·" : c)).join(" | ")}`);
    });
  }
}
