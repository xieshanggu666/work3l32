import { db } from './db.js'
import { now, addTimeline } from './pipeline.js'
import { ROLE_TEXT } from './notify.js'
import { deliveryRollup, crisisDispatchSummary } from './dispatch.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// ===== 常量与口径 =====
export const REPORT_STATUS = { draft: '编制中', reviewing: '待审核', published: '已发布' }
// 报告章节（跨角色分段编制：每段独立记录最后编辑人/时间）
export const SECTIONS = {
  overview: '事件概述',
  root_cause: '原因分析',
  timeline_summary: '处置时间线复盘',
  response_eval: '响应与传播评估',
  lessons: '经验教训与改进措施',
  appendix: '附录与备注'
}
const SECTION_FIELDS = Object.keys(SECTIONS)
const SNAP_TASK_LIMIT = 200 // 通知回执明细快照上限（计数不受限制）

function addLog(reportId, action, detail, actor = { user: '系统', role: '' }) {
  run('INSERT INTO crisis_report_logs (report_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)',
    reportId, action, detail || '', actor.user || '系统', actor.assigneeRole || actor.role || '', now())
}

// ===== 聚合快照：预警 / 时间线 / 传播路径 / 工单 / 通知回执 / 结案档案 同源汇总 =====
// 所有计数均 SQL 直查，与各业务模块（预警中心/危机处置/工单看板/通知中心/传播路径）同口径。
export function buildSnapshot(crisisId) {
  const c = q1('SELECT * FROM crisis WHERE id=?', crisisId)
  if (!c) return null

  // ---- 预警：触发记录按规则拆分，含解除途径与关联舆情 ----
  const events = q(`SELECT ae.id, ae.alert_id, ae.post_id, ae.detail, ae.time, ae.status, ae.resolved, ae.resolve_kind,
      al.title alert_title, al.level alert_level, p.title pt, p.heat, p.sentiment sent
    FROM alert_events ae LEFT JOIN alerts al ON al.id=ae.alert_id LEFT JOIN posts p ON p.id=ae.post_id
    WHERE ae.crisis_id=? ORDER BY ae.id ASC`, crisisId)
  const ruleMap = new Map()
  for (const e of events) {
    const key = e.alert_id
    if (!ruleMap.has(key)) ruleMap.set(key, { alert_id: e.alert_id, title: e.alert_title || '已删除规则', level: e.alert_level || '', total: 0, open: 0 })
    const r = ruleMap.get(key)
    r.total += 1
    if (e.status === 'open') r.open += 1
  }
  const alerts = {
    total: events.length,
    open: events.filter((e) => e.status === 'open').length,
    resolved: events.filter((e) => e.status === 'resolved').length,
    byRule: [...ruleMap.values()],
    events
  }

  // ---- 处置时间线（统一时间线，与危机卡片/回溯同表） ----
  const timelineItems = q('SELECT * FROM crisis_timeline WHERE crisis_id=? ORDER BY id ASC', crisisId)
  const timeline = { total: timelineItems.length, items: timelineItems }

  // ---- 传播路径：阶段/节点/KOL/转发/触达/峰值热度聚合 ----
  const paths = q(`SELECT pp.*,
      (SELECT COUNT(*) FROM prop_nodes pn WHERE pn.path_id=pp.id) node_count,
      (SELECT COUNT(*) FROM prop_nodes pn WHERE pn.path_id=pp.id AND pn.kind='kol') kol_count,
      (SELECT COUNT(*) FROM prop_edges pe WHERE pe.path_id=pp.id) edge_count,
      (SELECT COALESCE(SUM(pe.reach),0) FROM prop_edges pe WHERE pe.path_id=pp.id) total_reach,
      (SELECT COALESCE(MAX(pe.heat),0) FROM prop_edges pe WHERE pe.path_id=pp.id) edge_peak
    FROM prop_paths pp WHERE pp.crisis_id=? ORDER BY pp.id ASC`, crisisId)
  const propagation = {
    total: paths.length,
    outbreak: paths.filter((p) => p.stage === 'outbreak' && p.status === 'active').length,
    active: paths.filter((p) => p.status === 'active').length,
    paths: paths.map((p) => ({
      id: p.id, title: p.title, topic: p.topic, stage: p.stage, status: p.status,
      nodeCount: p.node_count, kolCount: p.kol_count, edgeCount: p.edge_count,
      totalReach: p.total_reach, peakHeat: Math.max(p.peak_heat || 0, p.edge_peak || 0)
    }))
  }

  // ---- 协同工单：状态分布 + SLA 超时 + 通知链路（发送/重试/回执/升级）+ 处理结果留痕 ----
  const woRows = q('SELECT * FROM work_orders WHERE crisis_id=? ORDER BY id ASC', crisisId)
  const nowMs = Date.now()
  const woRollup = deliveryRollup(woRows.map((w) => w.id))
  const workOrders = {
    total: woRows.length,
    open: woRows.filter((w) => ['todo', 'doing', 'blocked'].includes(w.status)).length,
    done: woRows.filter((w) => w.status === 'done').length,
    cancelled: woRows.filter((w) => w.status === 'cancelled').length,
    overdue: woRows.filter((w) => ['todo', 'doing'].includes(w.status) && w.due_at != null && w.due_at < nowMs).length,
    escalated: woRows.filter((w) => w.escalated > 0 && ['todo', 'doing', 'blocked'].includes(w.status)).length,
    items: woRows.map((w) => ({
      id: w.id, title: w.title, detail: w.detail, category: w.category, priority: w.priority,
      status: w.status, assignee: w.assignee, assignee_role: w.assignee_role,
      result: w.result, resolve_alerts: w.resolve_alerts, due_at: w.due_at, escalated: w.escalated,
      dispatch_seq: w.dispatch_seq, dispatch_state: w.dispatch_state, delivery: woRollup[w.id] || null,
      done_at: w.done_at, created: w.created, prop_path_id: w.prop_path_id
    }))
  }

  // ---- 通知回执：任务状态分布、发送重试、回执确认与升级记录（与看板/危机卡片同口径） ----
  const dispatch = crisisDispatchSummary(crisisId)
  const ntRows = q(`SELECT nt.*, nc.name channel_name, nc.type channel_type
    FROM notify_tasks nt LEFT JOIN notify_channels nc ON nc.id=nt.channel_id
    WHERE nt.crisis_id=? ORDER BY nt.id DESC LIMIT ?`, crisisId, SNAP_TASK_LIMIT)
  const notifications = {
    total: dispatch.total,
    byStatus: dispatch.byStatus,
    acked: dispatch.acked,
    escalated: dispatch.escalated,
    failed: dispatch.failed,
    pending: dispatch.pending,
    retries: dispatch.retries,
    items: ntRows.map((t) => ({
      id: t.id, title: t.title, kind: t.kind, status: t.status,
      channel_name: t.channel_name || '已删除渠道', channel_type: t.channel_type,
      require_ack: t.require_ack, ack_by: t.ack_by, ack_at: t.ack_at, ack_note: t.ack_note,
      escalated: t.escalated, escalated_from: t.escalated_from,
      work_order_id: t.work_order_id, prop_path_id: t.prop_path_id,
      ext_submission_id: t.ext_submission_id, alert_event_id: t.alert_event_id,
      corr_id: t.corr_id, seq: t.seq,
      attempts: t.attempts, max_attempts: t.max_attempts, last_error: t.last_error,
      sent_at: t.sent_at, created: t.created
    }))
  }

  // ---- 结案档案（含回滚记录与统一守卫快照/通知中止清单） ----
  const closures = q('SELECT * FROM crisis_closures WHERE crisis_id=? ORDER BY id ASC', crisisId).map((cl) => ({
    id: cl.id, summary: cl.summary, closed_at: cl.closed_at, rolled_back: cl.rolled_back,
    rolled_back_at: cl.rolled_back_at, rollback_note: cl.rollback_note,
    report_id: cl.report_id, report_version: cl.report_version, report_title: cl.report_title,
    resolved_events: safeParse(cl.resolved_events, []),
    cancelled_tasks: safeParse(cl.cancelled_tasks, []),
    guard_snapshot: safeParse(cl.guard_snapshot, null)
  }))

  // ---- 危机声明：公关起草→法务审核→分渠道发布登记（含分渠道结果与回写口径） ----
  const stmtRows = q('SELECT * FROM crisis_statements WHERE crisis_id=? ORDER BY id ASC', crisisId)
  const statements = {
    total: stmtRows.length,
    // 未完结口径与结案守卫同源：部分渠道失败（partial）仍属发布未完成，阻塞结案
    open: stmtRows.filter((s) => ['draft', 'review', 'approved', 'publishing', 'partial'].includes(s.status)).length,
    published: stmtRows.filter((s) => s.status === 'published').length,
    partial: stmtRows.filter((s) => s.status === 'partial').length,
    cancelled: stmtRows.filter((s) => s.status === 'cancelled').length,
    review: stmtRows.filter((s) => s.status === 'review').length,
    items: stmtRows.map((s) => {
      const chRows = q('SELECT * FROM crisis_statement_channels WHERE statement_id=? ORDER BY id ASC', s.id)
      return {
        id: s.id, title: s.title, status: s.status, priority: s.priority,
        drafted_by: s.drafted_by, reviewed_by: s.reviewed_by, review_note: s.review_note,
        publish_by: s.publish_by, published_at: s.published_at, work_order_id: s.work_order_id,
        channels: chRows.map((ch) => ({
          channel: ch.channel, channel_name: ch.channel_name, status: ch.status,
          assignee: ch.assignee, result: ch.result, fail_reason: ch.fail_reason, published_at: ch.published_at
        })),
        channelOk: chRows.filter((ch) => ch.status === 'success').length,
        channelFail: chRows.filter((ch) => ch.status === 'failed').length,
        channelCancelled: chRows.filter((ch) => ch.status === 'cancelled').length,
        channelTotal: chRows.length
      }
    })
  }

  // ---- 外部协作反馈：品牌方/监管方/媒体提交的证据与整改进度（含审核结论与回写口径） ----
  const extRows = q(`SELECT s.*, p.name partner_name FROM ext_submissions s
    LEFT JOIN ext_partners p ON p.id=s.partner_id WHERE s.crisis_id=? ORDER BY s.id ASC`, crisisId)
  const externalFeedback = {
    total: extRows.length,
    accepted: extRows.filter((s) => s.status === 'accepted').length,
    pending: extRows.filter((s) => ['pending', 'reviewing'].includes(s.status)).length,
    rejected: extRows.filter((s) => s.status === 'rejected').length,
    urgent: extRows.filter((s) => s.is_urgent).length,
    resolvedAlerts: extRows.reduce((a, s) => a + (s.resolved_alert_count || 0), 0),
    byKind: {
      brand: extRows.filter((s) => s.kind === 'brand').length,
      regulator: extRows.filter((s) => s.kind === 'regulator').length,
      media: extRows.filter((s) => s.kind === 'media').length
    },
    items: extRows.map((s) => ({
      id: s.id, code: s.code, kind: s.kind, partner_name: s.partner_name, doc_type: s.doc_type,
      title: s.title, status: s.status, is_urgent: !!s.is_urgent,
      work_order_id: s.work_order_id, resolved_alert_count: s.resolved_alert_count,
      accepted_by: s.accepted_by, accepted_at: s.accepted_at, accepted_note: s.accepted_note,
      rejected_by: s.rejected_by, reject_reason: s.reject_reason, created: s.created
    }))
  }

  return {
    generatedAt: now(),
    crisis: {
      id: c.id, title: c.title, level: c.level, status: c.status, topic: c.topic,
      keyword: c.keyword, origin: c.origin, created: c.created, updated: c.updated
    },
    alerts, timeline, propagation, workOrders, notifications, closures, statements, externalFeedback
  }
}

// ===== 查询 =====
function decorate(r) {
  let snapshot = {}
  try { snapshot = JSON.parse(r.snapshot || '{}') } catch { snapshot = {} }
  return { ...r, snapshot, statusText: REPORT_STATUS[r.status] || r.status }
}

export function listReports({ status = '', crisisId = null } = {}) {
  let sql = `SELECT r.*, c.title crisis_title, c.status crisis_status, c.level crisis_level,
      (SELECT COUNT(*) FROM crisis_report_versions v WHERE v.report_id=r.id) version_count
    FROM crisis_reports r LEFT JOIN crisis c ON c.id=r.crisis_id WHERE 1=1`
  const args = []
  if (status) { sql += ' AND r.status=?'; args.push(status) }
  if (crisisId) { sql += ' AND r.crisis_id=?'; args.push(crisisId) }
  sql += ' ORDER BY r.id DESC'
  return q(sql, ...args).map(decorate)
}

export function getReport(id) {
  const r = q1(`SELECT r.*, c.title crisis_title, c.status crisis_status, c.level crisis_level, c.topic crisis_topic
    FROM crisis_reports r LEFT JOIN crisis c ON c.id=r.crisis_id WHERE r.id=?`, id)
  if (!r) return null
  const report = decorate(r)
  report.versions = q('SELECT * FROM crisis_report_versions WHERE report_id=? ORDER BY version DESC', id)
    .map((v) => ({ ...v, content: safeParse(v.content, {}), snapshot: safeParse(v.snapshot, {}) }))
  report.logs = q('SELECT * FROM crisis_report_logs WHERE report_id=? ORDER BY id DESC', id)
  return report
}

function safeParse(s, dft) { try { return JSON.parse(s || '') ?? dft } catch { return dft } }

// 报告汇总（总览统计/列表头部；与各模块 SQL 同口径）
export function reportSummary() {
  const rows = q('SELECT status, COUNT(*) c FROM crisis_reports GROUP BY status')
  const counts = { draft: 0, reviewing: 0, published: 0 }
  for (const r of rows) counts[r.status] = r.c
  return {
    counts,
    total: counts.draft + counts.reviewing + counts.published,
    reviewing: counts.reviewing,
    published: counts.published
  }
}

// 危机的最新报告摘要（危机卡片/总览速览用）
export function crisisReportBrief(crisisId) {
  const r = q1('SELECT id,title,status,current_version,published_version,updated FROM crisis_reports WHERE crisis_id=? ORDER BY id DESC LIMIT 1', crisisId)
  return r ? { ...r, statusText: REPORT_STATUS[r.status] || r.status } : null
}

// ===== 章节内容读写 =====
function chapterContent(r) {
  const content = {}
  for (const f of SECTION_FIELDS) content[f] = r[f] || ''
  return content
}

// ===== 创建报告（ops+；一个危机事件仅一份复盘报告） =====
export function createReport(body, actor) {
  const b = body || {}
  const crisisId = +b.crisis_id
  const c = q1('SELECT * FROM crisis WHERE id=?', crisisId)
  if (!c) return { error: '所属危机事件不存在' }
  const exists = q1('SELECT id FROM crisis_reports WHERE crisis_id=?', crisisId)
  if (exists) return { error: '该危机事件已存在复盘报告，每份事件仅可编制一份（可在原报告上迭代版本）' }
  const ts = now()
  const title = String(b.title || '').trim() || `${c.title} · 危机复盘报告`
  const r = run(`INSERT INTO crisis_reports (crisis_id,title,status,created_by,created,updated) VALUES (?,?,'draft',?,?,?)`,
    crisisId, title, actor.user, ts, ts)
  const id = Number(r.lastInsertRowid)
  // 建档即冻结一版聚合快照，编制期间可手动刷新
  const snap = buildSnapshot(crisisId)
  run('UPDATE crisis_reports SET snapshot=?, snapshotted_at=? WHERE id=?', JSON.stringify(snap), ts, id)
  addLog(id, 'create', `为危机事件「${c.title}」#${crisisId} 创建复盘报告，进入跨角色分段编制`, actor)
  if (c.status !== 'closed') addTimeline(crisisId, '复盘建档', `复盘报告「${title}」开始编制（负责人：${actor.user}）`, ts)
  return { ok: true, id }
}

// 编辑标题（编制中）
export function renameReport(id, body, actor) {
  const r = q1('SELECT * FROM crisis_reports WHERE id=?', id)
  if (!r) return null
  if (r.status !== 'draft') return { error: '仅编制中的报告可修改标题（审核中/已发布请先驳回或回滚）' }
  const title = String(body?.title || '').trim()
  if (!title) return { error: '报告标题必填' }
  run('UPDATE crisis_reports SET title=?, updated=? WHERE id=?', title, now(), id)
  addLog(id, 'edit', `报告标题调整为「${title}」`, actor)
  return { ok: true }
}

// 分段编制：保存单个章节（记录章节最后编辑人，支撑跨角色协同）
export function editSection(id, section, content, actor) {
  const r = q1('SELECT * FROM crisis_reports WHERE id=?', id)
  if (!r) return null
  if (!SECTIONS[section]) return { error: '未知章节' }
  if (r.status !== 'draft') return { error: `报告当前为「${REPORT_STATUS[r.status]}」，不可编辑（需审核驳回或回滚至编制中）` }
  const text = String(content || '')
  const ts = now()
  run(`UPDATE crisis_reports SET ${section}=?, ${section}_by=?, ${section}_at=?, updated=? WHERE id=?`,
    text, actor.user, ts, ts, id)
  addLog(id, 'edit', `${SECTIONS[section]}已由 ${actor.user}（${ROLE_TEXT[actor.role] || actor.role}）${text.trim() ? '保存' : '清空'}`, actor)
  return { ok: true }
}

// 手动刷新聚合快照（重新汇总预警/时间线/传播/工单/回执最新数据）
export function refreshSnapshot(id, actor) {
  const r = q1('SELECT * FROM crisis_reports WHERE id=?', id)
  if (!r) return null
  if (r.status !== 'draft') return { error: '仅编制中的报告可刷新聚合数据（送审/发布时会自动冻结）' }
  const ts = now()
  const snap = buildSnapshot(r.crisis_id)
  run('UPDATE crisis_reports SET snapshot=?, snapshotted_at=?, updated=? WHERE id=?', JSON.stringify(snap), ts, ts, id)
  addLog(id, 'snapshot', '手动刷新聚合快照：重新汇总预警/时间线/传播路径/工单/通知回执', actor)
  return { ok: true, snapshot: snap, snapshottedAt: ts }
}

// 归档一个不可变版本（调用方负责事务边界）
function archiveVersionInner(id, kind, note, actor, sourceVersion = 0) {
  const fresh = q1('SELECT * FROM crisis_reports WHERE id=?', id)
  const version = fresh.current_version + 1
  const ts = now()
  run(`INSERT INTO crisis_report_versions (report_id,version,kind,status,title,content,snapshot,operator,note,source_version,created)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    fresh.id, version, kind, fresh.status, fresh.title,
    JSON.stringify(chapterContent(fresh)), fresh.snapshot || '{}', actor.user || '系统', note || '', sourceVersion, ts)
  run('UPDATE crisis_reports SET current_version=? WHERE id=?', version, fresh.id)
  return version
}
function archiveVersion(r, kind, note, actor, sourceVersion = 0) {
  return archiveVersionInner(r.id, kind, note, actor, sourceVersion)
}

// ===== 提交审核：自动冻结快照并归档送审版本（draft → reviewing） =====
export function submitReport(id, body, actor) {
  const r = q1('SELECT * FROM crisis_reports WHERE id=?', id)
  if (!r) return null
  if (r.status !== 'draft') return { error: `仅编制中的报告可提交审核（当前：${REPORT_STATUS[r.status]}）` }
  const note = String(body?.note || '').trim()
  const ts = now()
  const snap = buildSnapshot(r.crisis_id)
  run('UPDATE crisis_reports SET snapshot=?, snapshotted_at=?, status=?, submitted_by=?, submitted_at=?, updated=? WHERE id=?',
    JSON.stringify(snap), ts, 'reviewing', actor.user, ts, ts, id)
  const version = archiveVersion({ id }, 'submit', note, actor)
  addLog(id, 'submit', `提交审核（归档 v${version}）${note ? '：' + note : ''}，等待管理员审核`, actor)
  addTimeline(r.crisis_id, '复盘送审', `复盘报告「${r.title}」提交审核（v${version}，提交人：${actor.user}）`, ts)
  return { ok: true, version }
}

// 审核通过并发布：归档发布版本 + 回写最近结案档案（reviewing → published，admin）
export function approveReport(id, body, actor) {
  const r = q1('SELECT * FROM crisis_reports WHERE id=?', id)
  if (!r) return null
  if (r.status !== 'reviewing') return { error: `仅待审核的报告可审核通过（当前：${REPORT_STATUS[r.status]}）` }
  const note = String(body?.note || '').trim()
  const ts = now()
  // 发布前再次冻结：审核期间业务数据（如工单收尾、回执确认）可能仍有变化
  const snap = buildSnapshot(r.crisis_id)
  run('UPDATE crisis_reports SET snapshot=?, snapshotted_at=?, status=?, reviewed_by=?, reviewed_at=?, published_at=?, updated=? WHERE id=?',
    JSON.stringify(snap), ts, 'published', actor.user, ts, ts, ts, id)
  const version = archiveVersion({ id }, 'publish', note, actor)
  run('UPDATE crisis_reports SET published_version=? WHERE id=?', version, id)
  // 回写最近一次「有效结案档案」（未回滚且未回写报告）：
  //   · 新链路下结案时已冻结当次发布版本，此处不会重复改写；
  //   · 兼容历史结案（先结案后补发布报告）与回滚后重新结案前的补发场景；
  //   · 已回滚档案保持结案时点口径，不再被新发布动作覆盖。
  const closure = q1('SELECT * FROM crisis_closures WHERE crisis_id=? AND rolled_back=0 AND report_id IS NULL ORDER BY id DESC LIMIT 1', r.crisis_id)
  if (closure) run('UPDATE crisis_closures SET report_id=?, report_version=?, report_title=? WHERE id=?', id, version, r.title, closure.id)
  addLog(id, 'approve', `审核通过并发布（归档 v${version}，审核人：${actor.user}）${note ? '：' + note : ''}`, actor)
  addTimeline(r.crisis_id, '复盘发布',
    `复盘报告「${r.title}」审核通过并发布（v${version}）` + (closure ? '，已回写结案档案' : '，结案档案已记录发布版本（历史回滚档案口径保留）'), ts)
  return { ok: true, version, closureId: closure ? closure.id : null }
}

// 审核驳回：回到编制中，保留送审版本归档留痕（reviewing → draft，admin）
export function rejectReport(id, body, actor) {
  const r = q1('SELECT * FROM crisis_reports WHERE id=?', id)
  if (!r) return null
  if (r.status !== 'reviewing') return { error: `仅待审核的报告可驳回（当前：${REPORT_STATUS[r.status]}）` }
  const note = String(body?.note || '').trim() || '审核未通过，请按意见修改后重新提交'
  const ts = now()
  run('UPDATE crisis_reports SET status=?, updated=? WHERE id=?', 'draft', ts, id)
  addLog(id, 'reject', `审核驳回，退回编制中：${note}（审核人：${actor.user}）`, actor)
  addTimeline(r.crisis_id, '复盘驳回', `复盘报告「${r.title}」审核驳回：${note}`, ts)
  return { ok: true }
}

// ===== 版本回滚：把指定归档版本恢复为工作内容，回到编制中并再归档一个回滚版本（admin） =====
export function rollbackReport(id, body, actor) {
  const r = q1('SELECT * FROM crisis_reports WHERE id=?', id)
  if (!r) return null
  if (!['published', 'draft'].includes(r.status)) return { error: '待审核的报告请先审核通过或驳回，再进行版本回滚' }
  const targetVersion = +body?.version
  const v = q1('SELECT * FROM crisis_report_versions WHERE report_id=? AND version=?', id, targetVersion)
  if (!v) return { error: '目标归档版本不存在' }
  const note = String(body?.note || '').trim()
  const content = safeParse(v.content, {})
  const ts = now()
  const wasPublished = r.status === 'published'
  db.exec('BEGIN')
  try {
    for (const f of SECTION_FIELDS) {
      // 恢复内容的最后编辑人标注为回滚操作人（原编辑人在归档版本与操作日志中可溯）
      run(`UPDATE crisis_reports SET ${f}=?, ${f}_by=?, ${f}_at=? WHERE id=?`,
        String(content[f] || ''), `${actor.user}（回滚v${targetVersion}）`, ts, id)
    }
    run('UPDATE crisis_reports SET snapshot=?, snapshotted_at=?, status=?, published_version=0, updated=? WHERE id=?',
      v.snapshot || '{}', ts, 'draft', ts, id)
    const newVersion = archiveVersionInner(id, 'rollback', note || `回滚至 v${targetVersion} 的内容重新编制`, actor, targetVersion)
    if (wasPublished) {
      // 有效结案档案上的回写标记同步撤销（仅未回滚档案：新结案会重新冻结发布版本，重编期间档案不再指向旧版本）；
      // 已回滚的历史档案保留结案时点的报告版本作为历史口径，不做抹除。
      const closure = q1('SELECT * FROM crisis_closures WHERE crisis_id=? AND rolled_back=0 AND report_id=? ORDER BY id DESC LIMIT 1', r.crisis_id, id)
      if (closure) run("UPDATE crisis_closures SET report_id=NULL, report_version=0, report_title=? WHERE id=?", '', closure.id)
      addTimeline(r.crisis_id, '复盘回滚',
        `复盘报告「${r.title}」已发布版本回滚至 v${targetVersion}（新归档 v${newVersion}，操作人：${actor.user}），退回编制中` +
        (closure ? '，有效结案档案回写已撤销（历史回滚档案保留原口径）' : '，历史结案档案保留原发布口径') +
        (note ? '：' + note : ''), ts)
    } else {
      addTimeline(r.crisis_id, '复盘回滚',
        `复盘报告「${r.title}」编制内容回滚至 v${targetVersion}（新归档 v${newVersion}，操作人：${actor.user}）` + (note ? '：' + note : ''), ts)
    }
    addLog(id, 'rollback', `回滚至 v${targetVersion}：归档 v${newVersion}，退回编制中（操作人：${actor.user}）${note ? '：' + note : ''}`, actor)
    db.exec('COMMIT')
    return { ok: true, newVersion, targetVersion, wasPublished }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
}

// 删除危机时级联清理（由 index.js 危机删除链路调用）
export function deleteReportsOfCrisis(crisisId) {
  const ids = q('SELECT id FROM crisis_reports WHERE crisis_id=?', crisisId).map((r) => r.id)
  for (const id of ids) {
    run('DELETE FROM crisis_report_versions WHERE report_id=?', id)
    run('DELETE FROM crisis_report_logs WHERE report_id=?', id)
  }
  run('DELETE FROM crisis_reports WHERE crisis_id=?', crisisId)
  run("UPDATE crisis_closures SET report_id=NULL, report_version=0, report_title='' WHERE crisis_id=?", crisisId)
  return ids.length
}

// 启动补全：种子报告可能无快照（db.js 种子阶段无法复用聚合逻辑），启动时补齐（幂等）
export function ensureSeedSnapshots() {
  let n = 0
  const empty = q("SELECT id FROM crisis_reports WHERE snapshot IS NULL OR snapshot='' OR snapshot='{}'")
  for (const r of empty) {
    const snap = buildSnapshot(r.id ? q1('SELECT crisis_id FROM crisis_reports WHERE id=?', r.id).crisis_id : 0)
    if (!snap) continue
    run('UPDATE crisis_reports SET snapshot=? WHERE id=?', JSON.stringify(snap), r.id)
    n += 1
  }
  return n
}
