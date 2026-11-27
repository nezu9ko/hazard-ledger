/**
 * 重启开发服（3100）。
 *
 * 为什么需要单独一个脚本：开发服是计划任务 `HazardLedgerDev` 启动的常驻进程，
 * 改了后端代码（lib/*.js）后不重启就不会生效 —— 而进程是管理员权限启动的，
 * 普通命令行 taskkill 会"拒绝访问"。
 *
 * 流程：找占用 3100 的进程 → 杀掉 → 用计划任务重新拉起 → 等端口就绪。
 * 由根目录的 `重启开发服.bat` 以管理员身份调用。
 */

"use strict";

const { spawnSync } = require("node:child_process");
const http = require("node:http");

const PORT = Number(process.env.DEV_PORT || 3100);
const TASK = process.env.DEV_TASK || "HazardLedgerDev";

const C = { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", c: "\x1b[36m", d: "\x1b[90m", x: "\x1b[0m" };
const say = (s = "") => console.log(s);
const ok = (s) => say(`${C.g}[OK]${C.x} ${s}`);
const warn = (s) => say(`${C.y}[WARN]${C.x} ${s}`);
const bad = (s) => say(`${C.r}[ERROR]${C.x} ${s}`);

/** 找监听指定端口的进程 PID */
function findPid(port) {
  const r = spawnSync("netstat", ["-ano"], { encoding: "utf8" });
  const lines = (r.stdout || "").split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes("LISTENING")) continue;
    const parts = line.trim().split(/\s+/);
    // 形如：TCP  0.0.0.0:3100  0.0.0.0:0  LISTENING  20400
    if (parts.length >= 5 && parts[1].endsWith(`:${port}`)) return parts[parts.length - 1];
  }
  return null;
}

function httpGet(url, timeout = 5000) {
  return new Promise((res) => {
    const req = http.get(url, { timeout }, (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => res({ code: r.statusCode, body: b }));
    });
    req.on("timeout", () => { req.destroy(); res({ code: 0, body: "timeout" }); });
    req.on("error", () => res({ code: 0, body: "error" }));
  });
}

(async () => {
  say(`${C.d}重启开发服（端口 ${PORT}）${C.x}`);

  // ---- 1. 管理员检查 ----
  const adm = spawnSync("net", ["session"], { stdio: "ignore" });
  if (adm.status !== 0) {
    bad("需要管理员权限：请右键「以管理员身份运行」");
    process.exit(1);
  }
  ok("管理员权限已确认");

  // ---- 2. 停掉旧进程 ----
  const pid = findPid(PORT);
  if (!pid) {
    warn(`端口 ${PORT} 当前没有进程在监听，直接启动`);
  } else {
    say(`  正在停止旧进程 PID ${pid} …`);
    const kill = spawnSync("taskkill", ["/F", "/PID", pid], { encoding: "utf8" });
    if (kill.status === 0) ok(`已停止 PID ${pid}`);
    else warn(`停止失败：${(kill.stderr || kill.stdout || "").trim() || "未知原因"}`);
  }

  // 等端口真正释放（Windows 上进程退出到端口释放有个短暂间隔）
  for (let i = 0; i < 10; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    if (!findPid(PORT)) break;
  }

  // ---- 3. 用计划任务重新拉起 ----
  say(`  正在通过计划任务 ${TASK} 启动 …`);
  const run = spawnSync("schtasks", ["/Run", "/TN", TASK], { encoding: "utf8" });
  if (run.status !== 0) {
    bad(`计划任务「${TASK}」启动失败`);
    say(`  ${(run.stderr || run.stdout || "").trim()}`);
    say("");
    say(`${C.d}  可能的原因：任务被删了。可以：${C.x}`);
    say(`${C.d}    1) 手动双击 dev\\run-server.bat（关掉窗口即停）${C.x}`);
    say(`${C.d}    2) 或等看护任务 HazardLedgerDevWatchdog 在 5 分钟内拉起${C.x}`);
    process.exit(1);
  }
  ok("已触发计划任务");

  // ---- 4. 等端口就绪 ----
  say("  等待服务响应 …");
  let up = null;
  for (let i = 1; i <= 20; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    const h = await httpGet(`http://127.0.0.1:${PORT}/api/health`);
    if (h.code === 200 && /"ok"\s*:\s*true/i.test(h.body)) { up = h; say(`  第 ${i} 秒响应正常`); break; }
  }

  say("");
  if (up) {
    const newPid = findPid(PORT);
    say(`${C.g}  ================================================${C.x}`);
    say(`${C.g}   开发服已重启${C.x}`);
    say(`${C.g}  ================================================${C.x}`);
    say(`   端口：${PORT}${newPid ? `　PID：${newPid}` : ""}`);
    say(`   地址：http://127.0.0.1:${PORT}`);
    say(`${C.d}   现在跑回归的结果才是可信的（前后端都是最新代码）${C.x}`);
    process.exitCode = 0;
  } else {
    bad(`服务在 20 秒内没有响应`);
    say(`  请检查 dev\\server-out.log 与计划任务状态`);
    process.exitCode = 1;
  }
})().catch((e) => {
  bad(`脚本异常：${e.message}`);
  say(e.stack);
  process.exitCode = 1;
});
