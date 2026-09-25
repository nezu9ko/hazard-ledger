/**
 * 输出 config.json 中的数据库口令（供 .bat 脚本用 for /f 读取）。
 *
 * 为什么要单独做成一个文件：
 *   原先 .bat 里直接内联 `node -e "process.stdout.write(require('./config.json')...)"`，
 *   而 JS 代码里有**单引号**，恰好与 cmd 的 `for /f ('命令')` 的单引号分隔符冲突，
 *   导致命令被截断、口令读不到（备份连续几天失败且不易察觉）。
 *   改为调用本文件后，for /f 命令里不再出现任何单引号。
 *
 * 用法：node tools/get-db-password.js
 *   成功 → stdout 输出口令（无换行），退出码 0
 *   失败 → stdout 为空，stderr 给出原因，退出码 1
 *
 * 路径以**本文件所在位置**为基准解析，因此不依赖调用方的工作目录。
 */
const fs = require("fs");
const path = require("path");

try {
  const cfgPath = path.join(__dirname, "..", "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const pwd = cfg && cfg.db && cfg.db.password;
  if (!pwd) {
    process.stderr.write("config.json 中缺少 db.password\n");
    process.exit(1);
  }
  process.stdout.write(String(pwd));   // 关键：不输出换行，避免口令末尾混入 \r\n
} catch (e) {
  process.stderr.write(`读取 config.json 失败：${e.message}\n`);
  process.exit(1);
}
