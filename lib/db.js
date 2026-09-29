/**
 * 数据库：连接池、建库建表、表/字段中文注释同步
 *
 * ⚠️ 本文件原在 `server.js` 里，2026-09-29 按功能拆分到 lib/ 下。
 *    顶部的 require 是"本文件实际用到什么就引什么"生成的；
 *    想知道本模块跟谁耦合，看顶部那几行就够了。
 */

"use strict";

const { CFG, DEFAULT_INITIAL_PASSWORD, DEPARTMENTS_SEED } = require("./config.js");
const { makePasswordHash, genId } = require("./util.js");
const { Client, Pool } = require("pg");

/* ---------------- 表 / 字段的中文注释 ----------------
 * 目的：让 DBeaver、psql 等工具**直接显示中文含义**，不必再对照文档查英文列名。
 * 实现：用 COMMENT ON 写入 PostgreSQL 系统目录，**幂等**——
 *      每次启动同步一遍，改动这里的文案后重启服务即可生效。
 * 格式：[对象类型, 表名, 列名(表级注释填 null), 注释内容]
 */
const SCHEMA_COMMENTS = [
  // ---------- hazard 隐患台账主表 ----------
  ["TABLE", "hazard", null, "隐患台账主表（排查发现 → 登记上报 → 整改实施 → 复查验收 → 闭环销号）"],
  ["COLUMN", "hazard", "id", "主键ID（随机24位十六进制）"],
  ["COLUMN", "hazard", "hazard_code", "隐患编号，格式 YH-YYYYMMDD-NNNN（按登记日期自动取号，不撞号）"],
  ["COLUMN", "hazard", "inspect_date", "排查日期 YYYY-MM-DD"],
  ["COLUMN", "hazard", "inspector", "排查人"],
  ["COLUMN", "hazard", "location", "隐患部位 / 地点"],
  ["COLUMN", "hazard", "description", "隐患描述"],
  ["COLUMN", "hazard", "category", "隐患类别：equipment设备设施 / operation违章行为 / fire消防安全 / electrical电气安全 / environment环境安全 / management安全管理"],
  ["COLUMN", "hazard", "level", "隐患等级：major重大 / general一般"],
  ["COLUMN", "hazard", "rectify_measure", "整改措施（登记时不填，由整改责任人「开始整改」时填写）"],
  ["COLUMN", "hazard", "rectify_person", "整改责任人姓名（登记时从系统用户中选择，冗余存姓名便于打印/导出）"],
  ["COLUMN", "hazard", "rectify_user_id", "整改责任人用户ID（与 rectify_person 对应；用于「我的待办」按账号精确匹配。历史数据可能为空）"],
  ["COLUMN", "hazard", "rectify_fund", "整改资金（单位：元）"],
  ["COLUMN", "hazard", "plan_deadline", "计划完成日期；未闭环且已过此日期即判为「逾期」（逾期是实时计算的派生状态，不落库）"],
  ["COLUMN", "hazard", "emergency_plan", "应急预案"],
  ["COLUMN", "hazard", "status", "状态：pending待整改 / rectifying整改中 / closed已闭环"],
  ["COLUMN", "hazard", "actual_complete_date", "实际完成整改的日期"],
  ["COLUMN", "hazard", "reviewer", "复查（验收）人姓名（登记时指定，冗余存姓名便于打印/导出）"],
  ["COLUMN", "hazard", "reviewer_user_id", "复查人用户ID（与 reviewer 对应；只有该人可执行复查闭环，管理员可代办）"],
  ["COLUMN", "hazard", "review_date", "复查日期"],
  ["COLUMN", "hazard", "review_result", "复查意见"],
  ["COLUMN", "hazard", "closed_at", "闭环时间（看板「闭环耗时」= closed_at − created_at）"],
  ["COLUMN", "hazard", "created_at", "创建（登记入库）时间"],
  ["COLUMN", "hazard", "updated_at", "最后更新时间"],
  ["COLUMN", "hazard", "hazard_photos", "隐患照片路径数组（JSON 字符串，元素形如 /uploads/xxx.jpg，最多6张）"],
  ["COLUMN", "hazard", "rectify_photos", "整改照片路径数组（JSON 字符串，最多6张）"],

  // ---------- users 用户表 ----------
  ["TABLE", "users", null, "用户账号表"],
  ["COLUMN", "users", "id", "主键ID"],
  ["COLUMN", "users", "user_id", "登录账号（唯一）"],
  ["COLUMN", "users", "user_name", "用户姓名（唯一，操作日志中显示的就是它）"],
  ["COLUMN", "users", "role", "角色：user普通用户 / admin系统管理员"],
  ["COLUMN", "users", "department", "所属部门（如 安全部/机电部）；责任人下拉按部门分组展示"],
  ["COLUMN", "users", "salt", "口令盐值（scrypt 格式自描述串时可为空）"],
  ["COLUMN", "users", "password_hash", "口令散列值（scrypt 慢哈希，自描述格式；兼容旧 SHA-256）"],
  ["COLUMN", "users", "must_change_password", "是否强制修改密码（新建用户、重置密码后为 true，首次登录须改密）"],
  ["COLUMN", "users", "created_at", "创建时间"],

  // ---------- operation_log 操作日志表 ----------
  ["TABLE", "operation_log", null, "操作日志表（所有写操作留痕，用于事后追溯「谁在何时做了什么」）"],
  ["COLUMN", "operation_log", "id", "主键ID"],
  ["COLUMN", "operation_log", "user_id", "操作人ID"],
  ["COLUMN", "operation_log", "user_name", "操作人姓名"],
  ["COLUMN", "operation_log", "action", "操作类型：login登录 / create_hazard登记 / update_hazard修改 / start_rectify开始整改 / review_hazard复查闭环 / delete_hazard删除 / create_user新增用户 / update_user_role改角色 / reset_password重置密码 / delete_user删除用户 / export_hazard导出 / cleanup_photos清理图片"],
  ["COLUMN", "operation_log", "target_type", "操作对象类型（如 hazard 隐患 / user 用户）"],
  ["COLUMN", "operation_log", "target_id", "操作对象ID"],
  ["COLUMN", "operation_log", "target_code", "操作对象编号（如隐患编号 YH-YYYYMMDD-NNNN）"],
  ["COLUMN", "operation_log", "detail", "操作详情（如「状态：待整改 → 整改中」）"],
  ["COLUMN", "operation_log", "created_at", "操作时间"],

  // ---------- sessions 会话表 ----------
  ["TABLE", "sessions", null, "登录会话表（服务端令牌鉴权，令牌放于 Authorization: Bearer 请求头）"],
  ["COLUMN", "sessions", "token", "会话令牌（主键，随机24字节十六进制）"],
  ["COLUMN", "sessions", "user_id", "所属用户ID"],
  ["COLUMN", "sessions", "created_at", "令牌签发时间"],
  ["COLUMN", "sessions", "expires_at", "过期时间（默认签发后 7 天；清理此表可强制所有人重新登录）"],

  // ---------- counters 编号计数器 ----------
  ["TABLE", "counters", null, "隐患编号计数器（按登记日期原子取号，避免并发撞号）"],
  ["COLUMN", "counters", "date_part", "日期 YYYYMMDD"],
  ["COLUMN", "counters", "n", "该日期已发放的编号数量（下一个编号 = n + 1）"],
];

/** SQL 字符串字面量转义（COMMENT 是工具命令，无法用 $1 占位符） */
const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** 把所有表 / 字段注释同步到数据库（幂等，可重复执行） */
async function applySchemaComments() {
  for (const [kind, table, col, text] of SCHEMA_COMMENTS) {
    const sql = kind === "TABLE"
      ? `COMMENT ON TABLE ${table} IS ${sq(text)}`
      : `COMMENT ON COLUMN ${table}.${col} IS ${sq(text)}`;
    await pool.query(sql);
  }
  console.log(`[DB] 已同步 ${SCHEMA_COMMENTS.length} 条表/字段中文注释`);
}

/* ---------------- 数据库初始化 ----------------
 * 幂等：可重复执行。流程
 *   ① 先用维护库 postgres 连上去，若目标库不存在则 CREATE DATABASE；
 *   ② 切换到目标库建表（IF NOT EXISTS）+ 补列（ALTER ... ADD COLUMN IF NOT EXISTS，
 *      用于兼容早期版本已存在的库）；
 *   ③ 同步表 / 字段的中文注释（见上方 SCHEMA_COMMENTS）；
 *   ④ 若 users 表为空则播种初始管理员 admin（初始口令见 DEFAULT_INITIAL_PASSWORD，
 *      刻意不在控制台/日志里打印，见下方 console.log 处的说明）。
 */
async function initDatabase() {
  // 1) 自动建库（连到 postgres 维护库）
  const admin = new Client({ ...CFG.db, database: "postgres" });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [CFG.db.database]);
  if (exists.rowCount === 0) {
    await admin.query(`CREATE DATABASE "${CFG.db.database}"`);
    console.log(`[DB] 已创建数据库 ${CFG.db.database}`);
  }
  await admin.end();

  // 2) 建表
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hazard (
      id TEXT PRIMARY KEY,
      hazard_code TEXT NOT NULL UNIQUE,
      inspect_date TEXT NOT NULL,
      inspector TEXT NOT NULL,
      location TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      level TEXT NOT NULL,
      rectify_measure TEXT,                            -- 登记时不填，由整改责任人在「开始整改」时填写
      rectify_person TEXT NOT NULL,
      rectify_fund NUMERIC(14,2) NOT NULL DEFAULT 0,
      plan_deadline TEXT NOT NULL,
      emergency_plan TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      actual_complete_date TEXT,
      reviewer TEXT,
      reviewer_user_id TEXT,
      review_date TEXT,
      review_result TEXT,
      closed_at TIMESTAMPTZ,
      hazard_photos TEXT,
      rectify_photos TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE hazard ADD COLUMN IF NOT EXISTS hazard_photos TEXT;
    ALTER TABLE hazard ADD COLUMN IF NOT EXISTS rectify_photos TEXT;
    ALTER TABLE hazard ADD COLUMN IF NOT EXISTS rectify_user_id TEXT;   -- 整改责任人用户ID（用于按账号匹配"我的待办"）
    -- 流程调整：登记时只填隐患信息，整改措施改由整改责任人在「开始整改」时填写，
    -- 因此老库上原有的 NOT NULL 约束要去掉（新库建表时已允许为空）。
    ALTER TABLE hazard ALTER COLUMN rectify_measure DROP NOT NULL;
    -- 复查人也需要绑定账号（只有指定的人能复查闭环）
    ALTER TABLE hazard ADD COLUMN IF NOT EXISTS reviewer_user_id TEXT;
    -- 角色收敛为「user普通用户 / admin系统管理员」两种；
    -- 原来的 entry/reviewer/safety_admin 一律并入 user（登记、整改、复查已改成按"人"授权）。
    ALTER TABLE users ADD COLUMN IF NOT EXISTS department TEXT;
    UPDATE users SET role = 'user' WHERE role NOT IN ('user', 'admin');
    -- 首次升级时把现有人员统一归入「安全部」（管理员之后可在用户管理里改）
    UPDATE users SET department = '安全部' WHERE department IS NULL;
    -- 老数据（当初只手填了姓名、没选用户）按姓名自动匹配绑定；
    -- 匹配不上的保持为空，此时仅系统管理员可代办（见 PATCH 权限判断）。
    UPDATE hazard h SET rectify_user_id = u.id
      FROM users u WHERE h.rectify_user_id IS NULL AND h.rectify_person = u.user_name;
    UPDATE hazard h SET reviewer_user_id = u.id
      FROM users u WHERE h.reviewer_user_id IS NULL AND h.reviewer = u.user_name;
    CREATE INDEX IF NOT EXISTS idx_hazard_status ON hazard(status);
    CREATE INDEX IF NOT EXISTS idx_hazard_inspect_date ON hazard(inspect_date);
    CREATE INDEX IF NOT EXISTS idx_hazard_plan_deadline ON hazard(plan_deadline);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      user_name TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      department TEXT,
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS counters (
      date_part TEXT PRIMARY KEY,
      n INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operation_log (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      user_name TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      target_code TEXT,
      detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_oplog_created ON operation_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_oplog_target ON operation_log(target_id);

    -- 部门字典：可在「用户管理 → 部门管理」里增删改。
    -- sort_order 决定下拉框/筛选里的先后顺序，新增的排在最后。
    CREATE TABLE IF NOT EXISTS departments (
      name TEXT PRIMARY KEY,
      sort_order INT NOT NULL DEFAULT 0
    );
  `);

  // 3) 写入表 / 字段中文注释（幂等，每次启动同步一遍）
  await applySchemaComments();

  // 3.5) 播种部门字典（只在空表时播一次，之后以数据库为准）
  {
    const dc = await pool.query("SELECT COUNT(*)::int AS c FROM departments");
    if (dc.rows[0].c === 0) {
      for (let i = 0; i < DEPARTMENTS_SEED.length; i += 1) {
        await pool.query(
          "INSERT INTO departments (name, sort_order) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING",
          [DEPARTMENTS_SEED[i], i]
        );
      }
      console.log(`[DB] 已播种 ${DEPARTMENTS_SEED.length} 个部门（可在「用户管理 → 部门管理」中维护）`);
    }
  }

  // 4) 播种默认管理员
    const c = await pool.query("SELECT COUNT(*)::int AS c FROM users");
    if (c.rows[0].c === 0) {
      const ph = makePasswordHash(DEFAULT_INITIAL_PASSWORD);
      await pool.query(
        "INSERT INTO users (id,user_id,user_name,role,salt,password_hash,must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [genId(), "u_admin", "admin", "admin", ph.salt, ph.hash, false]
      );
      // 这里**故意不打印口令**：控制台/日志文件会被无关人员看到，口令请查《维护手册》。
      console.log("[DB] 已创建初始管理员账号 admin（初始口令见《维护手册》，首次登录后请立即修改）");
    }
}

const pool = new Pool(CFG.db);

module.exports = {
  SCHEMA_COMMENTS,
  sq,
  applySchemaComments,
  initDatabase,
  pool,
};
