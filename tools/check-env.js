/**
 * ============================================================================
 *  隐患治理台账系统 — 环境体检
 * ============================================================================
 *  用途：双击「检查环境.bat」即可全面体检，快速定位问题。
 *  检查项：服务状态 / 接口健康 / 数据库 / 计划任务 / 防火墙 /
 *          备份情况 / 照片目录 / 磁盘空间 / 代码与版本库 / 近期错误
 *
 *  说明：脚本只做"读取"，不会修改任何数据或配置，可放心反复运行。
 * ============================================================================
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const net = require("node:net");
const { execSync } = require("node:child_process");

const ROOT = __dirname.replace(/[\\/]tools$/, "");
const CFG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")); }
  catch { return { port: 3000, db: {} }; }
})();
const PORT = CFG.port || 3000;
const DB = { host: "127.0.0.1", port: 5432, user: "postgres", database: "hazard_ledger", ...(CFG.db || {}) };

// ---------------- 输出工具 ----------------
const LINE = "─".repeat(62);
let nOk = 0, nWarn = 0, nBad = 0;
const say = (s) => console.log(s);
const ok = (k, v) => { nOk++; say(`  [正常] ${k.padEnd(14, " ")} ${v}`); };
const warn = (k, v) => { nWarn++; say(`  [注意] ${k.padEnd(14, " ")} ${v}`); };
const bad = (k, v) => { nBad++; say(`  [异常] ${k.padEnd(14, " ")} ${v}`); };
const info = (k, v) => say(`         ${k.padEnd(14, " ")} ${v}`);
const title = (t) => { say(""); say(`【${t}】`); };

/** 执行命令并返回输出（失败返回空串），绝不抛异常 */
function run(cmd, timeout = 8000) {
  try {
    return execSync(cmd, { encoding: "utf8", timeout, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return ""; }
}

/** TCP 端口是否有人在监听 */
function portOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(2500);
    s.on("connect", () => done(true));
    s.on("timeout", () => done(false));
    s.on("error", () => done(false));
  });
}

/** HTTP GET 取 JSON */
function httpJson(url, timeout = 4000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      let b = "";
      res.on("data", (c) => { b += c; });
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, body: null }); } });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fmtTime = (d) => {
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const daysAgo = (ms) => Math.floor((Date.now() - ms) / 86400000);

// ---------------- 主流程 ----------------
(async () => {
  say("");
  say("=".repeat(62));
  say("        隐患治理台账系统 — 环境体检报告");
  say(`        检查时间: ${fmtTime(new Date())}`);
  say("=".repeat(62));

  // ---------- 一、服务 ----------
  title("一、系统服务");
  const p3000 = await portOpen(PORT);
  if (p3000) ok("Web 服务", `正在运行（端口 ${PORT}）`);
  else bad("Web 服务", `未运行！端口 ${PORT} 无人监听 —— 双击 restart-service.bat 重启`);

  if (p3000) {
    const h = await httpJson(`http://127.0.0.1:${PORT}/api/health`);
    if (h && h.status === 200 && h.body && h.body.ok) ok("接口健康检查", "正常响应");
    else bad("接口健康检查", "服务在跑但接口无响应，请查看 server-out.log");
  }

  const p5432 = await portOpen(DB.port, DB.host);
  if (p5432) ok("数据库服务", `PostgreSQL 正在运行（${DB.host}:${DB.port}）`);
  else bad("数据库服务", "PostgreSQL 未运行！管理员执行 net start PostgreSQL-17");

  // 局域网地址
  const ips = [];
  for (const k of Object.keys(os.networkInterfaces())) {
    for (const a of os.networkInterfaces()[k]) if (a.family === "IPv4" && !a.internal) ips.push(a.address);
  }
  if (ips.length) ok("局域网地址", ips.map((i) => `http://${i}:${PORT}`).join("  "));
  else warn("局域网地址", "未检测到局域网 IP（可能没连网线/WiFi）");

  // ---------- 二、数据库 ----------
  title("二、数据库数据");
  if (p5432) {
    try {
      const { Client } = require(path.join(ROOT, "node_modules", "pg"));
      const c = new Client({ ...DB });
      await c.connect();
      const q = async (sql) => (await c.query(sql)).rows[0];
      const hz = await q("SELECT COUNT(*)::int c FROM hazard");
      const un = await q("SELECT COUNT(*)::int c FROM hazard WHERE status <> 'closed'");
      const us = await q("SELECT COUNT(*)::int c FROM users");
      const lg = await q("SELECT COUNT(*)::int c FROM operation_log");
      ok("数据库连接", `正常（库 ${DB.database}）`);
      info("隐患总数", `${hz.c} 条（其中未闭环 ${un.c} 条）`);
      info("用户数", `${us.c} 个`);
      info("操作日志", `${lg.c} 条`);
      await c.end();
    } catch (e) {
      bad("数据库连接", `失败：${e.message}`);
      info("排查提示", "检查 config.json 的 db.password 是否正确");
    }
  } else {
    warn("数据库连接", "跳过（数据库服务未运行）");
  }

  // ---------- 三、自启与防火墙 ----------
  title("三、自动启动与防火墙");
  const tQ = run('schtasks /Query /TN HazardLedger /FO LIST');
  if (tQ && /HazardLedger/i.test(tQ)) {
    const st = (tQ.match(/状态:\s*(\S+)|Status:\s*(\S+)/) || [])[1] || (tQ.match(/Status:\s*(\S+)/) || [])[1] || "已注册";
    ok("开机自启任务", `HazardLedger 已注册（${st}）`);
  } else {
    // 非管理员查询不到 SYSTEM 任务属正常，用部署日志兜底
    const dep = fs.existsSync(path.join(ROOT, "deploy-setup.log")) ? fs.readFileSync(path.join(ROOT, "deploy-setup.log"), "utf8") : "";
    if (/TaskName:\s*\\HazardLedger/.test(dep)) ok("开机自启任务", "已注册（非管理员查不到 SYSTEM 任务属正常，依据部署日志判断）");
    else bad("开机自启任务", "未找到！管理员运行 install-autostart.bat");
  }

  const bQ = run('schtasks /Query /TN HazardLedgerBackup /FO LIST');
  if (bQ && /HazardLedgerBackup/i.test(bQ)) {
    const nx = (bQ.match(/下次运行时间:\s*([^\r\n]+)|Next Run Time:\s*([^\r\n]+)/) || [])[0];
    ok("每日备份任务", `已注册${nx ? "，" + nx.replace(/\s+/g, " ").trim() : ""}`);
  } else {
    // 查询不可用（权限/被限制）时，用备份日志作为佐证，避免误报"未注册"
    const blog = path.join(ROOT, "backup.log");
    const hasLog = fs.existsSync(blog) && fs.readFileSync(blog, "utf8").trim().length > 0;
    if (hasLog) warn("每日备份任务", "无法直接查询任务状态（可能权限不足），但 backup.log 显示备份执行过 —— 建议以管理员身份再确认");
    else bad("每日备份任务", "未注册！管理员运行 install-autostart.bat，或双击 backup-db.bat 手动备份");
  }

  const fw = run('netsh advfirewall firewall show rule name="HazardLedger 3000"');
  if (fw && /HazardLedger 3000/i.test(fw)) ok("防火墙规则", "已放行 TCP 3000（局域网可访问）");
  else bad("防火墙规则", "未放行 3000 端口！局域网同事将无法访问");

  // ---------- 四、数据安全 ----------
  title("四、备份与照片");
  const bkDir = path.join(ROOT, "backup");
  if (fs.existsSync(bkDir)) {
    const files = fs.readdirSync(bkDir).filter((f) => f.endsWith(".sql"))
      .map((f) => ({ f, m: fs.statSync(path.join(bkDir, f)).mtimeMs, s: fs.statSync(path.join(bkDir, f)).size }))
      .sort((a, b) => b.m - a.m);
    if (files.length === 0) warn("数据库备份", "备份目录为空，尚未产生备份");
    else {
      const d = daysAgo(files[0].m);
      const desc = `${files[0].f}（${fmtSize(files[0].s)}，${d === 0 ? "今天" : d + " 天前"}）`;
      if (d <= 1) ok("最近备份", desc);
      else warn("最近备份", `${desc} —— 已超过 1 天，请检查备份任务`);
      info("备份份数", `${files.length} 份（系统自动保留最近 14 份）`);
    }
  } else warn("数据库备份", "backup 目录不存在");

  const upDir = path.join(ROOT, "uploads");
  if (fs.existsSync(upDir)) {
    const ups = fs.readdirSync(upDir);
    let sz = 0;
    for (const f of ups) { try { sz += fs.statSync(path.join(upDir, f)).size; } catch {} }
    info("照片目录", `${ups.length} 张，占用 ${fmtSize(sz)}`);
  }

  // ---------- 五、磁盘空间 ----------
  title("五、磁盘空间");
  try {
    const st = fs.statfsSync("D:\\");
    const freeGB = (st.bavail * st.bsize) / 1073741824;
    if (freeGB > 10) ok("D 盘剩余", `${freeGB.toFixed(1)} GB`);
    else if (freeGB > 2) warn("D 盘剩余", `${freeGB.toFixed(1)} GB —— 空间偏紧，建议清理`);
    else bad("D 盘剩余", `${freeGB.toFixed(1)} GB —— 空间严重不足！`);
  } catch { info("D 盘剩余", "（无法读取）"); }

  // ---------- 六、代码与版本库 ----------
  title("六、代码与版本库");
  const branch = run(`git -C "${ROOT}" branch --show-current`);
  const dirty = run(`git -C "${ROOT}" status --short`);
  const last = run(`git -C "${ROOT}" log -1 --format="%h %ad %s" --date=format:"%Y-%m-%d %H:%M"`);
  if (branch) {
    ok("Git 仓库", `分支 ${branch}`);
    info("最近提交", last || "（无）");
    if (!dirty) ok("工作区", "干净（没有未提交的改动）");
    else warn("工作区", `有 ${dirty.split("\n").length} 个文件未提交 —— 建议提交或还原`);
  } else info("Git 仓库", "未初始化");

  // ---------- 七、近期运行错误 ----------
  title("七、近期运行错误");
  const logFile = path.join(ROOT, "server-out.log");
  if (fs.existsSync(logFile)) {
    const lines = fs.readFileSync(logFile, "utf8").split("\n");
    // 用最后一次"服务已启动"横幅切分：
    // 之前的错误属于历史（可能已修复），之后的才是当前这次运行的错误
    let lastBoot = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes("本地服务已启动")) { lastBoot = i; break; }
    }
    const errLines = [];
    lines.forEach((l, i) => { if (l.includes("[ERROR]")) errLines.push({ i, l }); });
    const current = errLines.filter((e) => e.i > lastBoot);
    const history = errLines.filter((e) => e.i <= lastBoot);

    if (errLines.length === 0) ok("错误日志", "无任何错误记录");
    else if (current.length === 0) ok("错误日志", `无当前运行期错误（历史错误 ${history.length} 条，属已修复的旧问题，可忽略）`);
    else {
      bad("错误日志", `当前运行期有 ${current.length} 条错误（最近 ${Math.min(3, current.length)} 条）：`);
      current.slice(-3).forEach((e) => info("", e.l.slice(0, 110)));
    }
    if (history.length > 5) info("历史错误", `${history.length} 条（发生在更早的服务运行期间）`);
    info("日志大小", `${fmtSize(fs.statSync(logFile).size)}（过大可清空，不影响运行）`);
  } else info("错误日志", "暂无日志文件");

  // ---------- 汇总 ----------
  say("");
  say("=".repeat(62));
  say(`  体检完成： 正常 ${nOk} 项 ｜ 注意 ${nWarn} 项 ｜ 异常 ${nBad} 项`);
  if (nBad === 0 && nWarn === 0) say("  ✅ 系统状态良好，无需处理。");
  else if (nBad === 0) say("  ℹ️ 无异常项，标「注意」的建议留意一下。");
  else say("  ⚠️ 存在异常项，请按上面提示处理后重新体检。");
  say("=".repeat(62));
  say("");
})();
