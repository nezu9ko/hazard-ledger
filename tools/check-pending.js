#!/usr/bin/env node
/**
 * 查看「有哪些提交还没推送到 GitHub」
 *
 * 为什么用 Node 而不是纯 .bat：
 *   cmd.exe 解析含中文的 .bat 时，即使 `chcp 65001` 也会**偶发地把多字节字符拆坏**，
 *   坏掉的字节会被当成命令名，报「'xxx' 不是内部或外部命令」。
 *   本项目已有 Node，把中文输出交给 Node 最稳 —— .bat 只留纯 ASCII 一行调用。
 *
 * 本项目约定（见《维护手册》7.3）：**不自动推送**。
 * 流程：本地提交 → 用本脚本查看待推送 → 打开代理 → 手动 push。
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const GIT = process.env.GIT_EXE
  || (require("node:fs").existsSync("D:\\Git\\cmd\\git.exe") ? "D:\\Git\\cmd\\git.exe" : "git");
const ROOT = path.resolve(__dirname, "..");

/** 跑一条 git，返回 { ok, out }；永不抛错 */
function git(args) {
  try {
    const out = execFileSync(GIT, args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: Object.assign({}, process.env, { HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "" }),
    });
    return { ok: true, out: out.trim() };
  } catch (e) {
    return { ok: false, out: String(e.stdout || "").trim(), err: String(e.stderr || "").trim() };
  }
}

const lines = [];
const say = (s = "") => lines.push(s);

say("======================================================");
say("  待推送检查");
say("======================================================");
say();

const fetch = git(["fetch", "origin", "main"]);
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).out || "main";

if (!fetch.ok) {
  say("  [注意] 现在连不上 GitHub（github.com:443 时通时断），下列清单基于");
  say("         **上次成功拉取时**记录的远端位置，可能略旧。开代理后重跑即为最新。");
} else {
  say("  远端位置已刷新为最新。");
}

// 关键：`origin/main..HEAD` 用的是**本地记录的远端引用**，断网也能算，
// 所以不要因为 fetch 失败就放弃比对 —— 那会让用户看不到自己有哪些提交没推。
const ahead = git(["log", "--oneline", "origin/main..HEAD"]);
if (!ahead.ok) {
  say("  ⚠️ 无法读取远端引用 origin/main，下面列出最近 10 次本地提交供参考：");
  say();
  git(["log", "--oneline", "-10"]).out.split("\n").filter(Boolean).forEach((l) => say("    " + l));
} else if (ahead.out) {
  const n = ahead.out.split("\n").filter(Boolean).length;
  say();
  say(`  尚未推送的提交（共 ${n} 个）：`);
  say();
  ahead.out.split("\n").filter(Boolean).forEach((l) => say("    " + l));
} else {
  say();
  say("  尚未推送的提交：无 —— 本地提交都已推送。");
}

const behind = git(["rev-list", "--count", "HEAD..origin/main"]);
if (behind.ok && Number(behind.out) > 0) {
  say();
  say(`  ⚠️ 远端还有 ${behind.out} 个提交本地没有，推送前先 git pull --rebase。`);
}

say();
say("  本地工作区状态：");
// 注意：git 的 -c 必须写在子命令**之前**，写成 `git status --short -c xxx` 会直接报错，
// 而报错时若当成"没有输出"就会误报"干净" —— 这类静默失败最危险，故这里显式区分失败。
const st = git(["-c", "core.quotepath=false", "status", "--short"]);
if (!st.ok) {
  say("    ⚠️ 读取失败，无法判断工作区是否干净：" + (st.err || st.out || "未知错误").split("\n")[0]);
} else if (st.out) {
  st.out.split("\n").filter(Boolean).forEach((l) => say("    " + l));
} else {
  say("    （干净：改动都已提交）");
}

say();
say("  推送命令（先把代理打开，再执行）：");
say();
say(`    "${GIT}" -c http.https://github.com.proxy= -c http.proxy= push origin ${branch}`);
say();
say("======================================================");

const text = lines.join("\n");
process.stdout.write("\ufeff" + text + "\n");

// 顺便落一份记录，方便事后回看
try {
  const fs = require("node:fs");
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  fs.writeFileSync(
    path.join(ROOT, "待推送记录.md"),
    `# 待推送记录\n\n> 由 \`查看待推送.bat\` / \`tools/check-pending.js\` 自动生成，每次运行覆盖。\n`
    + `> 生成时间：${stamp}\n\n\`\`\`\n${text}\n\`\`\`\n`
  );
} catch { /* 写不了记录不影响主输出 */ }
