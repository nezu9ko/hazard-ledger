/**
 * 零依赖 xlsx 写出：CRC32 校验、ZIP(stored) 打包、worksheet/workbook 组装、图片嵌入
 *
 * ⚠️ 本文件原在 `server.js` 里，2026-09-29 按功能拆分到 lib/ 下。
 *    顶部的 require 是"本文件实际用到什么就引什么"生成的；
 *    想知道本模块跟谁耦合，看顶部那几行就够了。
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
/* ---------------- 极简 XLSX 生成（零依赖，ZIP stored） ----------------
 * 为什么自己写而不用第三方库？
 *   本系统部署在**内网**，希望保持"仅一个 npm 依赖（pg）"，避免额外依赖与体积。
 * 实现要点：
 *   - XLSX 本质是一个 ZIP，内部包含若干固定 XML 部件；
 *   - 这里只用 `stored`（不压缩）方式打包，因此无需 zlib，只需 CRC32 校验；
 *   - 单元格文本用 `inlineStr` 内联字符串，避免维护共享字符串表。
 * 结构：CRC_TABLE/crc32 → zipStore() → buildXlsx()
 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}
function zipStore(files) {
  const chunks = []; const central = []; let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data); const size = f.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, f.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + size;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}
const xmlEsc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
function colName(n) { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

/**
 * 单元格样式索引 —— 与 styles.xml 中 cellXfs 的顺序**必须一一对应**。
 * 0 默认 / 1 大标题 / 2 表头 / 3 正文居中 / 4 正文左对齐 / 5 说明段落（左上）
 * 6 粗体 / 7 右对齐（垂直居中）/ 8 右对齐+底端对齐（落款右下角）
 * 9 左对齐+顶端 / 10 右对齐+右缩进 5 字（签字处留白）
 */
const XS = {
  DEFAULT: 0, TITLE: 1, TH: 2, CENTER: 3, LEFT: 4, NOTE: 5,
  BOLD: 6, RIGHT: 7, RIGHT_BOTTOM: 8, LEFT_TOP: 9, RIGHT_SIGN: 10,
};

/** styles.xml：字体/填充/边框/单元格格式四张表，供上面 XS 索引导用 */
const XLSX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
  + `<fonts count="5">`
  + `<font><sz val="11"/><name val="&#23435;&#20307;"/><charset val="134"/></font>`
  + `<font><b/><sz val="11"/><name val="&#23435;&#20307;"/><charset val="134"/></font>`
  + `<font><b/><sz val="16"/><name val="&#23435;&#20307;"/><charset val="134"/></font>`
  + `<font><b/><sz val="11"/><color rgb="FFC00000"/><name val="&#23435;&#20307;"/><charset val="134"/></font>`
  + `<font><sz val="9"/><name val="&#23435;&#20307;"/><charset val="134"/></font>`
  + `</fonts>`
  + `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>`
  + `<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill></fills>`
  + `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>`
  + `<border><left style="thin"><color indexed="64"/></left><right style="thin"><color indexed="64"/></right>`
  + `<top style="thin"><color indexed="64"/></top><bottom style="thin"><color indexed="64"/></bottom><diagonal/></border></borders>`
  + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
  + `<cellXfs count="11">`
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`                                                                                            // 0 默认
  + `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>`   // 1 标题
  + `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>`  // 2 表头
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>`  // 3 居中
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>`    // 4 左对齐
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>`                       // 5 说明段（左上）
  + `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>`       // 6 粗体
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>`                                // 7 右对齐
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="bottom" wrapText="1"/></xf>`                   // 8 右对齐+底端（落款右下角）
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>`                       // 9 左对齐+顶端
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="center" indent="5" wrapText="1"/></xf>`        // 10 右对齐+右缩进5字（签字留白）
  + `</cellXfs>`
  // cellStyles 必须显式声明「常规」样式，否则 Excel/openpyxl 会报 "no default style"
  // （dxfs 也一并声明，部分阅读器要求其存在）
  + `<cellStyles count="1"><cellStyle name="&#24120;&#35268;" xfId="0" builtinId="0"/></cellStyles>`
  + `<dxfs count="0"/>`
  + `</styleSheet>`;

/**
 * 生成 XLSX（零依赖，ZIP stored）。**支持多工作表**。
 * 相比最初的单表头版本，这里补齐了中式表格真正需要的东西：
 *   ① 样式（标题/表头/正文/说明段/落款/缩进）  ② 合并单元格
 *   ③ 列宽（按印版像素折算）  ④ 自动换行  ⑤ 行高  ⑥ **多 sheet**
 * @param {object|object[]} sheets 单个 sheet 定义，或 sheet 数组
 *   sheet.sheetName {string}  工作表名（Excel 限制 ≤31 字符、不含 : \ / ? * [ ]）
 *   sheet.cols      {number[]} 列宽（字符数）
 *   sheet.rows      {Array<{h?:number, cells: Array<null|string|number|{v:any,s?:number}>}>}
 *   sheet.merges    {string[]} 合并区域（A1 记法）
 *   sheet.freeze    {string}   冻结窗格起点（如 "A4"）
 */
function buildXlsx(sheets) {
  const list = (Array.isArray(sheets) ? sheets : [sheets]).filter(Boolean);
  const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

  // —— 图片：跨表统一编号（media 文件同处一个目录）——
  let mediaSeq = 0;
  const mediaParts = [];      // {name, data}
  const sheetImgs = list.map((o) => (o.images || []).map((im) => {
    let bytes = null;
    try { bytes = fs.readFileSync(im.file); } catch { return null; }
    const ext = path.extname(im.file).toLowerCase();
    if (!IMG_MIME[ext]) return null;              // pdf/word 等不能嵌入，交给文字兜底
    const nat = imageSize(bytes) || { w: 200, h: 150 };
    mediaSeq += 1;
    mediaParts.push({ name: `xl/media/image${mediaSeq}${ext}`, data: bytes });
    return { ...im, seq: mediaSeq, ext, nat };
  }).filter(Boolean));

  // —— 每个 sheet 生成一份 worksheet XML ——
  const sheetXmls = list.map((o, si) => {
    const rows = o.rows || [];
    const colsXml = (o.cols && o.cols.length)
      ? `<cols>${o.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w > 0 ? w : 8.43}" customWidth="1"/>`).join("")}</cols>`
      : "";
    const rowXml = rows.map((row, ri) => {
      const r = ri + 1;
      const cells = (row.cells || []).map((c, ci) => {
        if (c === null || c === undefined || c === "") return "";
        const v = (typeof c === "object") ? c.v : c;
        const s = (typeof c === "object" && c.s !== undefined) ? c.s : XS.DEFAULT;
        if (v === null || v === undefined || v === "") return s ? `<c r="${colName(ci + 1)}${r}" s="${s}"/>` : "";
        const ref = `${colName(ci + 1)}${r}`;
        const sAttr = s ? ` s="${s}"` : "";
        if (typeof v === "number" && isFinite(v)) return `<c r="${ref}"${sAttr}><v>${v}</v></c>`;
        return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
      }).join("");
      const hAttr = row.h ? ` ht="${row.h}" customHeight="1"` : "";
      return `<row r="${r}"${hAttr}>${cells}</row>`;
    }).join("");
    const mergesXml = (o.merges && o.merges.length)
      ? `<mergeCells count="${o.merges.length}">${o.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>`
      : "";
    const freezeXml = o.freeze
      ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${Number(o.freeze.replace(/\D/g, "")) - 1}" topLeftCell="${o.freeze}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
      : "";
    // 有图片就必须在表末尾引用绘图；<drawing> 必须排在 mergeCells 之后
    const drawingXml = (sheetImgs[si] || []).length ? `<drawing r:id="rId1"/>` : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
      + freezeXml + colsXml + `<sheetData>${rowXml}</sheetData>` + mergesXml + drawingXml + `</worksheet>`;
  });

  // —— 绘图 XML：把图片锚在指定单元格左上角，按设计尺寸摆放 ——
  const drawXmls = sheetImgs.map((imgs, si) => {
    if (!imgs.length) return null;
    const anchors = imgs.map((im, i) => {
      // 设计尺寸：按行高与列宽留出的空间做等比缩放（每张图片单独算）
      const w = im.w || 120; const h = im.h || 80;
      return `<xdr:oneCellAnchor><xdr:from><xdr:col>${im.col}</xdr:col><xdr:colOff>${px2emu(im.offX || 0)}</xdr:colOff>`
        + `<xdr:row>${im.row}</xdr:row><xdr:rowOff>${px2emu(im.offY || 0)}</xdr:rowOff></xdr:from>`
        + `<xdr:ext cx="${px2emu(w)}" cy="${px2emu(h)}"/>`
        + `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 1}" name="图片${i + 1}"/>`
        + `<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>`
        + `<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId${i + 1}"/>`
        + `<a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`
        + `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${px2emu(w)}" cy="${px2emu(h)}"/></a:xfrm>`
        + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`;
    }).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${anchors}</xdr:wsDr>`;
  });
  const drawRels = sheetImgs.map((imgs, si) => {
    if (!imgs.length) return null;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + imgs.map((im, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${im.seq}${im.ext}"/>`).join("")
      + `</Relationships>`;
  });
  const sheetRels = sheetImgs.map((imgs, si) => imgs.length
    ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${si + 1}.xml"/></Relationships>`
    : null);

  // —— workbook / rels / content-types 按 sheet 数量动态拼 ——
  const sheetTags = list.map((o, i) => {
    // 工作表名做一次清洗：Excel 不允许 : \ / ? * [ ]，且长度 ≤31
    const nm = String(o.sheetName || `Sheet${i + 1}`).replace(/[:\\/?*[\]]/g, "_").slice(0, 31);
    return `<sheet name="${xmlEsc(nm)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`;
  }).join("");
  const styleRid = `rId${list.length + 1}`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags}</sheets></workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")
    + `<Relationship Id="${styleRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const imgExts = [...new Set(mediaParts.map((m) => path.extname(m.name).slice(1).toLowerCase()))];
  // 只对实际用到的图片扩展名声明 Default（PNG 无扩展名分支 → 用 png 占位不影响读取）
  const imgTypes = (imgExts.length ? imgExts : ["png"])
    .map((e) => `<Default Extension="${e}" ContentType="${IMG_MIME["." + e] || "image/png"}"/>`).join("");
  const drawingTypes = drawXmls.some(Boolean)
    ? `<Default Extension="drawing" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>` : "";
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
    + imgTypes + drawingTypes
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
    + list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")
    + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

  const parts = [
    { name: "[Content_Types].xml", data: Buffer.from(ct, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rels, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbook, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(wbRels, "utf8") },
    { name: "xl/styles.xml", data: Buffer.from(XLSX_STYLES, "utf8") },
    ...sheetXmls.map((xml, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(xml, "utf8") })),
    ...mediaParts,                                                   // 图片本体
  ];
  // 绘图与关系：仅对"有图片"的表输出
  drawXmls.forEach((xml, i) => { if (xml) parts.push({ name: `xl/drawings/drawing${i + 1}.xml`, data: Buffer.from(xml, "utf8") }); });
  drawRels.forEach((xml, i) => { if (xml) parts.push({ name: `xl/drawings/_rels/drawing${i + 1}.xml.rels`, data: Buffer.from(xml, "utf8") }); });
  sheetRels.forEach((xml, i) => { if (xml) parts.push({ name: `xl/worksheets/_rels/sheet${i + 1}.xml.rels`, data: Buffer.from(xml, "utf8") }); });
  return zipStore(parts);
}

/* ---------------- 图片嵌入支持 ----------------
 * 纸质销号单/通知单里的「图片」列是真照片，所以导出件也要把照片**嵌进单元格**，
 * 而不是只写个文件名。这里实现最小可用的 XLSX 图片嵌入（零依赖）：
 *   · xl/media/imageN.<ext>                       图片本体
 *   · xl/drawings/drawingN.xml                    每表一份，用 oneCellAnchor 锚到单元格
 *   · xl/drawings/_rels/drawingN.xml.rels         图片关系
 *   · xl/worksheets/_rels/sheetN.xml.rels         表 → 绘图 关系
 *   · 工作表 XML 末尾加 <drawing r:id="..."/>
 *   · [Content_Types].xml 加 png/jpeg 的 Default
 */

/** 从文件头读出图片像素尺寸（PNG / JPEG / GIF）；读不出返回 null */
function imageSize(buf) {
  try {
    // PNG：IHDR 紧跟在 8 字节签名 + 4 字节长度 + 4 字节类型之后
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    // GIF：宽高为小端 16 位
    if (buf.length > 10 && buf.slice(0, 3).toString("latin1") === "GIF") {
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }
    // JPEG：扫描 SOFn 段
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        }
        i += 2 + len;
      }
    }
  } catch { /* 解析失败按未知处理 */ }
  return null;
}

/** 扩展名 → MIME（只支持可嵌入的图片类型） */
const IMG_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif" };

/** 把 px 换算成 EMU（1 px = 9525 EMU，Excel 的英制单位） */
const px2emu = (px) => Math.round(px * 9525);

module.exports = {
  CRC_TABLE,
  crc32,
  zipStore,
  xmlEsc,
  colName,
  XS,
  XLSX_STYLES,
  buildXlsx,
  imageSize,
  IMG_MIME,
  px2emu,
};
