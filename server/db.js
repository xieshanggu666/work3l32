import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const db = new DatabaseSync(process.env.PUBMON_DB || path.join(__dirname, 'pubmon.db'))

db.exec('PRAGMA foreign_keys = ON;')

db.exec(`
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  sentiment TEXT NOT NULL,        -- positive/neutral/negative
  sentiment_score REAL NOT NULL,  -- -1..1
  heat INTEGER NOT NULL,          -- 热度 0-100
  hot INTEGER NOT NULL DEFAULT 0,
  topic TEXT NOT NULL,
  media TEXT NOT NULL DEFAULT '',
  published TEXT NOT NULL,
  created TEXT NOT NULL,
  idem_key TEXT                   -- 条目幂等键（导入任务重试/断点续传去重，手工录入为 NULL）
);
CREATE TABLE IF NOT EXISTS hot_words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL,
  weight INTEGER NOT NULL,
  sentiment TEXT NOT NULL DEFAULT 'neutral'
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  level TEXT NOT NULL,            -- red/orange/yellow
  keyword TEXT NOT NULL DEFAULT '',
  sentiment TEXT NOT NULL DEFAULT '',
  heat_min INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created TEXT NOT NULL,
  trigger_count INTEGER NOT NULL DEFAULT 0,
  merge_topic TEXT NOT NULL DEFAULT '',   -- 危机归并话题（空=以命中舆情的话题为准）
  merge_window INTEGER NOT NULL DEFAULT 0 -- 归并时间窗口（分钟，0=不限时长）
);
CREATE TABLE IF NOT EXISTS alert_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER NOT NULL,
  post_id INTEGER,
  crisis_id INTEGER,              -- 关联危机事件（高等级预警自动建档/并入）
  detail TEXT NOT NULL,
  time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',  -- open/resolved（预警是否解除）
  resolved TEXT,                -- 解除时间
  resolve_kind TEXT NOT NULL DEFAULT '' -- 解除途径：manual/batch/close/notify（空=历史数据）
);
CREATE TABLE IF NOT EXISTS crisis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  level TEXT NOT NULL,
  status TEXT NOT NULL,           -- monitoring/disposal/closed
  plan TEXT NOT NULL DEFAULT '',
  analysis TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  linked_email TEXT NOT NULL DEFAULT '',
  keyword TEXT NOT NULL DEFAULT '',
  alert_id INTEGER,               -- 来源预警规则（自动建档时写入）
  origin TEXT NOT NULL DEFAULT 'manual',  -- auto/manual
  topic TEXT NOT NULL DEFAULT '',  -- 归并话题键（同一话题+窗口内的预警触发并入同一事件）
  last_trigger_at INTEGER          -- 最近预警触发毫秒时间戳（时间窗口归并判断依据）
);
CREATE TABLE IF NOT EXISTS crisis_alerts (
  crisis_id INTEGER NOT NULL,
  alert_id INTEGER NOT NULL,       -- 同一事件可承接多条规则（多对多）
  is_origin INTEGER NOT NULL DEFAULT 0,  -- 1=触发建档的来源规则
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  PRIMARY KEY (crisis_id, alert_id)
);
CREATE TABLE IF NOT EXISTS crisis_timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crisis_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  time TEXT NOT NULL,
  ref_type TEXT NOT NULL DEFAULT '',  -- 链路锚点：workorder/notify（空=普通处置记录）
  ref_id INTEGER                       -- 锚点对象 id（工单 id 等，看板/复盘可跳转）
);
-- 结案档案：每次结案一行，记录统一守卫快照与联动中止/解除清单，支撑结案回滚精确恢复
CREATE TABLE IF NOT EXISTS crisis_closures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crisis_id INTEGER NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  resolved_events TEXT NOT NULL DEFAULT '[]',  -- 结案联动解除的 alert_event id 列表（JSON）
  cancelled_tasks TEXT NOT NULL DEFAULT '[]',  -- 结案联动中止的通知任务快照（JSON，含状态/回执倒计时，回滚精确恢复）
  guard_snapshot TEXT NOT NULL DEFAULT '{}',   -- 结案时统一守卫快照（各项计数/报告版本，回溯与历史档案同源展示）
  prev_status TEXT NOT NULL DEFAULT 'disposal', -- 结案前状态（回滚恢复目标）
  closed_at TEXT NOT NULL,
  rolled_back INTEGER NOT NULL DEFAULT 0,
  rolled_back_at TEXT,
  rollback_note TEXT NOT NULL DEFAULT ''
);
-- 通知渠道配置：webhook/邮件/短信/站内信，target 为推送地址（演示用模拟发送）
CREATE TABLE IF NOT EXISTS notify_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'webhook', -- webhook/email/sms/inapp
  target TEXT NOT NULL DEFAULT '',      -- 推送地址/邮箱/号码
  enabled INTEGER NOT NULL DEFAULT 1,
  created TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT ''
);
-- 订阅编排：按预警规则/话题/危机状态匹配，多渠道并行推送，可要求回执并配置超时升级
CREATE TABLE IF NOT EXISTS notify_subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  alert_id INTEGER,                     -- 限定预警规则（NULL=不限）
  topic TEXT NOT NULL DEFAULT '',       -- 限定话题（空=不限）
  crisis_status TEXT NOT NULL DEFAULT '', -- 订阅危机状态流转（空=预警订阅；monitoring/disposal/closed）
  levels TEXT NOT NULL DEFAULT '',      -- 限定预警级别（空=不限；逗号分隔 red,orange,yellow）
  channel_ids TEXT NOT NULL DEFAULT '[]', -- 通知渠道 id 列表（JSON 数组）
  require_ack INTEGER NOT NULL DEFAULT 0, -- 是否需要确认回执
  ack_timeout_min INTEGER NOT NULL DEFAULT 30, -- 回执超时（分钟），超时未确认自动升级
  escalate_channel_id INTEGER,          -- 升级渠道（空=沿用原渠道）
  max_retry INTEGER NOT NULL DEFAULT 3, -- 发送失败自动重试上限
  active INTEGER NOT NULL DEFAULT 1,
  created TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT ''
);
-- 通知任务：由订阅匹配生成（幂等键去重），状态机驱动发送/重试/暂停/回执/升级
CREATE TABLE IF NOT EXISTS notify_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idem_key TEXT NOT NULL UNIQUE,        -- 幂等键：同一来源事件×订阅×渠道只生成一次
  sub_id INTEGER,
  channel_id INTEGER NOT NULL,
  alert_event_id INTEGER,               -- 来源预警触发（回执同步解除用）
  crisis_id INTEGER,                    -- 来源危机事件（回执/升级写时间线）
  kind TEXT NOT NULL DEFAULT 'alert',   -- alert/crisis/workorder/prop
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- pending/sent/failed/acked/escalated/paused/cancelled
  corr_id TEXT NOT NULL DEFAULT '',    -- 调度链路关联键：同一次分派/升级/改派的多渠道任务共享（跨重试/升级串联）
  seq INTEGER NOT NULL DEFAULT 0,      -- 关联键内序号：改派/逐级升级递增（同渠道幂等仍以 idem_key 为准）
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_retry_at INTEGER,                -- 下次自动重试毫秒时间戳（NULL=立即）
  require_ack INTEGER NOT NULL DEFAULT 0,
  ack_by TEXT NOT NULL DEFAULT '',
  ack_at TEXT,
  ack_note TEXT NOT NULL DEFAULT '',
  escalate_at INTEGER,                  -- 回执超时升级毫秒时间戳
  escalated INTEGER NOT NULL DEFAULT 0,
  escalated_from INTEGER,               -- 升级来源任务（升级任务不再二次升级）
  pause_prev TEXT NOT NULL DEFAULT '',  -- 暂停前状态（恢复语义记录）
  last_error TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notify_tasks_due ON notify_tasks (status, next_retry_at);
-- 通知历史追踪：生成/发送/重试/暂停/恢复/回执/升级/取消全程留痕（含操作人）
CREATE TABLE IF NOT EXISTS notify_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  action TEXT NOT NULL,                 -- created/sent/retry/failed/paused/resumed/acked/escalated/cancelled
  detail TEXT NOT NULL DEFAULT '',
  operator TEXT NOT NULL DEFAULT '系统',
  time TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notify_logs_task ON notify_logs (task_id, id);
-- 可恢复批量导入：任务主表（幂等标识、状态机、进度、结果汇总）
CREATE TABLE IF NOT EXISTS import_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idem_key TEXT NOT NULL UNIQUE,  -- 任务幂等键：同键重复提交直接返回原任务
  total INTEGER NOT NULL DEFAULT 0,
  total_ok INTEGER NOT NULL DEFAULT 0,
  total_failed INTEGER NOT NULL DEFAULT 0,
  total_duplicate INTEGER NOT NULL DEFAULT 0,
  alerts_fired INTEGER NOT NULL DEFAULT 0,
  crises_created INTEGER NOT NULL DEFAULT 0,
  crises_merged INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending/running/paused/done/failed（failed=跑完仍有失败条目）
  attempts INTEGER NOT NULL DEFAULT 0,    -- 任务级执行轮次（用于中断/失败后恢复）
  last_error TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  finished TEXT
);
-- 逐条记录：状态与结果用于进度展示、失败重试、结果回写
CREATE TABLE IF NOT EXISTS import_job_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,           -- 批内序号（从 0 开始）
  idem_key TEXT NOT NULL,         -- 条目幂等键（去重在 posts 唯一索引上判定；不同任务可有同名键）
  payload TEXT NOT NULL,          -- 原始录入 JSON
  status TEXT NOT NULL DEFAULT 'pending', -- pending/success/failed/duplicate
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL DEFAULT '',        -- 成功结果 JSON（含触发预警）
  error TEXT NOT NULL DEFAULT '',
  post_id INTEGER,
  UNIQUE (job_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_import_job_items_job ON import_job_items (job_id, status);
CREATE INDEX IF NOT EXISTS idx_import_job_items_key ON import_job_items (idem_key);
-- 数据源连接：管理员配置的多源接入（类型/地址/入库渠道/调度与重试策略），游标与运行态落库
CREATE TABLE IF NOT EXISTS collect_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'api',      -- api/rss/crawler
  endpoint TEXT NOT NULL DEFAULT '',     -- 连接地址（演示用 mock://；含 flaky 首发失败、always-fail 持续失败）
  source_id INTEGER NOT NULL DEFAULT 1,  -- 入库渠道（posts.source_id）
  topic TEXT NOT NULL DEFAULT '',        -- 默认话题（空=取条目自带话题）
  media TEXT NOT NULL DEFAULT '',        -- 默认来源媒体
  interval_sec INTEGER NOT NULL DEFAULT 15, -- 采集间隔（秒）
  batch_size INTEGER NOT NULL DEFAULT 5,    -- 单次抓取条数
  max_retry INTEGER NOT NULL DEFAULT 5,     -- 连续失败上限（达到后任务自动停止）
  enabled INTEGER NOT NULL DEFAULT 1,    -- 连接启停（管理员）
  running INTEGER NOT NULL DEFAULT 0,    -- 采集任务启停（值班员），重启后按游标接续
  cursor TEXT NOT NULL DEFAULT '0',      -- 采集游标（已采到的外部条目位置）
  fail_count INTEGER NOT NULL DEFAULT 0, -- 连续失败次数（退避重试依据）
  next_run_at INTEGER,                   -- 下次调度毫秒时间戳（NULL=立即）
  last_run_at TEXT,
  last_status TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  total_runs INTEGER NOT NULL DEFAULT 0,
  total_fetched INTEGER NOT NULL DEFAULT 0,
  total_inserted INTEGER NOT NULL DEFAULT 0,
  total_duplicated INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_collect_sources_due ON collect_sources (running, next_run_at);
-- 采集运行记录：每次调度/手动采集一行（抓取/入库/去重/闭环结果与游标推进留痕）
CREATE TABLE IF NOT EXISTS collect_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  status TEXT NOT NULL,               -- success/failed
  fetched INTEGER NOT NULL DEFAULT 0, -- 抓取条数
  inserted INTEGER NOT NULL DEFAULT 0,-- 新增入库
  duplicated INTEGER NOT NULL DEFAULT 0, -- 幂等去重跳过
  alerts INTEGER NOT NULL DEFAULT 0,  -- 触发预警次数
  crises INTEGER NOT NULL DEFAULT 0,  -- 自动建档危机数
  cursor_from TEXT NOT NULL DEFAULT '',
  cursor_to TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  operator TEXT NOT NULL DEFAULT '调度器', -- 调度器/手动触发人
  started TEXT NOT NULL,
  finished TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_collect_runs_source ON collect_runs (source_id, id);
-- 跨角色协同工单：从危机拆分，支持指派/认领、状态流转、阻塞挂起、超时升级、回退与结果回写
CREATE TABLE IF NOT EXISTS work_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crisis_id INTEGER NOT NULL,          -- 所属危机事件
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'other', -- pr/legal/ops/support/other（公关/法务/运营/客服/其他）
  priority TEXT NOT NULL DEFAULT 'normal', -- urgent/high/normal
  status TEXT NOT NULL DEFAULT 'todo',    -- todo/doing/blocked/done/cancelled
  assignee TEXT NOT NULL DEFAULT '',      -- 处理人（空=待分派）
  assignee_role TEXT NOT NULL DEFAULT '', -- 处理人角色（跨角色协同：pr/legal/ops/support/admin）
  dispatch_seq INTEGER NOT NULL DEFAULT 0,-- 调度链路序号：每次分派/改派 +1（与 notify_tasks.corr_id/seq 串联）
  dispatch_state TEXT NOT NULL DEFAULT '',-- 通知链路状态：none 未触发 / dispatching 发送中 / partial 部分送达 / delivered 全部送达 / acked 全部回执 / stalled 存在失败
  created_by TEXT NOT NULL DEFAULT '',
  due_at INTEGER,                         -- SLA 截止毫秒时间戳（NULL=无时限）
  escalated INTEGER NOT NULL DEFAULT 0,   -- 超时升级级别：0 未升级 / 1 超时提醒 / 2 升级督办
  last_remind_at INTEGER,                 -- 最近一次升级动作时间（两级升级间隔防抖）
  blocked_reason TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '',        -- 处理结果（完成时回写危机时间线）
  resolve_alerts INTEGER NOT NULL DEFAULT 0, -- 完成时是否联动解除该危机下未解除预警
  sla_budget_ms INTEGER,                  -- SLA 总时长（毫秒），阻塞恢复后据此重算截止
  paused_at INTEGER,                      -- 阻塞挂起时刻（毫秒），NULL=计时中
  started_at TEXT,
  done_at TEXT,
  cancelled_at TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_orders_crisis ON work_orders (crisis_id, status);
CREATE INDEX IF NOT EXISTS idx_work_orders_due ON work_orders (status, escalated, due_at);
-- 工单全程留痕：拆分/分派/认领/流转/阻塞/恢复/超时升级/回退/完成/取消（含操作人，支持跨角色审计）
CREATE TABLE IF NOT EXISTS work_order_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wo_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  operator TEXT NOT NULL DEFAULT '系统',
  operator_role TEXT NOT NULL DEFAULT '',
  time TEXT NOT NULL,
  notify_task_id INTEGER,             -- 非空=通知调度链路镜像动作（关联的通知任务）
  wo_event TEXT NOT NULL DEFAULT ''   -- 链路事件名：created/assigned/reassign/claim/escalate1/escalate2/notify_*
);
CREATE INDEX IF NOT EXISTS idx_work_order_logs_wo ON work_order_logs (wo_id, id);
CREATE INDEX IF NOT EXISTS idx_work_order_logs_task ON work_order_logs (notify_task_id);
-- ===== 舆情传播路径分析 =====
-- 传播路径：沉淀一个话题的来源、节点、转发关系与影响阶段（seed/ferment/outbreak/decline）
CREATE TABLE IF NOT EXISTS prop_paths (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,                  -- 路径标题（一般为话题名）
  topic TEXT NOT NULL DEFAULT '',       -- 归并话题键（与 posts.topic / crisis.topic 同口径）
  status TEXT NOT NULL DEFAULT 'active', -- active/archived（停用后不再随转发变化推进/通知）
  stage TEXT NOT NULL DEFAULT 'seed',   -- seed 潜伏期 / ferment 发酵期 / outbreak 爆发期 / decline 回落期
  origin_post_id INTEGER,               -- 首条来源舆情（posts.id，可空）
  crisis_id INTEGER,                    -- 关联危机事件（可空，手动关联或按话题自动关联）
  alert_id INTEGER,                     -- 来源预警规则（由预警触发建档时写入）
  auto_wo INTEGER NOT NULL DEFAULT 1,   -- 进入爆发期且关联危机时是否自动生成跨角色处置工单
  peak_heat INTEGER NOT NULL DEFAULT 0, -- 历史峰值热度（回落判定依据）
  outbreak_at INTEGER,                  -- 本轮进入爆发期毫秒时间戳（每次爆发一轮）
  last_outbreak_wo_at INTEGER,          -- 本轮爆发自动工单毫秒时间戳（每轮爆发至多一张自动工单）
  first_at TEXT NOT NULL,
  updated TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prop_paths_topic ON prop_paths (topic);
-- 传播节点：首发来源（root）、传播账号/媒体（node）、转发者；KOL 标记头部账号
CREATE TABLE IF NOT EXISTS prop_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path_id INTEGER NOT NULL,
  node_key TEXT NOT NULL,               -- 路径内唯一键（同名节点幂等）
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'node',    -- root 首发来源 / media 媒体 / kol 头部账号 / node 普通节点
  channel TEXT NOT NULL DEFAULT '',     -- 所在渠道（微博/微信/新闻…）
  followers INTEGER NOT NULL DEFAULT 0, -- 粉丝量（KOL/影响力判定参考）
  first_seen TEXT NOT NULL,
  UNIQUE (path_id, node_key)
);
CREATE INDEX IF NOT EXISTS idx_prop_nodes_path ON prop_nodes (path_id, id);
-- 转发/引用关系：from_node → to_node（to 转发/引用 from），沉淀传播边与触达
CREATE TABLE IF NOT EXISTS prop_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path_id INTEGER NOT NULL,
  from_node_id INTEGER,                 -- 被转发的上游节点（NULL=直接首发/原创）
  to_node_id INTEGER NOT NULL,
  post_id INTEGER,                      -- 对应舆情（posts.id，可空）
  reposts INTEGER NOT NULL DEFAULT 0,   -- 该跳转发量
  comments INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  reach INTEGER NOT NULL DEFAULT 0,     -- 该跳触达人次
  heat INTEGER NOT NULL DEFAULT 0,      -- 该跳上报热度（0=由互动量推算）
  note TEXT NOT NULL DEFAULT '',
  idem_key TEXT NOT NULL,               -- 转发关系幂等键（同分钟同边重复上报去重）
  time TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prop_edges_path ON prop_edges (path_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prop_edges_idem ON prop_edges (idem_key);
-- 路径 ↔ 预警规则（多对多）：一条路径可被多条规则命中，关联预警触发随路径留痕
CREATE TABLE IF NOT EXISTS prop_path_alerts (
  path_id INTEGER NOT NULL,
  alert_id INTEGER NOT NULL,
  is_origin INTEGER NOT NULL DEFAULT 0, -- 1=触发建档的来源规则
  first_at TEXT NOT NULL,
  PRIMARY KEY (path_id, alert_id)
);
-- 传播变化留痕：阶段推进/节点加入/转发记录/关联与工单动作全程可溯
CREATE TABLE IF NOT EXISTS prop_change_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path_id INTEGER NOT NULL,
  action TEXT NOT NULL,                 -- 建档/转发/阶段推进/关联预警/关联危机/回落/自动工单/编辑/删除
  detail TEXT NOT NULL DEFAULT '',
  operator TEXT NOT NULL DEFAULT '系统',
  time TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prop_logs_path ON prop_change_logs (path_id, id);
-- ===== 危机复盘报告 =====
-- 报告主表：跨角色分段编制（各章节记录最后编辑人），状态机驱动编制/审核/发布；聚合数据以快照冻结
CREATE TABLE IF NOT EXISTS crisis_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crisis_id INTEGER NOT NULL,               -- 所属危机事件
  title TEXT NOT NULL,                      -- 报告标题
  status TEXT NOT NULL DEFAULT 'draft',     -- draft 编制中 / reviewing 待审核 / published 已发布
  -- 编制章节（跨角色分段协同：每段记录最后编辑人与编辑时间，见 *_by/*_at）
  overview TEXT NOT NULL DEFAULT '',        -- 事件概述
  root_cause TEXT NOT NULL DEFAULT '',      -- 原因分析
  timeline_summary TEXT NOT NULL DEFAULT '',-- 处置时间线复盘
  response_eval TEXT NOT NULL DEFAULT '',   -- 响应与传播评估
  lessons TEXT NOT NULL DEFAULT '',         -- 经验教训与改进措施
  appendix TEXT NOT NULL DEFAULT '',        -- 附录与备注
  overview_by TEXT NOT NULL DEFAULT '', overview_at TEXT,
  root_cause_by TEXT NOT NULL DEFAULT '', root_cause_at TEXT,
  timeline_summary_by TEXT NOT NULL DEFAULT '', timeline_summary_at TEXT,
  response_eval_by TEXT NOT NULL DEFAULT '', response_eval_at TEXT,
  lessons_by TEXT NOT NULL DEFAULT '', lessons_at TEXT,
  appendix_by TEXT NOT NULL DEFAULT '', appendix_at TEXT,
  -- 聚合快照：汇总预警/时间线/传播路径/工单/通知回执（提交/发布/手动刷新时冻结），JSON 结构见 reports.js
  snapshot TEXT NOT NULL DEFAULT '{}',
  snapshotted_at TEXT,
  current_version INTEGER NOT NULL DEFAULT 0, -- 当前内容对应的版本号（归档版本计数）
  published_version INTEGER NOT NULL DEFAULT 0, -- 已发布版本号（0=尚未发布）
  created_by TEXT NOT NULL DEFAULT '',
  submitted_by TEXT NOT NULL DEFAULT '',
  submitted_at TEXT,
  reviewed_by TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT,
  published_at TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crisis_reports_crisis ON crisis_reports (crisis_id, id);
CREATE INDEX IF NOT EXISTS idx_crisis_reports_status ON crisis_reports (status);
-- 版本归档：提交审核/发布/回滚均生成不可变快照行，支撑版本对比与回滚
CREATE TABLE IF NOT EXISTS crisis_report_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  version INTEGER NOT NULL,                 -- 报告内版本序号（从 1 递增）
  kind TEXT NOT NULL DEFAULT 'submit',      -- submit 送审归档 / publish 发布归档 / rollback 回滚归档
  status TEXT NOT NULL DEFAULT 'draft',     -- 归档时报告状态
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '{}',       -- 章节内容 JSON 快照
  snapshot TEXT NOT NULL DEFAULT '{}',      -- 聚合数据 JSON 快照
  operator TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  source_version INTEGER NOT NULL DEFAULT 0, -- 回滚归档时的来源版本号
  created TEXT NOT NULL,
  UNIQUE (report_id, version)
);
CREATE INDEX IF NOT EXISTS idx_report_versions_report ON crisis_report_versions (report_id, version);
-- 报告操作留痕：编制/提交/审核通过/驳回/发布/回滚/刷新快照全程可溯（含操作人与职能角色）
CREATE TABLE IF NOT EXISTS crisis_report_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL,
  action TEXT NOT NULL,                      -- create/edit/submit/approve/reject/publish/rollback/snapshot
  detail TEXT NOT NULL DEFAULT '',
  operator TEXT NOT NULL DEFAULT '系统',
  operator_role TEXT NOT NULL DEFAULT '',
  time TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_logs_report ON crisis_report_logs (report_id, id);
-- ===== 危机声明（公关起草 → 法务审核 → 分渠道发布执行与结果登记） =====
-- 声明主表：状态机 draft 起草中 → review 待法务审核 → approved 审核通过 → publishing 发布中
--   → published 发布完成（无失败渠道）/ partial 部分渠道失败（发布未完成，阻塞结案，可重试或放弃失败渠道）
-- （驳回退回 draft；draft/approved/publishing/partial 可取消为 cancelled；全部渠道取消亦为 cancelled），发布进度回写处置工单与危机统一时间线
CREATE TABLE IF NOT EXISTS crisis_statements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crisis_id INTEGER NOT NULL,              -- 所属危机事件
  work_order_id INTEGER,                   -- 关联处置工单（起草/审核/发布进度同步回写工单日志）
  title TEXT NOT NULL,                     -- 声明标题
  content TEXT NOT NULL DEFAULT '',        -- 声明正文（公关起草，驳回后可修改重新送审）
  channels TEXT NOT NULL DEFAULT '[]',     -- 拟发布渠道 key 列表 JSON（weibo/wechat/website/news/video/press）
  priority TEXT NOT NULL DEFAULT 'high',   -- urgent/high/normal
  status TEXT NOT NULL DEFAULT 'draft',    -- draft/review/approved/publishing/partial/published/cancelled
  drafted_by TEXT NOT NULL DEFAULT '',
  drafted_at TEXT,
  submitted_by TEXT NOT NULL DEFAULT '',
  submitted_at TEXT,
  reviewed_by TEXT NOT NULL DEFAULT '',    -- 法务审核人
  reviewed_at TEXT,
  review_note TEXT NOT NULL DEFAULT '',    -- 审核意见 / 驳回原因（重新送审后留痕于日志）
  publish_by TEXT NOT NULL DEFAULT '',     -- 发起分渠道发布的执行人
  publish_at TEXT,
  published_at TEXT,                       -- 全渠道执行登记完成时间
  cancel_by TEXT NOT NULL DEFAULT '',
  cancel_at TEXT,
  cancel_reason TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_statements_crisis ON crisis_statements (crisis_id, id);
CREATE INDEX IF NOT EXISTS idx_statements_status ON crisis_statements (status);
-- 分渠道发布执行与结果登记：一条声明每个渠道一行（路径内幂等），发布人员逐渠道登记执行结果
CREATE TABLE IF NOT EXISTS crisis_statement_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  statement_id INTEGER NOT NULL,
  channel TEXT NOT NULL,                   -- weibo/wechat/website/news/video/press
  channel_name TEXT NOT NULL DEFAULT '',
  assignee TEXT NOT NULL DEFAULT '',       -- 该渠道发布执行人
  status TEXT NOT NULL DEFAULT 'pending',  -- pending 待执行 / publishing 执行中 / success 已发布 / failed 失败 / cancelled 已取消
  result TEXT NOT NULL DEFAULT '',         -- 执行结果登记（发布回执/说明）
  published_url TEXT NOT NULL DEFAULT '',  -- 发布链接（成功时登记）
  fail_reason TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,     -- 执行/重试次数
  registered_by TEXT NOT NULL DEFAULT '',
  registered_at TEXT,
  published_at TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  UNIQUE (statement_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_stmt_channels_stmt ON crisis_statement_channels (statement_id, id);
-- 声明全程留痕：起草/编辑/送审/通过/驳回/发起发布/逐渠道结果/完成/取消（含操作人，支撑跨角色审计）
CREATE TABLE IF NOT EXISTS crisis_statement_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  statement_id INTEGER NOT NULL,
  action TEXT NOT NULL,                    -- create/edit/submit/approve/reject/publish/channel_start/channel_result/channel_retry/channel_cancel/done/cancel
  detail TEXT NOT NULL DEFAULT '',
  operator TEXT NOT NULL DEFAULT '系统',
  time TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stmt_logs_stmt ON crisis_statement_logs (statement_id, id);
-- ===== 外部协作反馈门户 =====
-- 外部协作方：品牌方 / 监管方 / 媒体，经口令（access_code）在门户提交证据与整改进度
CREATE TABLE IF NOT EXISTS ext_partners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                   -- 机构/账号名称
  kind TEXT NOT NULL DEFAULT 'brand',   -- brand 品牌方 / regulator 监管方 / media 媒体
  contact TEXT NOT NULL DEFAULT '',     -- 联系人
  phone TEXT NOT NULL DEFAULT '',       -- 联系电话
  email TEXT NOT NULL DEFAULT '',       -- 联系邮箱
  access_code TEXT NOT NULL UNIQUE,     -- 门户提交口令（演示用，门户身份选择器展示）
  enabled INTEGER NOT NULL DEFAULT 1,   -- 停用后不可再提交（已提交材料保留）
  created TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT ''
);
-- 外部提交主表：证据材料 / 整改进度，经内部审核（受理→采纳/驳回）后回写工单、预警状态与危机时间线
CREATE TABLE IF NOT EXISTS ext_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,            -- 门户编号 EXT-XXXX
  partner_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'brand',   -- 冗余协作方类型（品牌/监管/媒体），停用/改名后仍可溯
  crisis_id INTEGER,                    -- 关联危机事件（可空；通用线索后续可补挂）
  work_order_id INTEGER,                -- 采纳时回写的关联处置工单（可空）
  doc_type TEXT NOT NULL DEFAULT 'evidence', -- evidence 证据材料 / rectify 整改进度 / clue 线索反映
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  attachments TEXT NOT NULL DEFAULT '[]', -- 附件清单 JSON：[{name,size,type}]（演示不落文件）
  source_url TEXT NOT NULL DEFAULT '',  -- 来源链接（媒体报道链接/监管文号/品牌整改页等）
  contact_info TEXT NOT NULL DEFAULT '',-- 提交时留的联系方式
  is_urgent INTEGER NOT NULL DEFAULT 0, -- 紧急提交：提交即触发升级通知
  status TEXT NOT NULL DEFAULT 'pending', -- pending 待审核 / reviewing 受理中 / accepted 已采纳 / rejected 已驳回 / withdrawn 已撤回
  accepted_by TEXT NOT NULL DEFAULT '',
  accepted_at TEXT,
  accepted_note TEXT NOT NULL DEFAULT '', -- 采纳说明（写入危机时间线）
  resolve_alerts INTEGER NOT NULL DEFAULT 0, -- 采纳时是否联动解除该危机全部未解除预警
  resolved_alert_count INTEGER NOT NULL DEFAULT 0, -- 采纳实际联动解除的预警条数
  rejected_by TEXT NOT NULL DEFAULT '',
  rejected_at TEXT,
  reject_reason TEXT NOT NULL DEFAULT '',   -- 驳回原因（外部方可在门户查看）
  withdrawn_at TEXT,
  reviewed_by TEXT NOT NULL DEFAULT '',  -- 受理人
  reviewed_at TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ext_subs_status ON ext_submissions (status, id);
CREATE INDEX IF NOT EXISTS idx_ext_subs_crisis ON ext_submissions (crisis_id, id);
CREATE INDEX IF NOT EXISTS idx_ext_subs_partner ON ext_submissions (partner_id, id);
-- 外部提交操作留痕：提交/补充/受理/采纳/驳回/撤回/挂接危机/紧急升级（含操作人，内外协作全程可溯）
CREATE TABLE IF NOT EXISTS ext_submission_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  action TEXT NOT NULL,                 -- create/supplement/receive/accept/reject/withdraw/bind/urgent
  detail TEXT NOT NULL DEFAULT '',
  operator TEXT NOT NULL DEFAULT '系统',
  operator_side TEXT NOT NULL DEFAULT '', -- internal 内部 / external 外部 / system
  time TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ext_logs_sub ON ext_submission_logs (submission_id, id);
-- 注：posts.idem_key 索引在下方 ensureColumn 之后创建（旧库可能尚无该列，此处创建会导致启动失败）
`)

// 把 toLocaleString('zh-CN') 形如「2026/9/26 01:54:38」解析为毫秒时间戳（迁移/窗口计算用）
export function parseTimeMs(s) {
  if (s == null) return null
  if (typeof s === 'number') return s
  const m = String(s).match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/)
  if (!m) return null
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime()
  return Number.isNaN(t) ? null : t
}

// 旧库迁移：缺列则补齐（SQLite 不支持 ADD COLUMN IF NOT EXISTS）
function ensureColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
}
ensureColumn('alert_events', 'crisis_id', 'crisis_id INTEGER')
ensureColumn('alert_events', 'status', "status TEXT NOT NULL DEFAULT 'open'")
ensureColumn('alert_events', 'resolved', 'resolved TEXT')
ensureColumn('alert_events', 'resolve_kind', "resolve_kind TEXT NOT NULL DEFAULT ''")
ensureColumn('crisis', 'alert_id', 'alert_id INTEGER')
ensureColumn('crisis', 'origin', "origin TEXT NOT NULL DEFAULT 'manual'")
ensureColumn('alerts', 'merge_topic', "merge_topic TEXT NOT NULL DEFAULT ''")
ensureColumn('alerts', 'merge_window', 'merge_window INTEGER NOT NULL DEFAULT 0')
ensureColumn('crisis', 'topic', "topic TEXT NOT NULL DEFAULT ''")
ensureColumn('crisis', 'last_trigger_at', 'last_trigger_at INTEGER')
ensureColumn('posts', 'idem_key', 'idem_key TEXT')
db.exec('CREATE INDEX IF NOT EXISTS idx_posts_idem_key ON posts (idem_key) WHERE idem_key IS NOT NULL;')
// 通知任务来源扩展：工单事件（工单生成/超时升级）复用通知调度，wo_event 标识具体事件用于幂等
ensureColumn('notify_tasks', 'work_order_id', 'work_order_id INTEGER')
ensureColumn('notify_tasks', 'wo_event', "wo_event TEXT NOT NULL DEFAULT ''")
ensureColumn('notify_subs', 'wo_event', "wo_event TEXT NOT NULL DEFAULT ''")
// 老库迁移：工单 SLA 挂起计时字段
ensureColumn('work_orders', 'sla_budget_ms', 'sla_budget_ms INTEGER')
ensureColumn('work_orders', 'paused_at', 'paused_at INTEGER')
// 传播路径分析扩展：通知订阅/任务支持传播事件（prop_event：outbreak 爆发升级 / surge 热度激增 / kol KOL 加入）
ensureColumn('notify_subs', 'prop_event', "prop_event TEXT NOT NULL DEFAULT ''")
ensureColumn('notify_tasks', 'prop_path_id', 'prop_path_id INTEGER')
// 外部协作反馈门户扩展：通知订阅/任务支持门户事件（ext_event：submitted 外部提交 / escalated 紧急升级）
ensureColumn('notify_subs', 'ext_event', "ext_event TEXT NOT NULL DEFAULT ''")
ensureColumn('notify_tasks', 'ext_submission_id', 'ext_submission_id INTEGER')
// 危机声明扩展：通知订阅/任务支持声明渠道事件（stmt_event：chfail 渠道失败 / partial 部分失败·发布未完成）
ensureColumn('notify_subs', 'stmt_event', "stmt_event TEXT NOT NULL DEFAULT ''")
ensureColumn('notify_tasks', 'statement_id', 'statement_id INTEGER')
db.exec('CREATE INDEX IF NOT EXISTS idx_notify_tasks_stmt ON notify_tasks (statement_id, id);')
// 工单来源标记：传播路径爆发自动/手动生成的跨角色工单（自动工单去重与回写路径留痕用）
ensureColumn('work_orders', 'prop_path_id', 'prop_path_id INTEGER')
// 老库迁移：传播路径表爆发时间戳列（早期 TEXT 定义以建表语句为准，这里仅补缺失列）
ensureColumn('prop_paths', 'outbreak_at', 'outbreak_at INTEGER')
ensureColumn('prop_paths', 'last_outbreak_wo_at', 'last_outbreak_wo_at INTEGER')
// 复盘报告回写结案档案：已发布报告 id/版本/标题（结案档案展示统计口径同源；结案回滚时保留回写作为历史口径）
ensureColumn('crisis_closures', 'report_id', 'report_id INTEGER')
ensureColumn('crisis_closures', 'report_version', 'report_version INTEGER NOT NULL DEFAULT 0')
ensureColumn('crisis_closures', 'report_title', "report_title TEXT NOT NULL DEFAULT ''")
// 结案闭环升级：统一守卫快照 + 通知回执联动中止清单（老库补齐：历史档案为空清单/空快照，回滚仅恢复状态与预警）
ensureColumn('crisis_closures', 'cancelled_tasks', "cancelled_tasks TEXT NOT NULL DEFAULT '[]'")
ensureColumn('crisis_closures', 'guard_snapshot', "guard_snapshot TEXT NOT NULL DEFAULT '{}'")
// 危机声明关联（工单卡片展示最近一次声明回写的进度）
ensureColumn('work_orders', 'last_statement_id', 'last_statement_id INTEGER')
// ===== 协同调度链路升级：工单与通知共享可追踪状态流 =====
ensureColumn('crisis_timeline', 'ref_type', "ref_type TEXT NOT NULL DEFAULT ''")
ensureColumn('crisis_timeline', 'ref_id', 'ref_id INTEGER')
ensureColumn('notify_tasks', 'corr_id', "corr_id TEXT NOT NULL DEFAULT ''")
ensureColumn('notify_tasks', 'seq', 'seq INTEGER NOT NULL DEFAULT 0')
ensureColumn('work_orders', 'dispatch_seq', 'dispatch_seq INTEGER NOT NULL DEFAULT 0')
ensureColumn('work_orders', 'dispatch_state', "dispatch_state TEXT NOT NULL DEFAULT ''")
ensureColumn('work_order_logs', 'notify_task_id', 'notify_task_id INTEGER')
ensureColumn('work_order_logs', 'wo_event', "wo_event TEXT NOT NULL DEFAULT ''")
db.exec('CREATE INDEX IF NOT EXISTS idx_notify_tasks_corr ON notify_tasks (corr_id);')
db.exec('CREATE INDEX IF NOT EXISTS idx_notify_tasks_wo ON notify_tasks (work_order_id, id);')
db.exec('CREATE INDEX IF NOT EXISTS idx_work_order_logs_task ON work_order_logs (notify_task_id);')
db.exec('CREATE INDEX IF NOT EXISTS idx_crisis_timeline_ref ON crisis_timeline (ref_type, ref_id);')

// 历史数据回填（幂等）：为既有工单/通知任务补关联键、升级链回填与链路状态，
// 让升级前创建的演示数据在新看板/时间线/复盘快照中同样可追踪。
function migrateDispatchLinks() {
  // ① 时间线锚点：按既有文案规则回填工单类时间线的 ref 信息
  const tlRules = [
    { like: '协同工单 #%', re: /#(\d+)/ },
    { like: '工单 #%「%', re: /工单 #(\d+)/ },
    { like: '工单 #%', re: /#(\d+)/ }
  ]
  const tlRows = db.prepare("SELECT id, action, note FROM crisis_timeline WHERE ref_type='' AND (note LIKE '协同工单 #%' OR note LIKE '工单 #%')").all()
  const updRef = db.prepare('UPDATE crisis_timeline SET ref_type=?, ref_id=? WHERE id=?')
  for (const t of tlRows) {
    let m = t.note.match(/工单 #(\d+)/) || t.note.match(/协同工单 #(\d+)/) || t.note.match(/#(\d+)/)
    if (!m) continue
    const wo = db.prepare('SELECT 1 FROM work_orders WHERE id=?').get(+m[1])
    if (wo) updRef.run('workorder', +m[1], t.id)
  }
  void tlRules

  // ② 通知任务关联键：按工单与既有幂等标签重建 corr_id/seq
  const ntRows = db.prepare("SELECT id, work_order_id, wo_event, idem_key, escalated_from FROM notify_tasks WHERE work_order_id IS NOT NULL AND corr_id=''").all()
  const updNt = db.prepare('UPDATE notify_tasks SET corr_id=?, seq=? WHERE id=?')
  for (const t of ntRows) {
    const tag = String(t.idem_key || '')
    let event = 'created', seq = 0
    if (tag.includes('reassign:')) { event = 'reassign'; const m = tag.match(/reassign:\d+:(\d+)/); seq = m ? +m[1] : 1 }
    else if (tag.includes('escalate:2')) { event = 'escalate2'; seq = 2 }
    else if (tag.includes('escalate:1')) { event = 'escalate1'; seq = 1 }
    else if (t.wo_event === 'created') { event = 'created'; seq = 0 }
    else if (Number(t.wo_event) === 2) { event = 'escalate2'; seq = 2 }
    else if (Number(t.wo_event) === 1) { event = 'escalate1'; seq = 1 }
    updNt.run(`wo${t.work_order_id}:${event}`, seq, t.id)
  }
  // ③ 回执升级任务：回填工单归属（升级前任务已携带 work_order_id 的情况）
  const escRows = db.prepare("SELECT t.id, p.work_order_id FROM notify_tasks t JOIN notify_tasks p ON p.id=t.escalated_from WHERE t.work_order_id IS NULL AND p.work_order_id IS NOT NULL").all()
  const updWoRef = db.prepare('UPDATE notify_tasks SET work_order_id=?, kind=? WHERE id=?')
  for (const r of escRows) updWoRef.run(r.work_order_id, 'workorder', r.id)
  // ④ 升级任务 corr_id 对齐升级级别（无工单的预警升级任务也补统一关联键，便于通知链路追踪）
  const escNoCorr = db.prepare("SELECT t.id, t.escalated_from, p.corr_id, p.work_order_id FROM notify_tasks t JOIN notify_tasks p ON p.id=t.escalated_from WHERE t.corr_id=''").all()
  for (const t of escNoCorr) {
    const corr = t.work_order_id ? `wo${t.work_order_id}:ack_esc:${t.escalated_from}` : `task${t.escalated_from}:ack_esc`
    updNt.run(corr, 1, t.id)
  }
  // ⑤ 工单 dispatch_seq：取改派/升级任务的最大序号
  const seqRows = db.prepare(`SELECT work_order_id wo_id, MAX(seq) m FROM notify_tasks
    WHERE work_order_id IS NOT NULL GROUP BY work_order_id`).all()
  const updWoSeq = db.prepare('UPDATE work_orders SET dispatch_seq=? WHERE id=?')
  for (const r of seqRows) updWoSeq.run(Math.max(0, r.m || 0), r.wo_id)

  // ⑥ 工单日志事件名回填（按动作映射）
  const logMap = {
    created: 'created', assigned: 'assigned', claimed: 'claim', started: '', blocked: '',
    unblocked: '', done: '', rework: '', cancelled: '', escalated: 'escalate1'
  }
  const logRows = db.prepare("SELECT id, action, detail FROM work_order_logs WHERE wo_event=''").all()
  const updLogEv = db.prepare('UPDATE work_order_logs SET wo_event=? WHERE id=?')
  for (const l of logRows) {
    if (l.action === 'escalated' && String(l.detail).includes('二级')) updLogEv.run('escalate2', l.id)
    else if (logMap[l.action]) updLogEv.run(logMap[l.action], l.id)
  }
}
migrateDispatchLinks()

// 回填工单通知链路状态（依据关联通知任务当前状态聚合；新链路由 workorders.js 实时维护）
function backfillWorkOrderDispatchState() {
  const rows = db.prepare(`SELECT work_order_id wo_id,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
      SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) sent,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
      SUM(CASE WHEN status='acked' THEN 1 ELSE 0 END) acked,
      SUM(CASE WHEN status='escalated' THEN 1 ELSE 0 END) esc,
      SUM(CASE WHEN status='paused' THEN 1 ELSE 0 END) paused,
      COUNT(*) total
    FROM notify_tasks WHERE work_order_id IS NOT NULL GROUP BY work_order_id`).all()
  const upd = db.prepare("UPDATE work_orders SET dispatch_state=? WHERE id=?")
  for (const r of rows) {
    let state = 'dispatching'
    if (r.total > 0 && r.acked === r.total) state = 'acked'
    else if (r.failed > 0 && r.sent + r.acked === 0) state = 'stalled'
    else if (r.failed > 0) state = 'partial'
    else if (r.sent + r.acked === r.total) state = 'delivered'
    upd.run(state, r.wo_id)
  }
}
backfillWorkOrderDispatchState()

// 历史数据清理（幂等）：早期版本删除危机时未级联通知任务，遗留的孤儿任务会继续被调度发送（幽灵提醒）并污染统计。
// 口径与 notify.js deleteNotifyOfCrisis 一致：来源对象已删除的任务（工单链路/危机状态类/升级链孤儿）连同留痕删除；
// 来源对象保留的任务（预警/传播/外部协作类）仅解除危机引用。
function migrateOrphanNotifyTasks() {
  // 升级链来源继承回填：早期回执超时升级子任务未继承 prop_path_id/ext_submission_id，
  // 导致传播/外部协作来源丢失（危机删除、复盘统计、门户追踪口径不一致）。按父任务幂等回填一层。
  db.prepare(`UPDATE notify_tasks SET prop_path_id=(SELECT p.prop_path_id FROM notify_tasks p WHERE p.id=notify_tasks.escalated_from)
    WHERE escalated_from IS NOT NULL AND prop_path_id IS NULL
      AND EXISTS (SELECT 1 FROM notify_tasks p WHERE p.id=notify_tasks.escalated_from AND p.prop_path_id IS NOT NULL)`).run()
  db.prepare(`UPDATE notify_tasks SET ext_submission_id=(SELECT p.ext_submission_id FROM notify_tasks p WHERE p.id=notify_tasks.escalated_from)
    WHERE escalated_from IS NOT NULL AND ext_submission_id IS NULL
      AND EXISTS (SELECT 1 FROM notify_tasks p WHERE p.id=notify_tasks.escalated_from AND p.ext_submission_id IS NOT NULL)`).run()
  // 预警触发来源同样兜底（父任务挂 alert_event_id 而升级子任务未继承的历史数据）
  db.prepare(`UPDATE notify_tasks SET alert_event_id=(SELECT p.alert_event_id FROM notify_tasks p WHERE p.id=notify_tasks.escalated_from)
    WHERE escalated_from IS NOT NULL AND alert_event_id IS NULL
      AND EXISTS (SELECT 1 FROM notify_tasks p WHERE p.id=notify_tasks.escalated_from AND p.alert_event_id IS NOT NULL)`).run()
  // 危机声明来源兜底（回执超时升级子任务继承 statement_id）
  db.prepare(`UPDATE notify_tasks SET statement_id=(SELECT p.statement_id FROM notify_tasks p WHERE p.id=notify_tasks.escalated_from)
    WHERE escalated_from IS NOT NULL AND statement_id IS NULL
      AND EXISTS (SELECT 1 FROM notify_tasks p WHERE p.id=notify_tasks.escalated_from AND p.statement_id IS NOT NULL)`).run()
  const sweep = (where) => {
    const ids = db.prepare(`SELECT id FROM notify_tasks WHERE ${where}`).all().map((r) => r.id)
    if (!ids.length) return 0
    const ph = ids.map(() => '?').join(',')
    db.prepare(`DELETE FROM notify_logs WHERE task_id IN (${ph})`).run(...ids)
    return Number(db.prepare(`DELETE FROM notify_tasks WHERE id IN (${ph})`).run(...ids).changes || 0)
  }
  // ① 工单链路孤儿（工单已随危机删除）
  sweep('work_order_id IS NOT NULL AND work_order_id NOT IN (SELECT id FROM work_orders)')
  // ② 危机状态类孤儿（危机已删除）
  sweep("kind='crisis' AND crisis_id IS NOT NULL AND crisis_id NOT IN (SELECT id FROM crisis)")
  // ②b 来源悬空的传播任务（早期 deleteProp 未级联通知任务，遗留后仍会被调度发送）
  sweep("kind='prop' AND prop_path_id IS NOT NULL AND prop_path_id NOT IN (SELECT id FROM prop_paths)")
  // ②c 来源悬空的外部协作任务（外部提交被物理删除等异常历史数据）
  sweep("kind='ext' AND ext_submission_id IS NOT NULL AND ext_submission_id NOT IN (SELECT id FROM ext_submissions)")
  // ②d 来源悬空的危机声明任务（声明随危机删除后残留；含升级链后代在③循环兜底）
  sweep("kind='statement' AND statement_id IS NOT NULL AND statement_id NOT IN (SELECT id FROM crisis_statements)")
  // ③ 升级链孤儿（父任务已删除；链深 1，循环兜底历史异常数据）
  for (;;) {
    if (!sweep('escalated_from IS NOT NULL AND escalated_from NOT IN (SELECT id FROM notify_tasks)')) break
  }
  // ④ 来源对象保留的任务：解除已删除危机的引用
  db.prepare('UPDATE notify_tasks SET crisis_id=NULL WHERE crisis_id IS NOT NULL AND crisis_id NOT IN (SELECT id FROM crisis)').run()
  // ⑤ 兜底：无任务归属的留痕
  db.prepare('DELETE FROM notify_logs WHERE task_id NOT IN (SELECT id FROM notify_tasks)').run()
}
migrateOrphanNotifyTasks()

// 迁移：修复危机声明发布状态口径——旧逻辑下「全部渠道登记完成即已发布」，
// 存在失败渠道的声明也会被置为 published 并放行危机结案。按当前渠道实况统一重算：
//   · published 且仍有在途渠道（pending/publishing）→ publishing
//   · published/publishing 且全部渠道到终态、有失败渠道 → partial（发布未完成，恢复结案阻断）
//   · publishing 且全部渠道取消（无成功无失败）→ cancelled
// 同时补一条迁移留痕，便于在声明全程日志中解释状态来源。
function migrateStatementStatus() {
  const rows = db.prepare(`SELECT s.id, s.status,
      SUM(CASE WHEN sc.status IN ('pending','publishing') THEN 1 ELSE 0 END) open_n,
      SUM(CASE WHEN sc.status='success' THEN 1 ELSE 0 END) ok_n,
      SUM(CASE WHEN sc.status='failed' THEN 1 ELSE 0 END) fail_n,
      SUM(CASE WHEN sc.status='cancelled' THEN 1 ELSE 0 END) cancel_n,
      COUNT(*) total
    FROM crisis_statements s JOIN crisis_statement_channels sc ON sc.statement_id=s.id
    WHERE s.status IN ('published','publishing')
    GROUP BY s.id`).all()
  const upd = db.prepare('UPDATE crisis_statements SET status=?, published_at=NULL, updated=? WHERE id=?')
  const insLog = db.prepare('INSERT INTO crisis_statement_logs (statement_id,action,detail,operator,time) VALUES (?,?,?,?,?)')
  const ts = new Date().toLocaleString('zh-CN')
  for (const r of rows) {
    if (r.status === 'published' && r.open_n > 0) {
      upd.run('publishing', ts, r.id)
      insLog.run(r.id, 'migrate_status', `发布状态口径修复：存在 ${r.open_n} 个在途渠道，由「已发布」更正为「发布中」`, '系统', ts)
    } else if (r.open_n === 0 && r.fail_n > 0) {
      upd.run('partial', ts, r.id)
      insLog.run(r.id, 'partial', `发布状态口径修复：${r.ok_n}/${r.total} 个渠道成功、${r.fail_n} 个失败${r.cancel_n ? `、${r.cancel_n} 个取消` : ''}，由「${r.status === 'published' ? '已发布' : '发布中'}」更正为「部分渠道失败」，恢复结案阻断`, '系统', ts)
    } else if (r.status === 'publishing' && r.open_n === 0 && r.fail_n === 0 && r.ok_n === 0 && r.cancel_n === r.total) {
      upd.run('cancelled', ts, r.id)
      insLog.run(r.id, 'cancel_all', '发布状态口径修复：全部渠道已取消，由「发布中」更正为「已取消」', '系统', ts)
    }
  }
}
migrateStatementStatus()

// 迁移：早期版本 import_job_items.idem_key 为全局唯一，跨任务内容去重时同名键会冲突，
// 重建表去掉该唯一约束（保留 (job_id, seq) 唯一与普通索引）。
function migrateJobItemsKeyUnique() {
  const idxList = db.prepare("PRAGMA index_list('import_job_items')").all()
  let bad = null
  for (const ix of idxList) {
    if (!ix.unique) continue
    const cols = db.prepare(`PRAGMA index_info('${ix.name}')`).all().map((c) => c.name)
    // 仅 idem_key 单列唯一的索引是旧约束（(job_id,seq) 复合唯一保留）
    if (cols.length === 1 && cols[0] === 'idem_key') { bad = ix; break }
  }
  if (!bad) return
  const cols = db.prepare('PRAGMA table_info(import_job_items)').all().map((c) => c.name)
  if (!cols.includes('idem_key')) return
  db.exec(`
    CREATE TABLE import_job_items_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      idem_key TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      result TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      post_id INTEGER,
      UNIQUE (job_id, seq)
    );
    INSERT INTO import_job_items_new (id,job_id,seq,idem_key,payload,status,attempts,result,error,post_id)
      SELECT id,job_id,seq,idem_key,payload,status,attempts,result,error,post_id FROM import_job_items;
    DROP TABLE import_job_items;
    ALTER TABLE import_job_items_new RENAME TO import_job_items;
    CREATE INDEX IF NOT EXISTS idx_import_job_items_job ON import_job_items (job_id, status);
    CREATE INDEX IF NOT EXISTS idx_import_job_items_key ON import_job_items (idem_key);
  `)
}
migrateJobItemsKeyUnique()

// 旧关联迁移：crisis.alert_id 单规则 → crisis_alerts 多对多；回填话题与最近触发时间。
// 幂等：仅在关联表为空时执行，历史时间线（crisis_timeline）原样保留。
function migrateLegacyLinks() {
  const linked = db.prepare('SELECT COUNT(*) c FROM crisis_alerts').get().c
  if (linked > 0) return
  const crises = db.prepare('SELECT id, alert_id, topic, updated FROM crisis').all()
  const insLink = db.prepare('INSERT INTO crisis_alerts (crisis_id,alert_id,is_origin,first_at,last_at) VALUES (?,?,?,?,?)')
  for (const c of crises) {
    // 该事件关联过的全部规则（alert_events 中去重），来源规则置 is_origin=1
    const ruleIds = db.prepare('SELECT DISTINCT alert_id FROM alert_events WHERE crisis_id=?').all(c.id).map((r) => r.alert_id)
    if (c.alert_id && !ruleIds.includes(c.alert_id)) ruleIds.unshift(c.alert_id)
    let topic = c.topic
    if (!topic) {
      const ev = db.prepare(`SELECT ae.time, p.topic ptopic FROM alert_events ae
        LEFT JOIN posts p ON p.id=ae.post_id WHERE ae.crisis_id=? ORDER BY ae.id ASC LIMIT 1`).get(c.id)
      topic = (ev && ev.ptopic) || ''
    }
    let lastAt = null, lastMs = null
    const lastEv = db.prepare('SELECT time FROM alert_events WHERE crisis_id=? ORDER BY id DESC LIMIT 1').get(c.id)
    if (lastEv) { lastAt = lastEv.time; lastMs = parseTimeMs(lastEv.time) }
    if (lastMs == null) lastMs = parseTimeMs(c.updated)
    if (topic) db.prepare('UPDATE crisis SET topic=?, last_trigger_at=? WHERE id=?').run(topic, lastMs, c.id)
    else db.prepare('UPDATE crisis SET last_trigger_at=? WHERE id=?').run(lastMs, c.id)
    ruleIds.forEach((rid) => {
      const first = db.prepare('SELECT MIN(time) t FROM alert_events WHERE crisis_id=? AND alert_id=?').get(c.id, rid).t || c.updated
      const last = db.prepare('SELECT MAX(time) t FROM alert_events WHERE crisis_id=? AND alert_id=?').get(c.id, rid).t || first
      insLink.run(c.id, rid, rid === c.alert_id ? 1 : 0, first, last)
    })
  }
}
migrateLegacyLinks()

// 旧库迁移：为历史已结案事件补建结案档案（幂等：已有档案则跳过）。
// 联动解除清单无法追溯置空——此类结案回滚时仅恢复事件状态，不回滚预警。
function migrateClosures() {
  const closed = db.prepare("SELECT id, updated FROM crisis WHERE status='closed'").all()
  const hasClosure = db.prepare('SELECT 1 FROM crisis_closures WHERE crisis_id=? LIMIT 1')
  const findNote = db.prepare("SELECT note, time FROM crisis_timeline WHERE crisis_id=? AND action='事件结案' ORDER BY id DESC LIMIT 1")
  const ins = db.prepare('INSERT INTO crisis_closures (crisis_id,summary,resolved_events,prev_status,closed_at) VALUES (?,?,?,?,?)')
  for (const c of closed) {
    if (hasClosure.get(c.id)) continue
    const tl = findNote.get(c.id)
    ins.run(c.id, tl ? tl.note : '', '[]', 'disposal', tl ? tl.time : c.updated)
  }
}
migrateClosures()

function seed() {
  const n = db.prepare('SELECT COUNT(*) c FROM posts').get().c
  if (n > 0) return
  const now = new Date()
  const nowStr = now.toLocaleString('zh-CN')

  const si = db.prepare('INSERT INTO sources VALUES (?,?)')
  const sources = [['微博'], ['微信'], ['新闻'], ['知乎'], ['抖音'], ['论坛']]
  sources.forEach((s, i) => si.run(i + 1, s[0]))
  const srcName = (i) => sources[i - 1][0]

  // 舆情模拟数据
  const sample = [
    // [title, content, sourceIdx, sentiment, score, heat, hot, topic, media]
    ['某电商平台预售商品迟迟不发货引用户吐槽', '网友晒出多份订单截图，称下单后近两周仍未发货，客服回应迟缓，引发大量讨论。', 1, 'negative', -0.7, 82, 1, '电商物流', '新浪科技'],
    ['新上线的某支付功能被指流程繁琐', '多位用户在社交平台反映新功能需多次验证，操作成本高，官方暂无明确回应。', 3, 'negative', -0.55, 67, 1, '产品体验', '知乎热议'],
    ['某出行企业发布年度服务质量报告', '报告显示投诉率同比下降，用户满意度多项指标回升，业内普遍关注。', 4, 'positive', 0.62, 58, 0, '企业动态', '行业观察'],
    ['专家谈绿色能源转型前景', '受访专家认为短期阵痛不改长期趋势，政策利好明显，市场反应积极。', 3, 'positive', 0.7, 71, 0, '行业趋势', '第一财经'],
    ['某连锁品牌被曝门店后厨卫生隐患', '暗访视频显示多位后厨操作不规范，品牌方紧急回应称已开展全面自查并关停涉事门店。', 6, 'negative', -0.82, 90, 1, '食品安全', '澎湃新闻'],
    ['城市新推惠民政策引关注', '多地同步推出惠民补贴与便民措施，市民普遍点赞落实情况。', 2, 'positive', 0.66, 55, 0, '民生', '人民日报'],
    ['电子产品新品发布会亮点解析', '新机型在续航与影像上提升明显，网友讨论热情高涨，预约量攀升。', 5, 'positive', 0.6, 63, 0, '消费电子', '微博热搜'],
    ['某地产项目延期交付业主维权', '多位业主聚集反映工程进度缓慢，项目方表示将给出补偿方案，事件仍在发酵。', 1, 'negative', -0.74, 78, 1, '房地产', '凤凰网'],
    ['行业大模型落地案例盘点', '多家企业公布行业大模型在企业效率提升上的实测数据，外界关注商业模式可持续性。', 3, 'neutral', 0.1, 49, 0, '科技', '科技媒体'],
    ['某视频平台会员涨价引发议论', '涨价公告后大量网友讨论性价比与内容质量，情绪以中性偏负为主。', 1, 'negative', -0.4, 70, 0, '平台运营', '排行榜'],
    ['社区养老新模式获好评', '多个社区试点养老互助点，老人家属反馈积极，成为正面典型。', 2, 'positive', 0.72, 52, 0, '民生', '中新社'],
    ['某新能源汽车充电服务再引分歧', '车主反映充电桩故障率偏高、客服响应慢，品牌方回应正在扩容并优化售后。', 5, 'negative', -0.66, 74, 1, '新能源', '汽车之家'],
    ['旅游旺季景区秩序引关注', '假期多景区实行预约限流，整体秩序良好，但也有排队偏长等零星抱怨。', 6, 'neutral', -0.15, 45, 0, '文旅', '本地资讯'],
    ['某外卖平台骑手权益保障进展', '平台公布骑手社保与安全培训新举措，舆论整体肯定，细则仍需观察。', 1, 'neutral', 0.2, 50, 0, '平台运营', '澎湃新闻'],
    ['科学家团队在脑机接口研究取得进展', '相关成果经权威期刊发表，引发学界乐观讨论，也被提醒需长期验证。', 3, 'positive', 0.68, 60, 0, '前沿科技', '科普中国']
  ]

  const pi = db.prepare('INSERT INTO posts (title,content,source_id,sentiment,sentiment_score,heat,hot,topic,media,published,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
  const base = new Date()
  sample.forEach((s, i) => {
    const pub = new Date(base.getTime() - (i * 37 + 12) * 60 * 1000).toLocaleString('zh-CN')
    pi.run(s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], pub, nowStr)
  })

  const wi = db.prepare('INSERT INTO hot_words (word,weight,sentiment) VALUES (?,?,?)')
  ;[['发货慢', 40, 'negative'], ['后厨卫生', 36, 'negative'], ['延期交付', 32, 'negative'], ['充电桩', 30, 'negative'],
    ['会员涨价', 28, 'negative'], ['服务报告', 26, 'positive'], ['惠民政策', 25, 'positive'], ['绿色能源', 24, 'positive'],
    ['新品发布', 23, 'positive'], ['养老互助', 22, 'positive'], ['脑机接口', 21, 'positive'], ['景区限流', 18, 'neutral'],
    ['骑手保障', 17, 'neutral'], ['会员', 16, 'neutral'], ['大模型', 15, 'neutral']]
    .forEach((w) => wi.run(w[0], w[1], w[2]))

  const ago = (m) => new Date(now.getTime() - m * 60000).toLocaleString('zh-CN')

  const ai = db.prepare('INSERT INTO alerts (title,level,keyword,sentiment,heat_min,active,created,trigger_count,merge_topic,merge_window) VALUES (?,?,?,?,?,?,?,?,?,?)')
  const a1 = ai.run('负面情绪集中爆发', 'red', '卫生', 'negative', 80, 1, nowStr, 1, '食品安全', 720).lastInsertRowid
  const a2 = ai.run('投诉类话题升温', 'orange', '投诉', 'negative', 65, 1, nowStr, 2, '服务投诉', 1440).lastInsertRowid
  const a3 = ai.run('选址关键词监控', 'yellow', '延期', 'negative', 60, 1, nowStr, 1, '房地产', 1440).lastInsertRowid
  ai.run('正面口碑监测', 'yellow', '服务', 'positive', 50, 1, nowStr, 1, '', 0)

  // 危机事件：c1 红色自动建档·处置中；c2 橙色自动建档·监测中（同话题去重并入）；c3 人工建档·已结案（承接两条规则）
  const ci = db.prepare('INSERT INTO crisis (title,level,status,plan,analysis,created,updated,linked_email,keyword,alert_id,origin,topic,last_trigger_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const c1 = ci.run('某连锁品牌门店卫生事件', 'red', 'disposal',
    '1. 24小时内全网回应，公布整改时间表\n2. 关停涉事门店并启动第三方复查\n3. 官方渠道连续发布整改动态\n4. 与权威媒体合作发布透明报告',
    '负面传播主阵地为短视频与微博，需在2小时内完成首次回应，重点关注转发量头部账号。',
    ago(180), ago(120), 'crisis@brand.com', '卫生', a1, 'auto', '食品安全', new Date(now.getTime() - 180 * 60000).getTime()).lastInsertRowid
  const c2 = ci.run('投诉类话题升温事件', 'orange', 'monitoring', '',
    '由橙色预警「投诉类话题升温」自动建档：命中关键词「投诉」，首条关联舆情《某电商平台预售商品迟迟不发货引用户吐槽》（热度82）。',
    ago(90), ago(30), '', '投诉', a2, 'auto', '服务投诉', new Date(now.getTime() - 30 * 60000).getTime()).lastInsertRowid
  const c3 = ci.run('某视频平台会员涨价争议', 'orange', 'closed',
    '1. 发布定价说明与会员权益升级方案\n2. 客服通道集中答疑\n3. 观察期一周，舆情回落后结案',
    '情绪以中性偏负为主，未出现大规模抵制，重点回应性价比质疑。',
    ago(4320), ago(2840), '', '涨价', null, 'manual', '会员涨价', new Date(now.getTime() - 2880 * 60000).getTime()).lastInsertRowid

  // 事件↔规则多对多：c3 为人工建档但承接了两条规则（同一事件承接多条规则）
  const cl = db.prepare('INSERT INTO crisis_alerts (crisis_id,alert_id,is_origin,first_at,last_at) VALUES (?,?,?,?,?)')
  cl.run(c1, a1, 1, ago(180), ago(180))
  cl.run(c2, a2, 1, ago(90), ago(30))
  cl.run(c3, a2, 0, ago(4310), ago(4300))
  cl.run(c3, a3, 0, ago(2880), ago(2880))

  // 预警触发记录：c1/c2 由预警自动建档，c2 第二次触发去重并入；黄色规则不自动建档
  const ae = db.prepare('INSERT INTO alert_events (alert_id,post_id,crisis_id,detail,time,status,resolved,resolve_kind) VALUES (?,?,?,?,?,?,?,?)')
  ae.run(a1, 5, c1, '命中关键词「卫生」· 情感：negative · 热度90', ago(180), 'open', null, '')
  ae.run(a2, 1, c2, '命中关键词「投诉」· 情感：negative · 热度82', ago(90), 'open', null, '')
  ae.run(a2, 12, c2, '命中关键词「投诉」· 情感：negative · 热度74', ago(30), 'open', null, '')
  ae.run(a3, 8, null, '命中关键词「延期」· 情感：negative · 热度78', ago(60), 'open', null, '')
  // c3 人工建档但处置期承接了 a2/a3 两条规则，结案前已逐条手动解除（历史闭环）
  ae.run(a2, 11, c3, '命中关键词「投诉」· 情感：negative · 热度70', ago(4310), 'resolved', ago(2880), 'manual')
  ae.run(a3, 11, c3, '命中关键词「延期」· 情感：negative · 热度66', ago(2880), 'resolved', ago(2880), 'manual')

  // c3 结案档案（历史结案：预警先于结案手动解除，联动解除清单为空）
  db.prepare('INSERT INTO crisis_closures (crisis_id,summary,resolved_events,prev_status,closed_at) VALUES (?,?,?,?,?)')
    .run(c3, '舆情热度回落至常态区间，负面占比降至 5% 以下，完成处置闭环。', '[]', 'disposal', ago(2840))

  const ct = db.prepare('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)')
  ;[['自动建档', '高等级预警触发：命中关键词「卫生」· 情感：negative · 热度90', ago(180)],
    ['全网回应', '官方发布回应声明', ago(150)],
    ['关停门店', '涉事门店暂停营业，启动自查', ago(120)]].forEach((t) => ct.run(c1, t[0], t[1], t[2]))
  ;[['自动建档', '高等级预警触发：命中关键词「投诉」· 情感：negative · 热度82', ago(90)],
    ['预警再次触发', '命中关键词「投诉」· 情感：negative · 热度74 · 关联舆情《某新能源汽车充电服务再引分歧》', ago(30)]].forEach((t) => ct.run(c2, t[0], t[1], t[2]))
  ;[['事件建档', '人工建档，进入监测', ago(4320)],
    ['启动处置', '发布定价说明，开通集中答疑', ago(4300)],
    ['预警解除', '风险指标回落，预警解除', ago(2880)],
    ['事件结案', '舆情热度回落至常态区间，负面占比降至 5% 以下，完成处置闭环。', ago(2840)]].forEach((t) => ct.run(c3, t[0], t[1], t[2]))
}
seed()

// 通知渠道与订阅编排种子（独立幂等：老库升级后同样补齐演示配置；任务由调度器在运行时生成）
function seedNotify() {
  const n = db.prepare('SELECT COUNT(*) c FROM notify_channels').get().c
  if (n > 0) return
  const nowStr = new Date().toLocaleString('zh-CN')
  const nc = db.prepare('INSERT INTO notify_channels (name,type,target,enabled,created,created_by) VALUES (?,?,?,1,?,?)')
  const ch1 = Number(nc.run('值班 Webhook', 'webhook', 'https://ops.internal/alert-hook', nowStr, '系统初始化').lastInsertRowid)
  const ch2 = Number(nc.run('危机邮箱组', 'email', 'mailto:crisis@brand.com', nowStr, '系统初始化').lastInsertRowid)
  const ch3 = Number(nc.run('短信网关', 'sms', 'sms://flaky-gateway', nowStr, '系统初始化').lastInsertRowid) // flaky：首次发送模拟瞬时故障，演示自动重试
  const ch4 = Number(nc.run('升级专线', 'webhook', 'https://ops.internal/escalation', nowStr, '系统初始化').lastInsertRowid)
  const ns = db.prepare('INSERT INTO notify_subs (name,alert_id,topic,crisis_status,levels,channel_ids,require_ack,ack_timeout_min,escalate_channel_id,max_retry,active,created,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)')
  // 红色预警 → Webhook + 邮箱，需回执，1 分钟超时升级至升级专线
  ns.run('红色预警全员通知', null, '', '', 'red', JSON.stringify([ch1, ch2]), 1, 1, ch4, 3, nowStr, '系统初始化')
  // 食安话题 → 邮箱 + 短信（短信通道首次发送模拟故障，演示失败重试）
  ns.run('食安话题跟踪推送', null, '食品安全', '', '', JSON.stringify([ch2, ch3]), 0, 30, null, 3, nowStr, '系统初始化')
  // 危机结案 → Webhook 通报
  ns.run('危机结案通报', null, '', 'closed', '', JSON.stringify([ch1]), 0, 30, null, 3, nowStr, '系统初始化')
  // 工单超时升级（两级）→ 升级专线，需回执（超时升级闭环演示）
  ns.run('工单超时升级督办', null, '', '', '', JSON.stringify([ch4]), 1, 1, ch4, 3, nowStr, '系统初始化')
  // 新工单分派 → 值班 Webhook（跨角色协同通知）
  ns.run('协同工单分派通知', null, '', '', '', JSON.stringify([ch1]), 0, 30, null, 3, nowStr, '系统初始化')
  // 标记工单事件订阅（wo_event：created=新工单分派/认领提醒，escalated=超时升级；普通预警订阅为空）
  db.prepare("UPDATE notify_subs SET wo_event='escalated' WHERE name='工单超时升级督办' AND wo_event=''").run()
  db.prepare("UPDATE notify_subs SET wo_event='created' WHERE name='协同工单分派通知' AND wo_event=''").run()
  // 传播路径事件订阅（prop_event）：爆发升级（需回执）、热度激增/KOL 加入
  const ps = db.prepare(`INSERT INTO notify_subs (name,alert_id,topic,crisis_status,levels,channel_ids,require_ack,ack_timeout_min,escalate_channel_id,max_retry,active,created,created_by,prop_event)
    VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)`)
  // 传播进入爆发期 → 值班 Webhook + 危机邮箱组，需回执，1 分钟超时升级至升级专线
  ps.run('传播爆发升级全员通知', null, '', '', '', JSON.stringify([ch1, ch2]), 1, 1, ch4, 3, nowStr, '系统初始化', 'outbreak')
  // 传播热度激增 / KOL 加入 → 值班 Webhook
  ps.run('传播异动（激增/KOL）提醒', null, '', '', '', JSON.stringify([ch1]), 0, 30, null, 3, nowStr, '系统初始化', 'surge')
}
seedNotify()

// 数据源连接种子（独立幂等：老库升级后同样补齐演示连接；任务默认停止，由值班员启动）
function seedCollect() {
  const n = db.prepare('SELECT COUNT(*) c FROM collect_sources').get().c
  if (n > 0) return
  const nowStr = new Date().toLocaleString('zh-CN')
  const cs = db.prepare(`INSERT INTO collect_sources (name,type,endpoint,source_id,topic,media,interval_sec,batch_size,max_retry,enabled,running,created,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,1,0,?,?)`)
  cs.run('微博热搜 API', 'api', 'mock://weibo/hot-feed', 1, '', '', 15, 5, 5, nowStr, '系统初始化')
  // flaky：首次采集模拟瞬时故障，演示失败退避自动重试
  cs.run('新闻聚合 RSS', 'rss', 'mock://news/flaky-rss', 3, '', '', 20, 4, 5, nowStr, '系统初始化')
  // always-fail：持续失败，演示退避重试到达上限后任务自动停止
  cs.run('论坛爬虫（故障演练）', 'crawler', 'mock://forum/always-fail', 6, '', '', 30, 5, 3, nowStr, '系统初始化')
}
seedCollect()

// 协同工单种子（独立幂等：老库升级后同样补齐演示工单；关联既有危机事件）
function seedWorkOrders() {
  const n = db.prepare('SELECT COUNT(*) c FROM work_orders').get().c
  if (n > 0) return
  const now = new Date()
  const c1 = db.prepare("SELECT id FROM crisis WHERE title LIKE '%门店卫生%' ORDER BY id LIMIT 1").get()
  const c2 = db.prepare("SELECT id FROM crisis WHERE title LIKE '%投诉类话题%' ORDER BY id LIMIT 1").get()
  if (!c1 || !c2) return // 老库缺少演示危机事件时跳过（不影响工单功能本身）
  const ago = (m) => new Date(now.getTime() - m * 60000).toLocaleString('zh-CN')
  const wo = db.prepare(`INSERT INTO work_orders
    (crisis_id,title,detail,category,priority,status,assignee,assignee_role,created_by,due_at,escalated,started_at,created,updated)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const wl = db.prepare('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)')
  // 公关口径单（处理中，SLA 1 分钟，便于观察超时升级两级流转）
  const w1 = Number(wo.run(c1.id, '统一对外回应口径', '梳理事件时间线，2 小时内发布首份官方声明并同步媒体口径。',
    'pr', 'urgent', 'doing', '李澈', 'ops', '张岚', now.getTime() + 60000, 0, ago(60), ago(70), ago(20)).lastInsertRowid)
  wl.run(w1, 'created', '从危机事件拆分协同工单（紧急 · 公关口径）', '张岚', 'admin', ago(70))
  wl.run(w1, 'assigned', '指派给 李澈（值班员），SLA 1 分钟', '张岚', 'admin', ago(70))
  wl.run(w1, 'started', '领取并开始处理', '李澈', 'ops', ago(60))
  // 法务取证单（已阻塞，等待第三方材料，SLA 挂起）
  const w2 = Number(wo.run(c1.id, '固定证据与合规评估', '固定暗访视频原始来源，评估涉事门店合规责任，待第三方检测机构出具材料。',
    'legal', 'high', 'blocked', '陈律', 'legal', '张岚', null, 0, ago(50), ago(100), ago(15)).lastInsertRowid)
  db.prepare('UPDATE work_orders SET blocked_reason=? WHERE id=?').run('等待第三方检测机构材料（预计 1 个工作日）', w2)
  wl.run(w2, 'created', '从危机事件拆分协同工单（高优 · 法务取证）', '张岚', 'admin', ago(100))
  wl.run(w2, 'assigned', '指派给 陈律（法务）', '张岚', 'admin', ago(100))
  wl.run(w2, 'started', '领取并开始处理', '陈律', 'legal', ago(50))
  wl.run(w2, 'blocked', '阻塞：等待第三方检测机构材料（预计 1 个工作日），SLA 挂起', '陈律', 'legal', ago(15))
  // 客诉跟进单（待分派，SLA 30 分钟）
  const w3 = Number(wo.run(c2.id, '集中客诉工单回访', '对近 24 小时投诉类客诉逐一回访，退款进度同步客服台账。',
    'support', 'high', 'todo', '', '', '张岚', now.getTime() + 30 * 60000, 0, null, ago(25), ago(25)).lastInsertRowid)
  wl.run(w3, 'created', '从危机事件拆分协同工单（高优 · 客服回访），待分派', '张岚', 'admin', ago(25))
  // 已完成单（演示结果回写时间线的历史工单）
  const w4 = Number(wo.run(c1.id, '关停涉事门店现场核查', '涉事门店暂停营业，完成现场卫生核查并拍照留档。',
    'ops', 'urgent', 'done', '李澈', 'ops', '张岚', null, 0, ago(120), ago(125), ago(118)).lastInsertRowid)
  db.prepare('UPDATE work_orders SET done_at=?,result=? WHERE id=?')
    .run(ago(118), '涉事门店已关停，现场核查完成，整改清单已下发并要求 24 小时内反馈。', w4)
  wl.run(w4, 'created', '从危机事件拆分协同工单（紧急 · 现场核查）', '张岚', 'admin', ago(125))
  wl.run(w4, 'assigned', '指派给 李澈（值班员）', '张岚', 'admin', ago(125))
  wl.run(w4, 'started', '领取并开始处理', '李澈', 'ops', ago(120))
  wl.run(w4, 'done', '完成：涉事门店已关停，现场核查完成，整改清单已下发并要求 24 小时内反馈。', '李澈', 'ops', ago(118))
  if (c1) db.prepare('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)')
    .run(c1.id, '工单完成', `协同工单「关停涉事门店现场核查」已由 李澈 完成：涉事门店已关停，现场核查完成，整改清单已下发并要求 24 小时内反馈。`, ago(118))
}
seedWorkOrders()

// 传播路径分析种子（独立幂等：老库升级后同样补齐演示路径；来源/节点/转发关系/影响阶段完整沉淀）
function seedProp() {
  const n = db.prepare('SELECT COUNT(*) c FROM prop_paths').get().c
  if (n > 0) return
  const now = new Date()
  const ago = (m) => new Date(now.getTime() - m * 60000).toLocaleString('zh-CN')
  const agoMs = (m) => now.getTime() - m * 60000
  const c1 = db.prepare("SELECT id FROM crisis WHERE title LIKE '%门店卫生%' ORDER BY id LIMIT 1").get()
  const c2 = db.prepare("SELECT id FROM crisis WHERE title LIKE '%投诉类话题%' ORDER BY id LIMIT 1").get()
  const a1 = db.prepare("SELECT id FROM alerts WHERE title='负面情绪集中爆发'").get()
  const a2 = db.prepare("SELECT id FROM alerts WHERE title='投诉类话题升温'").get()
  const a3 = db.prepare("SELECT id FROM alerts WHERE title='选址关键词监控'").get()
  if (!c1 || !c2 || !a1 || !a2 || !a3) return

  const pi = db.prepare(`INSERT INTO prop_paths
    (title,topic,status,stage,origin_post_id,crisis_id,alert_id,auto_wo,peak_heat,outbreak_at,last_outbreak_wo_at,first_at,updated,created)
    VALUES (?,?, 'active',?, ?,?,?,?,?,?,?,?,?,?)`)
  // P1 食安事件：已进入爆发期，关联红色危机 c1，爆发时自动生成过处置工单（已完成）
  const p1 = Number(pi.run('某连锁品牌后厨卫生事件传播链', '食品安全', 'outbreak', 5, c1.id, a1.id, 1, 95,
    agoMs(70), agoMs(40), ago(170), ago(40), ago(170)).lastInsertRowid)
  // P2 服务投诉：发酵期，关联橙色危机 c2（再记录 KOL/高热度转发即跨入爆发期，触发通知与自动工单）
  const p2 = Number(pi.run('电商预售不发货投诉扩散链', '服务投诉', 'ferment', 1, c2.id, a2.id, 1, 58,
    null, null, ago(85), ago(20), ago(85)).lastInsertRowid)
  // P3 地产维权：潜伏期，仅来源 + 单个节点，关联黄色预警（无危机）
  const p3 = Number(pi.run('某楼盘延期交付维权舆情', '房地产', 'seed', 8, null, a3.id, 1, 38,
    null, null, ago(60), ago(40), ago(60)).lastInsertRowid)

  const ni = db.prepare('INSERT INTO prop_nodes (path_id,node_key,name,kind,channel,followers,first_seen) VALUES (?,?,?,?,?,?,?)')
  const node = (pathId, key, name, kind, channel, followers, t) =>
    Number(ni.run(pathId, key, name, kind, channel, followers, t).lastInsertRowid)
  const ei = db.prepare(`INSERT INTO prop_edges
    (path_id,from_node_id,to_node_id,post_id,reposts,comments,likes,reach,heat,note,idem_key,time)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  const li = db.prepare('INSERT INTO prop_change_logs (path_id,action,detail,operator,time) VALUES (?,?,?,?,?)')
  const ai = db.prepare('INSERT INTO prop_path_alerts (path_id,alert_id,is_origin,first_at) VALUES (?,?,1,?)')

  // ---- P1 传播链：澎湃首发 → 美食打假王(KOL) → 微博热搜君(KOL)，媒体/问答节点跟进 ----
  const root1 = node(p1, '澎湃新闻', '澎湃新闻', 'root', '新闻', 0, ago(170))
  const kol1 = node(p1, '美食打假王', '美食打假王', 'kol', '微博', 8600000, ago(120))
  const kol2 = node(p1, '微博热搜君', '微博热搜君', 'kol', '微博', 23000000, ago(70))
  const med1 = node(p1, '抖音热点速报', '抖音热点速报', 'media', '抖音', 5100000, ago(60))
  const nd1 = node(p1, '食安观察答主', '食安观察答主', 'node', '知乎', 180000, ago(45))
  ei.run(p1, null, root1, 5, 320, 180, 900, 120000, 62, '暗访视频经媒体首发', `seed:p1:e1`, ago(170))
  ei.run(p1, root1, kol1, null, 12000, 3400, 41000, 860000, 88, '头部美食博主转发点评', `seed:p1:e2`, ago(120))
  ei.run(p1, kol1, kol2, null, 36000, 9800, 152000, 2300000, 95, '登微博热搜榜，话题主持人扩散', `seed:p1:e3`, ago(70))
  ei.run(p1, kol1, med1, null, 8400, 2100, 33000, 510000, 82, '短视频媒体二次剪辑传播', `seed:p1:e4`, ago(60))
  ei.run(p1, med1, nd1, null, 900, 520, 2600, 60000, 55, '问答平台专题讨论', `seed:p1:e5`, ago(45))
  ai.run(p1, a1.id, ago(170))
  ;[['建档', '传播路径建档：来源《澎湃新闻》暗访报道，话题「食品安全」', ago(170)],
    ['阶段推进', '影响阶段：潜伏期 → 发酵期（节点 3 个，热度升至 88）', ago(120)],
    ['阶段推进', '影响阶段：发酵期 → 爆发期（KOL「微博热搜君」加入，热度峰值 95）', ago(70)],
    ['关联预警', '关联红色预警规则「负面情绪集中爆发」', ago(170)],
    ['关联危机', '关联危机事件「某连锁品牌门店卫生事件」#1', ago(170)],
    ['自动工单', '爆发期自动生成跨角色处置工单 #W1「传播溯源与口径统一」（公关）', ago(40)]]
    .forEach(([act, det, t]) => li.run(p1, act, det, '系统', t))
  // 爆发期自动工单（已完成，回写危机时间线）
  const wid = Number(db.prepare(`INSERT INTO work_orders
    (crisis_id,prop_path_id,title,detail,category,priority,status,assignee,assignee_role,created_by,started_at,done_at,result,created,updated)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    c1.id, p1, '传播溯源与口径统一', '锁定暗访视频首发来源与关键转发节点，2 小时内统一对外口径并协调头部账号删改不实信息。',
    'pr', 'urgent', 'done', '李澈', 'ops', '系统', ago(40), ago(35),
    '已锁定首发来源与 2 个关键 KOL 节点，官方声明同步发布，协调平台对不实剪辑下架处理。', ago(40), ago(35)).lastInsertRowid)
  const wl = db.prepare('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)')
  wl.run(wid, 'created', '传播路径进入爆发期，系统自动拆分协同工单（紧急 · 公关口径）', '系统', 'admin', ago(40))
  wl.run(wid, 'assigned', '分派给 李澈（值班员）', '系统', 'admin', ago(40))
  wl.run(wid, 'done', '完成：已锁定首发来源与关键 KOL 节点，官方声明同步发布。', '李澈', 'ops', ago(35))
  db.prepare('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)')
    .run(c1.id, '传播爆发', '传播路径「某连锁品牌后厨卫生事件传播链」进入爆发期：KOL「微博热搜君」转发，峰值热度 95，触达 230 万+。', ago(70))

  // ---- P2 传播链：新浪科技首发 → 黑猫投诉 → 消费点评师(KOL，热度未及爆发阈值) ----
  const root2 = node(p2, '新浪科技', '新浪科技', 'root', '微博', 0, ago(85))
  const med2 = node(p2, '黑猫投诉平台', '黑猫投诉平台', 'media', '微博', 4200000, ago(50))
  const kol3 = node(p2, '消费点评师', '消费点评师', 'kol', '微博', 3200000, ago(20))
  ei.run(p2, null, root2, 1, 210, 96, 760, 80000, 45, '用户吐槽订单两周未发货', `seed:p2:e1`, ago(85))
  ei.run(p2, root2, med2, null, 600, 410, 2200, 420000, 52, '投诉平台聚合受理，话题扩散', `seed:p2:e2`, ago(50))
  ei.run(p2, med2, kol3, null, 900, 300, 3100, 320000, 58, '消费类 KOL 跟进点评（热度尚未到爆发阈值 60）', `seed:p2:e3`, ago(20))
  ai.run(p2, a2.id, ago(85))
  ;[['建档', '传播路径建档：来源《新浪科技》用户吐槽，话题「服务投诉」', ago(85)],
    ['阶段推进', '影响阶段：潜伏期 → 发酵期（节点 3 个，热度升至 52）', ago(50)],
    ['关联预警', '关联橙色预警规则「投诉类话题升温」', ago(85)],
    ['关联危机', '关联危机事件「投诉类话题升温事件」#2', ago(85)]]
    .forEach(([act, det, t]) => li.run(p2, act, det, '系统', t))
  db.prepare('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)')
    .run(c2.id, '传播发酵', '传播路径「电商预售不发货投诉扩散链」进入发酵期：投诉平台聚合扩散，热度 52。', ago(50))

  // ---- P3 传播链：凤凰网首发 → 业主论坛，潜伏期 ----
  const root3 = node(p3, '凤凰网', '凤凰网', 'root', '微博', 0, ago(60))
  const nd3 = node(p3, '业主在线论坛', '业主在线论坛', 'node', '论坛', 50000, ago(40))
  ei.run(p3, null, root3, 8, 150, 88, 420, 60000, 38, '地产延期交付报道', `seed:p3:e1`, ago(60))
  ei.run(p3, root3, nd3, null, 260, 120, 600, 50000, 30, '业主论坛聚集讨论', `seed:p3:e2`, ago(40))
  ai.run(p3, a3.id, ago(60))
  ;[['建档', '传播路径建档：来源《凤凰网》地产报道，话题「房地产」', ago(60)],
    ['关联预警', '关联黄色预警规则「选址关键词监控」', ago(60)]]
    .forEach(([act, det, t]) => li.run(p3, act, det, '系统', t))
}
seedProp()

// 危机复盘报告种子（独立幂等：快照由服务启动时 ensureSeedSnapshots 从实时数据聚合补齐）
function seedReports() {
  const n = db.prepare('SELECT COUNT(*) c FROM crisis_reports').get().c
  if (n > 0) return
  const c1 = db.prepare("SELECT id FROM crisis WHERE title LIKE '%门店卫生%' ORDER BY id LIMIT 1").get()
  const c3 = db.prepare("SELECT id FROM crisis WHERE title LIKE '%会员涨价%' ORDER BY id LIMIT 1").get()
  if (!c1 || !c3) return
  const now = new Date()
  const ago = (m) => new Date(now.getTime() - m * 60000).toLocaleString('zh-CN')
  // R1 已发布报告（c3 已结案事件）：含两个归档版本（送审 v1 + 发布 v2），回写结案档案
  const tOv = ago(2880), tCause = ago(2860), tTl = ago(2855), tEval = ago(2850),
    tLessons = ago(2845), tCreated = ago(2870), tSubmitted = ago(2850), tPublished = ago(2840)
  const r1 = Number(db.prepare(`INSERT INTO crisis_reports
    (crisis_id,title,status,overview,root_cause,timeline_summary,response_eval,lessons,appendix,
     overview_by,overview_at,root_cause_by,root_cause_at,timeline_summary_by,timeline_summary_at,
     response_eval_by,response_eval_at,lessons_by,lessons_at,appendix_by,appendix_at,
     snapshot,snapshotted_at,current_version,published_version,created_by,submitted_by,submitted_at,reviewed_by,reviewed_at,published_at,created,updated)
    VALUES (?,?, 'published', ?,?,?,?,?,?,
      '张岚',?,'陈律',?,'李澈',?,'张岚',?,'李澈',?,'王观',?,
      '{}',?,2,2,'李澈','李澈',?,'张岚',?,?,?,?)
  `).run(
    c3.id, '某视频平台会员涨价争议 · 危机复盘报告',
    '会员涨价公告发布后，社交平台出现以中性偏负为主的讨论，焦点集中于性价比与内容质量；未出现大规模抵制与次生话题，事件整体可控。',
    '直接原因为权益说明不充分、价格梯度单一；深层原因为会员价值感知与定价节奏缺少前置沟通，客服答疑口径准备滞后。',
    '公告发布后 4 小时内进入处置：发布定价说明、上线会员权益升级方案、客服集中答疑；观察期一周，热度与负面占比同步回落，随后解除预警并结案。',
    '首次响应在 4 小时内，未达到红色事件 2 小时标准但舆情烈度较低，处置节奏合理；传播以平台讨论为主，无 KOL 集中介入，风险窗口判断准确。',
    '1) 调价类公告前 72 小时完成权益沟通物料与客服口径准备；2) 建立价格敏感度小样本调研机制；3) 对高等级会员提供差异化补偿；4) 将「性价比」关键词纳入日常监测。',
    '附：近一周讨论量曲线、客服答疑 Top10 问题清单（见工单结果）。',
    tOv, tCause, tTl, tEval, tLessons, tPublished,
    tSubmitted, tPublished, tPublished, tCreated, tCreated, tPublished
  ).lastInsertRowid)
  db.prepare(`INSERT INTO crisis_report_versions (report_id,version,kind,status,title,content,snapshot,operator,note,source_version,created)
    VALUES (?,?,'submit','reviewing',?,'{}','{}',?,?,0,?)`)
    .run(r1, 1, '某视频平台会员涨价争议 · 危机复盘报告', '李澈', '首版送审', tSubmitted)
  db.prepare(`INSERT INTO crisis_report_versions (report_id,version,kind,status,title,content,snapshot,operator,note,source_version,created)
    VALUES (?,?,'publish','published',?,'{}','{}',?,?,0,?)`)
    .run(r1, 2, '某视频平台会员涨价争议 · 危机复盘报告', '张岚', '审核通过：改进措施补充价格敏感度调研，同意发布', tPublished)
  const log = db.prepare('INSERT INTO crisis_report_logs (report_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)')
  log.run(r1, 'create', '为已结案事件补建复盘报告，进入编制', '李澈', 'ops', tCreated)
  log.run(r1, 'submit', '提交审核（归档 v1）', '李澈', 'ops', tSubmitted)
  log.run(r1, 'approve', '审核通过并发布（归档 v2），已回写结案档案', '张岚', 'admin', tPublished)
  // 回写 c3 最近一次结案档案
  db.prepare(`UPDATE crisis_closures SET report_id=?, report_version=2, report_title=?
    WHERE id=(SELECT id FROM crisis_closures WHERE crisis_id=? ORDER BY id DESC LIMIT 1)`)
    .run(r1, '某视频平台会员涨价争议 · 危机复盘报告', c3.id)

  // R2 编制中报告（c1 红色处置中事件）：已完成部分章节，等待跨角色补全（法务/客服章节未编辑）
  const t2Created = ago(120), t2Ov = ago(118), t2Eval = ago(60)
  const r2 = Number(db.prepare(`INSERT INTO crisis_reports
    (crisis_id,title,status,overview,root_cause,timeline_summary,response_eval,lessons,
     overview_by,overview_at,response_eval_by,response_eval_at,
     snapshot,snapshotted_at,current_version,published_version,created_by,created,updated)
    VALUES (?,?,'draft',?,'',?,'','',
      '张岚',?,'李澈',?,'{}',?,0,0,'张岚',?,?)
  `).run(
    c1.id, '某连锁品牌门店卫生事件 · 危机复盘报告（编制中）',
    '暗访视频曝光某门店后厨操作不规范，经媒体首发后由头部美食 KOL 转发，话题进入爆发期，峰值热度 95，累计触达超 300 万。',
    '待补：结合处置时间线梳理首次回应、门店关停、第三方复查各节点的得失（请运营/公关团队补全）。',
    t2Ov, t2Eval, t2Ov, t2Created, t2Eval
  ).lastInsertRowid)
  log.run(r2, 'create', '为红色事件创建复盘报告，进入跨角色分段编制', '张岚', 'admin', t2Created)
  log.run(r2, 'edit', '事件概述已由 张岚（管理员）保存', '张岚', 'admin', t2Ov)
  log.run(r2, 'edit', '响应与传播评估已由 李澈（值班员）保存', '李澈', 'ops', t2Eval)
}
seedReports()

// 危机声明种子（独立幂等：公关起草 → 法务审核 → 分渠道发布登记；关联 c1/c2 与公关口径工单）
function seedStatements() {
  const n = db.prepare('SELECT COUNT(*) c FROM crisis_statements').get().c
  if (n > 0) return
  const now = new Date()
  const ago = (m) => new Date(now.getTime() - m * 60000).toLocaleString('zh-CN')
  const c1 = db.prepare("SELECT id FROM crisis WHERE title LIKE '%门店卫生%' ORDER BY id LIMIT 1").get()
  const c2 = db.prepare("SELECT id FROM crisis WHERE title LIKE '%投诉类话题%' ORDER BY id LIMIT 1").get()
  if (!c1 || !c2) return
  const w1 = db.prepare("SELECT id FROM work_orders WHERE crisis_id=? AND title LIKE '%回应口径%' ORDER BY id LIMIT 1").get(c1.id)

  const si = db.prepare(`INSERT INTO crisis_statements
    (crisis_id,work_order_id,title,content,channels,priority,status,
     drafted_by,drafted_at,submitted_by,submitted_at,reviewed_by,reviewed_at,review_note,
     publish_by,publish_at,published_at,created,updated)
    VALUES (?,?,?,?,?,?,'publishing',?,?,?,?,?,?,?,?,?,NULL,?,?)`)
  // S1 整改情况说明（第二版）：法务已审核通过，分渠道发布执行中（2 已发 / 1 失败待重试 / 2 待执行）
  const s1 = Number(si.run(
    c1.id, w1 ? w1.id : null,
    '某连锁品牌门店卫生事件整改情况说明',
    '针对近日媒体报道的我司某加盟门店后厨操作不规范问题，公司高度重视，现说明如下：\n一、涉事门店已即刻停业整顿，全面开展后厨消杀与操作规范复查；\n二、已委托第三方检测机构对食材与操作环境进行独立检测，结果将第一时间向社会公布；\n三、即日起在全国门店启动食品安全专项自查，欢迎社会各界监督。\n我们对给消费者带来的担忧深表歉意，后续整改进展将持续通过官方渠道发布。',
    JSON.stringify(['weibo', 'wechat', 'website', 'news', 'video']), 'urgent',
    '李澈', ago(150), '李澈', ago(140), '陈律', ago(120), '口径与证据材料一致，整改表述已规避责任风险，同意按审核稿发布；媒体沟通中不得承诺检测结论。',
    '张岚', ago(90), ago(160), ago(10)).lastInsertRowid)
  if (w1) db.prepare('UPDATE work_orders SET last_statement_id=? WHERE id=?').run(s1, w1.id)

  const ci = db.prepare(`INSERT INTO crisis_statement_channels
    (statement_id,channel,channel_name,assignee,status,result,published_url,fail_reason,attempts,registered_by,registered_at,published_at,created,updated)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const t1 = ago(150)
  // 微博：已发布
  ci.run(s1, 'weibo', '官方微博', '李澈', 'success',
    '已通过官方微博发布，置顶并关闭带节奏评论，转发 1.2w。', 'https://weibo.com/demo/status/s1wb', '', 1, '李澈', ago(70), ago(70), t1, ago(70))
  // 官网：已发布
  ci.run(s1, 'website', '官网新闻中心', '张岚', 'success',
    '官网新闻中心已上线，附第三方检测预约说明。', 'https://brand.com/news/s1', '', 1, '张岚', ago(60), ago(60), t1, ago(60))
  // 新闻通稿：首发失败（对接媒体未及时回执），可重试
  ci.run(s1, 'news', '新闻通稿（媒体邮箱组）', '张岚', 'failed',
    '', '', '媒体对接人未在截稿前回执，稿件暂缓；已电话沟通，可重试发送。', 1, '张岚', ago(30), null, t1, ago(30))
  // 微信公众号 / 短视频：待执行
  ci.run(s1, 'wechat', '微信公众号', '李澈', 'pending', '', '', '', 0, '', null, null, t1, t1)
  ci.run(s1, 'video', '官方短视频账号', '李澈', 'pending', '', '', '', 0, '', null, null, t1, t1)

  const li = db.prepare('INSERT INTO crisis_statement_logs (statement_id,action,detail,operator,time) VALUES (?,?,?,?,?)')
  li.run(s1, 'create', '公关起草危机声明（紧急），拟定发布渠道：官方微博、微信公众号、官网、新闻通稿、官方短视频', '李澈', ago(150))
  li.run(s1, 'edit', '补充第三方检测与致歉表述', '李澈', ago(145))
  li.run(s1, 'submit', '提交法务审核', '李澈', ago(140))
  li.run(s1, 'approve', '法务审核通过：口径与证据材料一致，同意按审核稿发布；媒体沟通中不得承诺检测结论。', '陈律', ago(120))
  li.run(s1, 'publish', '发起分渠道发布，5 个渠道待执行（执行人：李澈/张岚）', '张岚', ago(90))
  li.run(s1, 'channel_result', '【官方微博】发布成功：已置顶，转发 1.2w', '李澈', ago(70))
  li.run(s1, 'channel_result', '【官网新闻中心】发布成功', '张岚', ago(60))
  li.run(s1, 'channel_result', '【新闻通稿】发布失败：媒体对接人未在截稿前回执，可重试', '张岚', ago(30))

  const tl = db.prepare('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)')
  tl.run(c1.id, '声明起草', `公关 李澈 起草危机声明「某连锁品牌门店卫生事件整改情况说明」（第二版）`, ago(150))
  tl.run(c1.id, '声明送审', `声明「某连锁品牌门店卫生事件整改情况说明」提交法务审核（提交人：李澈）`, ago(140))
  tl.run(c1.id, '声明审核通过', `法务 陈律 审核通过：口径与证据材料一致，同意按审核稿发布`, ago(120))
  tl.run(c1.id, '声明发布', `声明「某连锁品牌门店卫生事件整改情况说明」发起分渠道发布（官方微博/微信公众号/官网/新闻通稿/官方短视频），关联工单进度同步`, ago(90))
  tl.run(c1.id, '声明渠道', `渠道发布登记：官方微博、官网新闻中心已发布；新闻通稿发送失败待重试（2/5 已发布）`, ago(30))
  if (w1) {
    const wl = db.prepare('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)')
    wl.run(w1.id, 'stmt', '关联危机声明「某连锁品牌门店卫生事件整改情况说明」法务审核通过，进入分渠道发布', '陈律', 'legal', ago(120))
    wl.run(w1.id, 'stmt', '声明发布进度回写：官方微博、官网已发布；新闻通稿失败待重试（2/5 已发布）', '系统', '', ago(30))
  }

  // S2 首次回应声明：全渠道已发布（演示完整闭环）
  const s2 = Number(db.prepare(`INSERT INTO crisis_statements
    (crisis_id,work_order_id,title,content,channels,priority,status,
     drafted_by,drafted_at,submitted_by,submitted_at,reviewed_by,reviewed_at,review_note,
     publish_by,publish_at,published_at,created,updated)
    VALUES (?,NULL,?,?,?,'urgent','published',?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    c1.id,
    '关于某门店后厨卫生事件的首次回应',
    '我们关注到媒体关于我司某门店后厨卫生的报道，已第一时间成立专项小组并赴现场核查，涉事门店已暂停营业。核查与整改情况将持续向公众通报，感谢媒体与消费者监督。',
    JSON.stringify(['weibo', 'wechat', 'website', 'news']),
    '李澈', ago(300), '李澈', ago(295), '陈律', ago(280), '首次回应口径稳妥，同意发布。',
    '张岚', ago(270), ago(200), ago(300), ago(200)).lastInsertRowid)
  const c2ins = db.prepare(`INSERT INTO crisis_statement_channels
    (statement_id,channel,channel_name,assignee,status,result,published_url,fail_reason,attempts,registered_by,registered_at,published_at,created,updated)
    VALUES (?,?,?,?,'success',?,?,'',1,?,?,?,?,?)`)
  c2ins.run(s2, 'weibo', '官方微博', '李澈', '官方微博已发布并置顶。', 'https://weibo.com/demo/status/s2wb', '李澈', ago(240), ago(240), ago(270), ago(240))
  c2ins.run(s2, 'wechat', '微信公众号', '李澈', '微信公众号推文已群发。', 'https://mp.weixin.qq.com/s/s2', '李澈', ago(230), ago(230), ago(270), ago(230))
  c2ins.run(s2, 'website', '官网新闻中心', '张岚', '官网公告已上线。', 'https://brand.com/news/s2', '张岚', ago(220), ago(220), ago(270), ago(220))
  c2ins.run(s2, 'news', '新闻通稿（媒体邮箱组）', '张岚', '通稿已发送媒体邮箱组，3 家媒体已采用。', '', '张岚', ago(200), ago(200), ago(270), ago(200))
  const l2 = db.prepare('INSERT INTO crisis_statement_logs (statement_id,action,detail,operator,time) VALUES (?,?,?,?,?)')
  l2.run(s2, 'create', '公关起草首次回应声明（紧急）', '李澈', ago(300))
  l2.run(s2, 'submit', '提交法务审核', '李澈', ago(295))
  l2.run(s2, 'approve', '法务审核通过：首次回应口径稳妥', '陈律', ago(280))
  l2.run(s2, 'publish', '发起分渠道发布，4 个渠道待执行', '张岚', ago(270))
  l2.run(s2, 'channel_result', '【官方微博】发布成功', '李澈', ago(240))
  l2.run(s2, 'channel_result', '【微信公众号】发布成功', '李澈', ago(230))
  l2.run(s2, 'channel_result', '【官网新闻中心】发布成功', '张岚', ago(220))
  l2.run(s2, 'channel_result', '【新闻通稿】发布成功，3 家媒体采用', '张岚', ago(200))
  l2.run(s2, 'done', '全部 4 个渠道发布登记完成', '张岚', ago(200))
  db.prepare('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)')
    .run(c1.id, '声明发布完成', '首次回应声明 4 个渠道（官方微博/微信公众号/官网/新闻通稿）全部发布完成', ago(200))

  // S3 投诉升温事件声明：已送审，等待法务审核（演示审核流转）
  const s3 = Number(db.prepare(`INSERT INTO crisis_statements
    (crisis_id,work_order_id,title,content,channels,priority,status,
     drafted_by,drafted_at,submitted_by,submitted_at,created,updated)
    VALUES (?,NULL,?,?,?,'high','review',?,?,?,?,?,?)`).run(
    c2.id,
    '关于预售商品发货延迟问题的说明与补偿方案',
    '近期收到部分用户反映预售商品发货延迟，我们深表歉意。说明如下：\n一、延迟系订单量激增叠加仓配调度所致，已加急补货并增派运力；\n二、对超期未发货订单支持一键取消并全额退款，同时补偿等额优惠券；\n三、客服通道已扩容，预计 48 小时内完成积压订单发货。\n感谢用户的理解与耐心等待。',
    JSON.stringify(['weibo', 'wechat', 'website']),
    '李澈', ago(40), '李澈', ago(20), ago(40), ago(20)).lastInsertRowid)
  const l3 = db.prepare('INSERT INTO crisis_statement_logs (statement_id,action,detail,operator,time) VALUES (?,?,?,?,?)')
  l3.run(s3, 'create', '公关起草危机声明（高优），拟定发布渠道：官方微博、微信公众号、官网', '李澈', ago(40))
  l3.run(s3, 'submit', '提交法务审核，等待法务意见', '李澈', ago(20))
  db.prepare('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)')
    .run(c2.id, '声明送审', `声明「关于预售商品发货延迟问题的说明与补偿方案」提交法务审核（提交人：李澈）`, ago(20))
}
seedStatements()

// 危机声明通知订阅（独立幂等：渠道发布失败即时提醒 + 部分失败督办需回执）
function seedStatementSubs() {
  const n = db.prepare("SELECT COUNT(*) c FROM notify_subs WHERE stmt_event!=''").get().c
  if (n > 0) return
  const nowStr = new Date().toLocaleString('zh-CN')
  const ch1 = db.prepare("SELECT id FROM notify_channels WHERE name='值班 Webhook'").get()
  const ch4 = db.prepare("SELECT id FROM notify_channels WHERE name='升级专线'").get()
  const ss = db.prepare(`INSERT INTO notify_subs (name,alert_id,topic,crisis_status,levels,channel_ids,require_ack,ack_timeout_min,escalate_channel_id,max_retry,active,created,created_by,stmt_event)
    VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)`)
  // 单个渠道登记失败 → 值班 Webhook 即时提醒（可重试/放弃）
  if (ch1) ss.run('声明渠道发布失败提醒', null, '', '', '', JSON.stringify([ch1.id]), 0, 30, null, 3, nowStr, '系统初始化', 'chfail')
  // 全部渠道登记完但存在失败（发布未完成、阻塞结案）→ 升级专线督办，需回执 1 分钟超时升级
  if (ch4) ss.run('声明部分渠道失败督办', null, '', '', '', JSON.stringify([ch4.id]), 1, 1, ch4.id, 3, nowStr, '系统初始化', 'partial')
}
seedStatementSubs()

// 外部协作反馈门户种子（独立幂等：老库升级后同样补齐协作方与演示提交）
function seedExtPortal() {
  const np = db.prepare('SELECT COUNT(*) c FROM ext_partners').get().c
  const nowStr = new Date().toLocaleString('zh-CN')
  if (np === 0) {
    const pi = db.prepare(`INSERT INTO ext_partners (name,kind,contact,phone,email,access_code,enabled,created,created_by)
      VALUES (?,?,?,?,?,?,1,?,?)`)
    pi.run('某连锁品牌总部（公关部）', 'brand', '周敏', '138-0000-1001', 'pr@brand-demo.com', 'BRAND-2026', nowStr, '系统初始化')
    pi.run('市市场监督管理局（食品经营监管科）', 'regulator', '高珂', '0571-12315', 'fda@gov-demo.cn', 'GOV-12315', nowStr, '系统初始化')
    pi.run('澎湃新闻（民生调查部）', 'media', '林记者', '139-0000-2002', 'lin@thepaper-demo.cn', 'PRESS-PP', nowStr, '系统初始化')
  }
  const ns = db.prepare('SELECT COUNT(*) c FROM ext_submissions').get().c
  if (ns === 0) {
    const c1 = db.prepare("SELECT id FROM crisis WHERE title LIKE '%门店卫生%' ORDER BY id LIMIT 1").get()
    const w2 = db.prepare("SELECT id FROM work_orders WHERE crisis_id=? AND title LIKE '%固定证据%' ORDER BY id LIMIT 1").get(c1 ? c1.id : -1)
    if (!c1) return
    const ago = (m) => new Date(new Date().getTime() - m * 60000).toLocaleString('zh-CN')
    const brand = db.prepare("SELECT id FROM ext_partners WHERE access_code='BRAND-2026'").get()
    const gov = db.prepare("SELECT id FROM ext_partners WHERE access_code='GOV-12315'").get()
    const media = db.prepare("SELECT id FROM ext_partners WHERE access_code='PRESS-PP'").get()
    const si = db.prepare(`INSERT INTO ext_submissions
      (code,partner_id,kind,crisis_id,work_order_id,doc_type,title,content,attachments,source_url,contact_info,is_urgent,status,
       accepted_by,accepted_at,accepted_note,resolve_alerts,resolved_alert_count,reviewed_by,reviewed_at,created,updated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    // E1 品牌方整改进度：已采纳，回写法务工单并联动解除（演示完整回写闭环；种子不改动既有预警状态，实际解除条数置 0）
    const e1 = Number(si.run(
      'EXT-1001', brand.id, 'brand', c1.id, w2 ? w2.id : null, 'rectify', '涉事门店整改进度日报（第 2 日）',
      '一、涉事 1 家加盟店已停业整顿，后厨消杀与设备检修完成；\n二、第三方检测机构已进场采样，预计 3 个工作日出具报告；\n三、全国门店食品安全专项自查已启动，覆盖率 42%；\n四、员工操作规范再培训完成 18 场，覆盖 6 个大区。\n附整改前后对比照片与消杀记录，请审核后并入处置档案。',
      JSON.stringify([{ name: '门店消杀记录.pdf', size: 820000, type: 'application/pdf' }, { name: '整改前后对比照片.zip', size: 3600000, type: 'application/zip' }]),
      'https://brand-demo.com/rectify/day2', '周敏 138-0000-1001', 0, 'accepted',
      '张岚', ago(35), '整改进度属实，已并入事件处置档案并回写法务取证工单；专项自查报告待第三日继续报送。',
      0, 0, '李澈', ago(45), ago(80), ago(35)).lastInsertRowid)
    if (w2) {
      db.prepare('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)')
        .run(w2.id, 'ext', `外部协作门户：品牌方提交「涉事门店整改进度日报（第 2 日）」已采纳，回写工单（EXT-1001）`, '周敏（品牌方）', '', ago(35))
    }
    db.prepare('INSERT INTO crisis_timeline (crisis_id,action,note,time,ref_type,ref_id) VALUES (?,?,?,?,?,?)')
      .run(c1.id, '外部反馈采纳', '采纳品牌方（某连锁品牌总部）提交的整改进度：「涉事门店整改进度日报（第 2 日）」——停业整顿与消杀完成，第三方检测进场采样，全国自查覆盖率 42%（EXT-1001）',
        ago(35), 'ext', e1)
    const l1 = db.prepare('INSERT INTO ext_submission_logs (submission_id,action,detail,operator,operator_side,time) VALUES (?,?,?,?,?,?)')
    l1.run(e1, 'create', '品牌方通过外部协作门户提交整改进度（2 个附件）', '周敏', 'external', ago(80))
    l1.run(e1, 'receive', '值班员 李澈 受理，转入内部审核', '李澈', 'internal', ago(45))
    l1.run(e1, 'accept', '管理员 张岚 审核采纳，回写危机时间线' + (w2 ? '与法务取证工单' : '') + '（EXT-1001）', '张岚', 'internal', ago(35))

    // E2 监管方督办通知：待审核，紧急（提交时已触发升级通知）
    const e2 = Number(si.run(
      'EXT-1002', gov.id, 'regulator', c1.id, null, 'evidence', '监管督办通知：限期提交整改情况与检测报告',
      '我科接舆情线索后已现场核查，现要求：\n1. 48 小时内提交书面整改情况说明；\n2. 第三方检测报告出具后 2 小时内报送；\n3. 对全国加盟店食品安全管理制度开展排查并报送整改清单。\n逾期未报送将依法依规处置。',
      JSON.stringify([{ name: '监督检查记录.pdf', size: 540000, type: 'application/pdf' }, { name: '督办通知书.pdf', size: 310000, type: 'application/pdf' }]),
      '', '高珂 0571-12315', 1, 'pending',
      '', null, '', 0, 0, '', null, ago(12), ago(12)).lastInsertRowid)
    l1.run(e2, 'create', '监管方通过外部协作门户提交督办通知（紧急，2 个附件），已联动通知升级', '高珂（监管方）', 'external', ago(12))
    l1.run(e2, 'urgent', '紧急提交：已按「外部协作升级督办」订阅生成升级通知', '系统', 'system', ago(12))
    db.prepare('INSERT INTO crisis_timeline (crisis_id,action,note,time,ref_type,ref_id) VALUES (?,?,?,?,?,?)')
      .run(c1.id, '外部反馈升级', '监管方（市市场监督管理局）紧急提交督办通知：限期 48 小时报送整改说明与第三方检测报告，逾期依法处置（EXT-1002）',
        ago(12), 'ext', e2)

    // E3 媒体新证据：受理中（补充采访线索，待审核）
    const e3 = Number(si.run(
      'EXT-1003', media.id, 'media', c1.id, null, 'evidence', '补充采访证据：另一加盟店存在同类操作问题',
      '本报记者回访发现，同城另一家加盟店 3 日前亦被市民反映后厨地面积水、食材就地堆放，当时门店仅口头致歉。\n随附市民提供的现场视频截图与采访录音整理，供处置参考；本报将持续跟踪报道。',
      JSON.stringify([{ name: '市民提供视频截图.png', size: 1200000, type: 'image/png' }, { name: '采访录音整理.docx', size: 96000, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }]),
      'https://thepaper-demo.cn/news/followup-1', '林记者 139-0000-2002', 0, 'reviewing',
      '', null, '', 0, 0, '李澈', ago(8), ago(20), ago(8)).lastInsertRowid)
    l1.run(e3, 'create', '媒体（澎湃新闻）通过门户提交补充采访证据（2 个附件）', '林记者', 'external', ago(20))
    l1.run(e3, 'receive', '值班员 李澈 受理，正在核实另一家加盟店问题', '李澈', 'internal', ago(8))
  }
  // 通知订阅（独立幂等：协作方/提交已存在时也补齐订阅；任务由启动流程补生成）
  const nsub = db.prepare("SELECT COUNT(*) c FROM notify_subs WHERE ext_event!=''").get().c
  if (nsub === 0) {
    const ch1 = db.prepare("SELECT id FROM notify_channels WHERE name='值班 Webhook'").get()
    const ch2 = db.prepare("SELECT id FROM notify_channels WHERE name='危机邮箱组'").get()
    const ch4 = db.prepare("SELECT id FROM notify_channels WHERE name='升级专线'").get()
    const ids = [ch1, ch2, ch4].filter(Boolean).map((r) => r.id)
    const es = db.prepare(`INSERT INTO notify_subs (name,alert_id,topic,crisis_status,levels,channel_ids,require_ack,ack_timeout_min,escalate_channel_id,max_retry,active,created,created_by,ext_event)
      VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)`)
    if (ch1) es.run('外部协作提交提醒', null, '', '', '', JSON.stringify([ch1.id]), 0, 30, null, 3, nowStr, '系统初始化', 'submitted')
    if (ch4 && ids.length) {
      es.run('外部协作紧急升级督办', null, '', '', '', JSON.stringify([ch4.id]), 1, 1, ch4.id, 3, nowStr, '系统初始化', 'escalated')
    }
  }
}
seedExtPortal()
