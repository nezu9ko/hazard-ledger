/**
 * 发布脚本（dev → 线上）。
 *
 * 为什么用 Node 而不是全写在 .bat 里：
 *   .bat 遇到编码、括号、延迟展开、SSH 交互提示时很容易"窗口一闪就没了"，
 *   而且拿不到错误信息。放在 Node 里每一步都能打印、能捕获异常、中文也没有编码问题。
 *
 * 由根目录的 `02-发布到线上.bat` 以管理员身份调用。
 */

"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const readline = require("node:readline");

const ROOT = path.resolve(__dirname, "..", "..");
const APP = path.join(ROOT, "app");
const DEV = path.join(ROOT, "dev");
const TESTS = path.join(ROOT, "tests");
const GIT = fs.existsSync("D:\\Git\\cmd\\git.exe") ? "D:\\Git\\cmd\\git.exe" : "git";

const C = { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", c: "\x1b[36m", d: "\x1b[90m", x: "\x1b[0m" };
const say = (s = "") => console.log(s);
const ok = (s) => say(`${C.g}[OK]${C.x} ${s}`);
const warn = (s) => say(`${C.y}[WARN]${C.x} ${s}`);
const bad = (s) => say(`${C.r}[ERROR]${C.x} ${s}`);
const step = (s) => say(`\n${C.c}===== ${s} =====${C.x}`);

function git(args, cwd) {
  const r = spawnSync(GIT, args, { cwd, encoding: "utf8", timeout: 120000 });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

function ask(q) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); res(String(a).trim()); });
  });
}

function httpGet(url, timeout = 15000) {
  return new Promise((res) => {
    const req = http.get(url, { timeout }, (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => res({ code: r.statusCode, body: b }));
    });
    req.on("timeout", () => { req.destroy(); res({ code: 0, body: "timeout" }); });
    req.on("error", (e) => res({ code: 0, body: e.message }));
  });
}

(async () => {
  say(`${C.d}Hazard Ledger — 发布到线上${C.x}`);
  say(`${C.d}根目录：${ROOT}${C.x}`);

  // ---------- 0. 管理员 ----------
  const adm = spawnSync("net", ["session"], { stdio: "ignore" });
  if (adm.status !== 0) {
    bad("需要管理员权限：请右键「以管理员身份运行」");
    process.exit(1);
  }
  ok("管理员权限已确认");

  // ---------- 1. 预检 ----------
  step("1/5 预检");
  if (!fs.existsSync(path.join(APP, "pgdata"))) { bad(`找不到 ${APP}\\pgdata，生产目录不完整`); process.exit(1); }
  if (!fs.existsSync(path.join(DEV, ".git"))) { bad(`找不到 ${DEV}\\.git，开发目录不完整`); process.exit(1); }
  ok("目录结构正常");

  const appDirty = git(["status", "--porcelain"], APP).out;
  if (appDirty) {
    bad("生产目录有未提交改动，已中止（先处理掉再发布）：");
    say(appDirty);
    process.exit(1);
  }
  ok("生产目录干净");

  const fetchR = git(["fetch", "origin"], DEV);
  if (fetchR.code !== 0) {
    warn("git fetch 失败，将按本地已知的 origin/main 继续");
    if (fetchR.err) say(`${C.d}${fetchR.err}${C.x}`);
  } else {
    ok("已获取远端最新提交");
  }

  const devDirty = git(["status", "--porcelain"], DEV).out;
  if (devDirty) {
    warn("开发目录有未提交改动（不会被发布）：");
    say(devDirty);
    const a = await ask("仍然继续？(y/N) ");
    if (!/^y/i.test(a)) { say("已取消，未做任何改动。"); process.exit(1); }
  }

  const unpushed = git(["log", "--oneline", "origin/main..HEAD"], DEV).out;
  if (unpushed) {
    warn("开发目录有未推送的提交（线上拉不到）：");
    say(unpushed);
    const a = await ask("仍然继续？(y/N) ");
    if (!/^y/i.test(a)) { say("已取消，未做任何改动。"); process.exit(1); }
  }
  ok("开发目录检查通过");

  // ---------- 2. 回归（可选） ----------
  step("2/5 回归测试（可选）");
  const runReg = await ask("现在跑一遍全量回归？需要开发服 3100 在运行 (y/N) ");
  if (/^y/i.test(runReg)) {
    if (!fs.existsSync(path.join(TESTS, "run-all.js"))) {
      warn("没找到 tests/run-all.js，跳过");
    } else {
      say(`${C.d}正在跑，可能要几分钟…${C.x}`);
      const r = spawnSync(process.execPath, ["run-all.js"], {
        cwd: TESTS, encoding: "utf8",
        env: Object.assign({}, process.env, { BASE: "http://127.0.0.1:3100" }),
        timeout: 900000,
      });
      const out = `${r.stdout || ""}${r.stderr || ""}`;
      const tail = out.trim().split("\n").slice(-12).join("\n");
      say(tail);
      if (r.status !== 0) { bad(`回归未通过（exit ${r.status}），已中止，未发布`); process.exit(1); }
      ok("回归通过");
    }
  } else {
    say("已跳过");
  }

  // ---------- 3. 拉取 ----------
  step("3/5 拉取代码");
  const oldHead = git(["rev-parse", "HEAD"], APP).out;
  const pull = git(["pull", "--ff-only", "origin", "main"], APP);
  if (pull.code !== 0) {
    bad("git pull 失败，生产分支可能已分叉。未做任何改动。");
    say(pull.err || pull.out);
    process.exit(1);
  }
  const newHead = git(["rev-parse", "HEAD"], APP).out;
  if (oldHead === newHead) say(`已是最新（${newHead.slice(0, 7)}），仍会重启一次服务`);
  else ok(`${oldHead.slice(0, 7)} → ${newHead.slice(0, 7)}`);

  // ---------- 4. 重启 ----------
  step("4/5 重启服务（约 5 秒不可用）");
  const rs = spawnSync("cmd", ["/c", "restart-service.bat", "nopause"], {
    cwd: APP, encoding: "utf8", timeout: 180000,
  });
  const rsOut = `${rs.stdout || ""}${rs.stderr || ""}`.trim();
  if (rsOut) say(rsOut);
  if (rs.status !== 0) warn(`重启脚本返回 ${rs.status}，继续做健康检查`);

  // ---------- 5. 健康检查 ----------
  step("5/5 健康检查");
  let health = null;
  for (let i = 1; i <= 12; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    const h = await httpGet("http://127.0.0.1:3000/api/health");
    if (h.code === 200 && /"ok"\s*:\s*true/i.test(h.body)) { health = h; say(`第 ${i} 次探测通过`); break; }
    say(`${C.d}第 ${i} 次探测：${h.code || "无响应"}${C.x}`);
  }

  say("");
  if (health) {
    say(`${C.g}  ================================================${C.x}`);
    say(`${C.g}   ${C.x}`);
    say(`${C.g}           发  布  成  功${C.x}`);
    say(`${C.g}   ${C.x}`);
    say(`${C.g}  ================================================${C.x}`);
    say(`   线上版本：${newHead.slice(0, 7)}`);
    say(`   访问地址：http://localhost:3000`);
    say("");
    say(`${C.d}   如需回滚：${C.x}`);
    say(`${C.d}     "${GIT}" -C "${APP}" reset --hard ${oldHead}${C.x}`);
    say(`${C.d}     再运行 "${APP}\\restart-service.bat"（管理员）${C.x}`);
    process.exitCode = 0;
  } else {
    bad("发布完成，但健康检查未通过");
    say(`   请检查 ${APP}\\server-out.log`);
    say(`${C.d}   回滚："${GIT}" -C "${APP}" reset --hard ${oldHead}${C.x}`);
    process.exitCode = 1;
  }
})().catch((e) => {
  bad(`发布脚本异常：${e.message}`);
  say(e.stack);
  process.exitCode = 1;
});
