/**
 * 配置与全局常量（部署参数、角色/等级/类别枚举、部门播种数据）
 *
 * ⚠️ 本文件原在 `server.js` 里，2026-09-29 按功能拆分到 lib/ 下。
 *    顶部的 require 是"本文件实际用到什么就引什么"生成的；
 *    想知道本模块跟谁耦合，看顶部那几行就够了。
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
/* ---------------- 配置 ----------------
 * 优先级：环境变量 > config.json > 内置默认值。
 * 这样既能用 config.json 做本地部署配置，也方便在 CI/容器里用环境变量覆盖。
 */
// ⚠️ 本文件位于 lib/ 下，__dirname 是 lib/ 而不是项目根；根目录要往上走一级。
const ROOT = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const CONFIG_FILE = path.join(ROOT, "config.json");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function loadConfig() {
  const defaults = {
    port: 3000,
    host: "0.0.0.0",
    // 公司名称：仅存于 config.json（已被 .gitignore 排除），不会出现在版本库里。
    // 服务端通过 /api/app-info 下发给前端显示；留空则前端不显示。
    companyName: "",
    db: { host: "127.0.0.1", port: 5432, user: "postgres", password: "", database: "hazard_ledger" },
  };
  let fileCfg = {};
  try { fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { /* 首次运行无配置 */ }
  const cfg = { ...defaults, ...fileCfg, db: { ...defaults.db, ...(fileCfg.db || {}) } };
  // 环境变量优先
  cfg.port = Number(process.env.PORT || cfg.port);
  cfg.host = process.env.HOST || cfg.host;
  cfg.db.host = process.env.PGHOST || cfg.db.host;
  cfg.db.port = Number(process.env.PGPORT || cfg.db.port);
  cfg.db.user = process.env.PGUSER || cfg.db.user;
  cfg.db.password = process.env.PGPASSWORD || cfg.db.password;
  cfg.db.database = process.env.PGDATABASE || cfg.db.database;
  return cfg;
}
const CFG = loadConfig();

/* 业务枚举（与前端 script.js 中的 LABELS 映射表一一对应）
 * 这些值是写入数据库的"机器码"，改动需同步前端与既有数据 */
const DEFAULT_INITIAL_PASSWORD = "123456";                                              // 新建用户的初始密码（首次登录强制修改）
const LEVELS = ["major", "general"];                                                      // 隐患等级：重大/一般（二级）
const CATEGORIES = ["equipment", "operation", "fire", "electrical", "environment", "management"]; // 隐患类别
const STATUSES = ["pending", "rectifying", "closed"];                                   // 数据库可存的三种状态（overdue 为派生状态，不入库）
// 角色只分两类：系统管理员（可管用户/删隐患/应急代办）与普通用户（业务操作）。
// 登记、整改、复查都不再按角色授权，而是**按人**：整改填本人、复查由指定复查人。
const ROLES = ["user", "admin"];

/** 部门列表（一级菜单）；责任人下拉按此分组，人名作为二级。
 *  ★ 这里列出的部门会**全部**出现在下拉框里（哪怕该部门暂时没人）。
 *  ⚠️ 从 2026-09-29 起，部门改为**存在数据库里、可在「用户管理 → 部门管理」里增删改**；
 *     这个常量只在**首次建库时用来播种**，之后就以数据库为准（见 handleDepartments）。 */
const DEPARTMENTS_SEED = [
  "领导班子", "地测部", "安全部", "通风部", "环保部", "机电部", "生产技术部",
  "采矿车间", "基建部", "选矿厂", "财务部", "综合管理部",
];

module.exports = {
  ROOT,
  PUBLIC_DIR,
  UPLOAD_DIR,
  CONFIG_FILE,
  loadConfig,
  CFG,
  DEFAULT_INITIAL_PASSWORD,
  LEVELS,
  CATEGORIES,
  STATUSES,
  ROLES,
  DEPARTMENTS_SEED,
};
