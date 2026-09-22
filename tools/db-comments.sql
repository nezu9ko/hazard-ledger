-- ============================================================================
--  隐患治理台账系统 — 表 / 字段中文注释
-- ============================================================================
--  本文件由 tools/gen-db-comments.js 从 server.js 的 SCHEMA_COMMENTS 自动生成，
--  请勿手工修改；要改注释请改 server.js 后重新生成。
--
--  何时需要用到本文件？
--    · 服务启动时会自动同步这些注释，**平时无需手动执行**；
--    · 仅当你把数据库搬到别处、或想手动补注释时，才需要执行：
--        "D:\PostgreSQL\pgsql\bin\psql.exe" -U postgres -h 127.0.0.1 -d hazard_ledger -f tools\db-comments.sql
--
--  共 51 条（表 5 张 / 字段 46 个）
-- ============================================================================

COMMENT ON TABLE hazard IS '隐患台账主表（排查发现 → 登记上报 → 整改实施 → 复查验收 → 闭环销号）';
COMMENT ON COLUMN hazard.id IS '主键ID（随机24位十六进制）';
COMMENT ON COLUMN hazard.hazard_code IS '隐患编号，格式 YH-YYYYMMDD-NNNN（按登记日期自动取号，不撞号）';
COMMENT ON COLUMN hazard.inspect_date IS '排查日期 YYYY-MM-DD';
COMMENT ON COLUMN hazard.inspector IS '排查人';
COMMENT ON COLUMN hazard.location IS '隐患部位 / 地点';
COMMENT ON COLUMN hazard.description IS '隐患描述';
COMMENT ON COLUMN hazard.category IS '隐患类别：equipment设备设施 / operation作业行为 / fire消防安全 / electrical电气安全 / environment环境安全 / management安全管理';
COMMENT ON COLUMN hazard.level IS '隐患等级：major重大 / serious较大 / general一般 / minor轻微';
COMMENT ON COLUMN hazard.rectify_measure IS '整改措施';
COMMENT ON COLUMN hazard.rectify_person IS '整改责任人';
COMMENT ON COLUMN hazard.rectify_fund IS '整改资金（单位：元）';
COMMENT ON COLUMN hazard.plan_deadline IS '计划完成日期；未闭环且已过此日期即判为「逾期」（逾期是实时计算的派生状态，不落库）';
COMMENT ON COLUMN hazard.emergency_plan IS '应急预案';
COMMENT ON COLUMN hazard.status IS '状态：pending待整改 / rectifying整改中 / closed已闭环';
COMMENT ON COLUMN hazard.actual_complete_date IS '实际完成整改的日期';
COMMENT ON COLUMN hazard.reviewer IS '复查（验收）人';
COMMENT ON COLUMN hazard.review_date IS '复查日期';
COMMENT ON COLUMN hazard.review_result IS '复查意见';
COMMENT ON COLUMN hazard.closed_at IS '闭环时间（看板「闭环耗时」= closed_at − created_at）';
COMMENT ON COLUMN hazard.created_at IS '创建（登记入库）时间';
COMMENT ON COLUMN hazard.updated_at IS '最后更新时间';
COMMENT ON COLUMN hazard.hazard_photos IS '隐患照片路径数组（JSON 字符串，元素形如 /uploads/xxx.jpg，最多6张）';
COMMENT ON COLUMN hazard.rectify_photos IS '整改照片路径数组（JSON 字符串，最多6张）';
COMMENT ON TABLE users IS '用户账号表';
COMMENT ON COLUMN users.id IS '主键ID';
COMMENT ON COLUMN users.user_id IS '登录账号（唯一）';
COMMENT ON COLUMN users.user_name IS '用户姓名（唯一，操作日志中显示的就是它）';
COMMENT ON COLUMN users.role IS '角色：entry录入人员 / reviewer复查人员 / safety_admin安全管理员 / admin系统管理员';
COMMENT ON COLUMN users.salt IS '口令盐值（随机24位十六进制）';
COMMENT ON COLUMN users.password_hash IS '口令散列值 = SHA-256(salt::明文口令)';
COMMENT ON COLUMN users.must_change_password IS '是否强制修改密码（新建用户、重置密码后为 true，首次登录须改密）';
COMMENT ON COLUMN users.created_at IS '创建时间';
COMMENT ON TABLE operation_log IS '操作日志表（所有写操作留痕，用于事后追溯「谁在何时做了什么」）';
COMMENT ON COLUMN operation_log.id IS '主键ID';
COMMENT ON COLUMN operation_log.user_id IS '操作人ID';
COMMENT ON COLUMN operation_log.user_name IS '操作人姓名';
COMMENT ON COLUMN operation_log.action IS '操作类型：login登录 / create_hazard登记 / update_hazard修改 / start_rectify开始整改 / review_hazard复查闭环 / delete_hazard删除 / create_user新增用户 / update_user_role改角色 / reset_password重置密码 / delete_user删除用户 / export_hazard导出 / cleanup_photos清理图片';
COMMENT ON COLUMN operation_log.target_type IS '操作对象类型（如 hazard 隐患 / user 用户）';
COMMENT ON COLUMN operation_log.target_id IS '操作对象ID';
COMMENT ON COLUMN operation_log.target_code IS '操作对象编号（如隐患编号 YH-YYYYMMDD-NNNN）';
COMMENT ON COLUMN operation_log.detail IS '操作详情（如「状态：待整改 → 整改中」）';
COMMENT ON COLUMN operation_log.created_at IS '操作时间';
COMMENT ON TABLE sessions IS '登录会话表（服务端令牌鉴权，令牌放于 Authorization: Bearer 请求头）';
COMMENT ON COLUMN sessions.token IS '会话令牌（主键，随机24字节十六进制）';
COMMENT ON COLUMN sessions.user_id IS '所属用户ID';
COMMENT ON COLUMN sessions.created_at IS '令牌签发时间';
COMMENT ON COLUMN sessions.expires_at IS '过期时间（默认签发后 7 天；清理此表可强制所有人重新登录）';
COMMENT ON TABLE counters IS '隐患编号计数器（按登记日期原子取号，避免并发撞号）';
COMMENT ON COLUMN counters.date_part IS '日期 YYYYMMDD';
COMMENT ON COLUMN counters.n IS '该日期已发放的编号数量（下一个编号 = n + 1）';
