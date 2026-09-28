#!/usr/bin/env node
/**
 * 把当前项目连接到 GitHub 仓库（一次性设置）。
 * 由 `推送到GitHub.bat` 调用（那个 .bat 保持纯 ASCII，中文都放这里）。
 *
 * 设计要点：
 *   - **默认拒绝覆盖已有 remote**：本项目现在的 origin 是 SSH
 *     （`git@github.com:nezu9ko/hazard-ledger.git`，走 443 隧道）。
 *     这个脚本是给"全新克隆、还没有 remote"的场景用的，
 *     误运行会把好不容易配好的 SSH 改成 HTTPS，那就白折腾了。
 *   - 真要改，加参数 `force`。
 *
 * 用法：
 *   node tools/remote-setup.js            # 查看/首次设置
 *   node tools/remote-setup.js force      # 强制改（会提示确认）
 *   node tools/remote-setup.js --url <地址> [force]   # 非交互
 */
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const ROOT = path.resolve(__dirname, "..");
const GIT = process.env.GIT_EXE || (fs.existsSync("D:\\Git\\cmd\\git.exe") ? "D:\\Git\\cmd\\git.exe" : "git");

function git(args) {
  try {
    return { ok: true, out: execFileSync(GIT, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (e) {
    return { ok: false, out: String(e.stdout || "").trim(), err: String(e.stderr || "").trim() };
  }
}

const say = (...a) => console.log(...a);
const line = () => say("======================================================");

function ask(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (ans) => { rl.close(); resolve(String(ans || "").trim()); });
  });
}

(async () => {
  const args = process.argv.slice(2);
  const force = args.includes("force");
  const urlIdx = args.indexOf("--url");
  const urlArg = urlIdx >= 0 ? args[urlIdx + 1] : "";

  line();
  say("  连接 GitHub 仓库");
  line();
  say();

  const cur = git(["remote", "get-url", "origin"]);
  const hasRemote = cur.ok && cur.out;

  if (hasRemote && !force) {
    say("  这个项目已经连好 GitHub 了，不需要再设置：");
    say();
    say("    origin = " + cur.out);
    const isSSH = /^git@|^ssh:\/\//.test(cur.out);
    if (isSSH) {
      say();
      say("  （当前走 SSH over 443 隧道，推送不需要开代理）");
      say("  日常推送：      \"" + GIT + "\" push origin main");
    } else {
      say();
      say("  ⚠️ 当前是 HTTPS，github.com:443 时通时断，推送前需要开代理。");
      say("     想一劳永逸改用 SSH，见《维护手册》7.3。");
    }
    say();
    say("  想知道有哪些提交还没推 → 双击 查看待推送.bat");
    say();
    say("  确实要改这个地址，请加 force 参数重跑。");
    line();
    return;
  }

  if (hasRemote && force) {
    say("  当前 origin = " + cur.out);
    say("  警告：即将**覆盖**上面的地址。");
    say();
    const ans = urlArg ? "y" : await ask("  确定要改吗？输入 y 继续: ");
    if (ans.toLowerCase() !== "y") { say("  已取消。"); line(); return; }
  }

  let url = urlArg;
  if (!url) {
    say("  请先在 GitHub 网页上创建一个【空仓库】：");
    say("    - 不要勾选 Add a README file / .gitignore / license");
    say();
    say("  地址两种都支持：");
    say("    SSH   : git@github.com:用户名/仓库名.git        ← 推荐，不用开代理");
    say("    HTTPS : https://github.com/用户名/仓库名.git    ← 需要开代理");
    say();
    url = await ask("  粘贴仓库地址后回车: ");
  }

  if (!url) { say(); say("  [已取消] 没有输入地址。"); line(); return; }

  const okForm = /^https:\/\/github\.com\/.+\/.+(\.git)?$/.test(url) || /^git@github\.com:.+\/.+(\.git)?$/.test(url);
  if (!okForm) {
    say();
    say("  [错误] 地址格式不对。应为：");
    say("    git@github.com:用户名/仓库名.git");
    say("    https://github.com/用户名/仓库名.git");
    line();
    process.exitCode = 1;
    return;
  }

  say();
  say("  [1/3] 设置远端地址...");
  git(["remote", "remove", "origin"]);
  const add = git(["remote", "add", "origin", url]);
  if (!add.ok) { say("  [失败] " + (add.err || "")); line(); process.exitCode = 1; return; }
  say("        已设置为: " + url);

  say();
  say("  [2/3] 本地最近提交：");
  const log = git(["log", "--oneline", "-3"]);
  (log.out || "(无)").split("\n").forEach((l) => say("        " + l));

  say();
  say("  [3/3] 开始推送...");
  say();
  const isSSH = /^git@|^ssh:\/\//.test(url);
  if (!isSSH) {
    say("  ★ HTTPS 推送会弹浏览器要求登录 GitHub 授权，点 Authorize 即可，");
    say("    授权后凭据会被记住。若失败，多半是代理没开。");
    say();
  }
  const push = spawnSync(GIT, isSSH ? ["push", "-u", "origin", "main"] : [
    "-c", "http.https://github.com.proxy=", "-c", "http.proxy=", "push", "-u", "origin", "main",
  ], {
    cwd: ROOT, stdio: "inherit",
    env: Object.assign({}, process.env, { HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "" }),
  });

  say();
  if (push.status === 0) {
    line();
    say("  ✅ 推送成功。以后改完代码用 查看待推送.bat 查看并推送。");
    line();
  } else {
    line();
    say("  [推送失败] 常见原因：");
    say("    1) 地址写错（注意 .git 结尾）");
    say("    2) GitHub 上不是空仓库（有同名文件）");
    say("    3) 走 HTTPS 但没开代理");
    say("    4) SSH 公钥没加到 GitHub");
    line();
    process.exitCode = 1;
  }
})();
