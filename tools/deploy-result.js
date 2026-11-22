/**
 * 发布脚本的收尾提示。
 *
 * 为什么单独做成一个 node 脚本：`.bat` 里直接写中文，cmd 在多字节字符上
 * 容易拆坏（历史上踩过），所以中文输出统一交给 Node。
 *
 * 用法：node tools/deploy-result.js ok
 *       node tools/deploy-result.js fail
 */

"use strict";

const ok = process.argv[2] !== "fail";

if (ok) {
  console.log("");
  console.log("  ================================================");
  console.log("   ");
  console.log("          发  布  成  功");
  console.log("   ");
  console.log("  ================================================");
  console.log("   线上已更新到最新版本，可以正常使用。");
} else {
  console.log("");
  console.log("  ================================================");
  console.log("   ");
  console.log("      发  布  完  成 ，  但  健  康  检  查  未  通  过");
  console.log("   ");
  console.log("  ================================================");
  console.log("   请检查 app\\server-out.log 与 deploy.log，必要时按上面的回滚命令处理。");
}
