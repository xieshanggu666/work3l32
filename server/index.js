import express from 'express'
import { db } from './db.js'
import {
  now, statsSummary, validateItem, ingestPost, addTimeline
} from './pipeline.js'
import {
  JOB_MAX, createJob, getJob, listJobs, resumeJob, pauseJob, recoverInterrupted
} from './import-engine.js'
import {
  actorOf, permit, ROLE_TEXT, CHANNEL_TYPES, TASK_STATUS, CRISIS_STATUS_TEXT,
  listConfig, validateChannel, validateSub, listTasks, getTask,
  pauseTask, resumeTask, retryTask, cancelTask, ackTask, listLogs,
  generateForCrisisStatus, seedNotifyTasks, startScheduler, deleteNotifyOfCrisis, healNotifySourceLinks,
  deleteNotifyOfPropPath
} from './notify.js'
import {
  SOURCE_TYPES, COLLECT_STATUS, listSources, listRuns, validateSource,
  startTask, stopTask, runNowTask, resetCursor,
  startCollectScheduler, resumeCollectTasks
} from './collect.js'
import {
  WO_STATUS, WO_PRIORITY, WO_ROLE, WO_CATEGORY,
  listWorkOrders, getWorkOrder, workOrderLogs, workOrderSummary, workOrderDispatchTrace,
  createWorkOrder, assignWorkOrder, claimWorkOrder, startWorkOrder,
  blockWorkOrder, completeWorkOrder, reworkWorkOrder, cancelWorkOrder,
  startWorkOrderScheduler, bindWorkOrderNotify
} from './workorders.js'
import { generateForWorkOrder, generateForPropEvent, seedPropNotifyTasks, generateForExtSubmission, seedExtNotifyTasks, seedStatementNotifyTasks } from './notify.js'
import { crisisDispatchRollup } from './dispatch.js'
import { bindPipelineProp } from './pipeline.js'
import {
  PROP_STAGE, NODE_KIND, OUTBREAK_HEAT, KOL_FOLLOWERS,
  listProp, getProp, propSummary, createProp, updateProp, bindCrisis,
  attachAlert, detachAlert, addEdge, createPropWorkOrder, markDecline,
  deleteProp, bindPropHooks, onAlertEvent
} from './propagate.js'
import {
  REPORT_STATUS, SECTIONS, listReports, getReport, reportSummary, crisisReportBrief,
  createReport, renameReport, editSection, refreshSnapshot, submitReport,
  approveReport, rejectReport, rollbackReport, deleteReportsOfCrisis, ensureSeedSnapshots
} from './reports.js'
import {
  STMT_STATUS, STMT_PRIORITY, STMT_CHANNELS, CH_STATUS,
  listStatements, getStatement, statementSummary, crisisStatementBrief,
  createStatement, editStatement, submitStatement, approveStatement, rejectStatement,
  startPublishing, registerChannel, retryChannel, cancelChannel, cancelStatement,
  deleteStatementsOfCrisis
} from './statements.js'
import {
  PARTNER_KIND, DOC_TYPE, SUB_STATUS,
  listPartners, createPartner, updatePartner, togglePartner,
  listSubmissions, getSubmission, submissionSummary, crisisSubmissionBrief,
  portalBootstrap, partnerOf, bindPortalNotify, getSubmissionForPartner,
  createSubmission, supplementSubmission, withdrawSubmission,
  receiveSubmission, acceptSubmission, rejectSubmission, bindSubmissionCrisis,
  detachSubmissionsOfCrisis
} from './portal.js'
import { closureReadiness, settleOnClose, restoreOnReopen, serializeSettled } from './closure.js'

const app = express()
app.use(express.json({ limit: '5mb' })) // 大批量导入（上限 5000 条）

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// 启动恢复：崩溃/重启时未完成的导入任务转「已暂停」，保留进度，等待续跑
const recovered = recoverInterrupted()
if (recovered) console.log(`[PUBMON] 恢复 ${recovered} 个中断的批量导入任务（已暂停，可续跑）`)
// 通知编排：为存量未解除预警补生成通知任务（幂等），并启动发送/重试/升级调度器
const seededNotify = seedNotifyTasks()
if (seededNotify) console.log(`[NOTIFY] 为存量未解除预警生成 ${seededNotify} 个通知任务`)
// 升级链来源修复（幂等）：历史回执超时升级任务补齐传播路径/外部协作来源与正确危机归属，并清理孤儿任务
const healedNotify = healNotifySourceLinks()
if (healedNotify.healed || healedNotify.orphanDeleted) {
  console.log(`[NOTIFY] 升级链来源修复：补齐 ${healedNotify.healed} 条任务来源，清理 ${healedNotify.orphanDeleted} 条孤儿任务`)
}
startScheduler()
// 采集调度：运行中的采集任务随服务启动按游标自动接续（不丢不重）
const resumedCollect = resumeCollectTasks()
if (resumedCollect) console.log(`[COLLECT] ${resumedCollect} 个采集任务随启动自动接续（游标续采）`)
startCollectScheduler()
// 协同工单：注入通知联动钩子（分派/改派/认领/超时升级 → 同一调度链路），并启动 SLA 两级升级调度
bindWorkOrderNotify({
  dispatchTasks: (id, event, opts) => {
    if (event === 1 || event === 2) return generateForWorkOrder(id, event)
    return generateForWorkOrder(id, 'created', { event, ...opts })
  }
})
startWorkOrderScheduler()
// 传播路径分析：注入通知编排/工单/预警管线联动钩子，并为存量爆发期路径补生成通知（幂等）
bindPropHooks({
  notify: (pathId, ev, extra) => generateForPropEvent(pathId, ev, extra),
  createWorkOrder: (wo, actor) => createWorkOrder(wo, actor),
  deleteNotify: (pathId) => deleteNotifyOfPropPath(pathId)
})
bindPipelineProp({ onAlertEvent })
const seededProp = seedPropNotifyTasks()
if (seededProp) console.log(`[PROP] 为存量爆发期传播路径生成 ${seededProp} 个通知任务`)
// 复盘报告：为种子报告补齐聚合快照（预警/时间线/传播/工单/回执，幂等）
const seededReportSnap = ensureSeedSnapshots()
if (seededReportSnap) console.log(`[REPORT] 为 ${seededReportSnap} 份复盘报告补齐聚合快照`)
// 外部协作反馈门户：注入通知联动钩子（提交/紧急升级 → 复用通知编排），并为存量紧急待办补生成通知（幂等）
bindPortalNotify({ notifyOnSubmit: (id, isUrgent) => generateForExtSubmission(id, isUrgent) })
const seededExt = seedExtNotifyTasks()
if (seededExt) console.log(`[PORTAL] 为存量紧急外部提交生成 ${seededExt} 个升级通知`)
// 危机声明：为存量「部分渠道失败」声明补生成督办通知（幂等），失败渠道重试/超时升级复用通知调度
const seededStmt = seedStatementNotifyTasks()
if (seededStmt) console.log(`[STMT] 为存量部分渠道失败声明生成 ${seededStmt} 个督办通知`)

// 危机列表（含来源规则、承接规则、未解除预警数、协同工单统计、时间线）
function crisisList(withTimeline = false) {
  const list = q(`SELECT c.*, a.title alert_title,
    (SELECT COUNT(*) FROM alert_events ae WHERE ae.crisis_id=c.id AND ae.status='open') open_events,
    (SELECT COUNT(*) FROM work_orders wo WHERE wo.crisis_id=c.id AND wo.status IN ('todo','doing','blocked')) wo_open,
    (SELECT COUNT(*) FROM work_orders wo WHERE wo.crisis_id=c.id) wo_total,
    (SELECT COUNT(*) FROM prop_paths pp WHERE pp.crisis_id=c.id AND pp.status='active') prop_active,
    (SELECT COUNT(*) FROM prop_paths pp WHERE pp.crisis_id=c.id AND pp.stage='outbreak' AND pp.status='active') prop_outbreak,
    (SELECT COUNT(*) FROM crisis_statements st WHERE st.crisis_id=c.id AND st.status IN ('draft','review','approved','publishing','partial')) stmt_open,
    (SELECT COUNT(*) FROM crisis_statements st WHERE st.crisis_id=c.id) stmt_total,
    (SELECT COUNT(*) FROM crisis_statement_channels sc JOIN crisis_statements st ON st.id=sc.statement_id
      WHERE st.crisis_id=c.id AND sc.status IN ('pending','publishing')) stmt_ch_open,
    (SELECT COUNT(*) FROM crisis_statement_channels sc JOIN crisis_statements st ON st.id=sc.statement_id
      WHERE st.crisis_id=c.id AND sc.status='success') stmt_ch_ok
    FROM crisis c LEFT JOIN alerts a ON a.id=c.alert_id ORDER BY c.id DESC`)
  // 调度链路批量汇总（通知发送/回执/升级 + 工单超时/升级，与工单看板、复盘快照同口径）
  const dispatchMap = crisisDispatchRollup(list.map((c) => c.id))
  return list.map((c) => {
    const rules = q(`SELECT ca.alert_id, ca.is_origin, ca.first_at, ca.last_at, al.title alert_title, al.level alert_level
      FROM crisis_alerts ca LEFT JOIN alerts al ON al.id=ca.alert_id
      WHERE ca.crisis_id=? ORDER BY ca.is_origin DESC, ca.alert_id`, c.id)
    const item = { ...c, rules, dispatch: dispatchMap[c.id] || null }
    item.report = crisisReportBrief(c.id) // 复盘报告状态（编制中/待审核/已发布 + 当前版本）
    item.statement = crisisStatementBrief(c.id) // 最新危机声明状态（危机卡片角标）
    item.extPortal = crisisSubmissionBrief(c.id) // 外部协作门户待审核提交（含紧急数）
    if (withTimeline) item.timeline = q('SELECT * FROM crisis_timeline WHERE crisis_id=? ORDER BY id DESC', c.id)
    return item
  })
}

// ===== 总览 =====
app.get('/api/state', (req, res) => {
  const posts = q('SELECT * FROM posts')
  const hot = q('SELECT * FROM hot_words ORDER BY weight DESC LIMIT 12')
  const activeAlerts = q('SELECT * FROM alerts WHERE active=1')
  const crises = crisisList()
  const sources = q('SELECT s.*, COUNT(p.id) cnt FROM sources s LEFT JOIN posts p ON p.source_id=s.id GROUP BY s.id')
  // 闭环统计：未解除预警 / 在办危机 / 在办与超时工单（与预警中心、危机处置、工单看板同口径，SQL 直查不受列表分页限制）
  const loop = q1(`SELECT
    (SELECT COUNT(*) FROM alert_events WHERE status='open') alertOpen,
    (SELECT COUNT(*) FROM alert_events) alertTotal,
    (SELECT COUNT(*) FROM crisis WHERE status!='closed') crisisActive,
    (SELECT COUNT(*) FROM crisis WHERE status='closed') crisisClosed,
    (SELECT COUNT(*) FROM notify_tasks WHERE status IN ('pending','failed')) notifyOpen,
    (SELECT COUNT(*) FROM notify_tasks WHERE status='acked') notifyAcked,
    (SELECT COUNT(*) FROM notify_tasks WHERE status='escalated') notifyEscalated,
    (SELECT COUNT(*) FROM notify_logs nl JOIN notify_tasks nt ON nt.id=nl.task_id WHERE nl.action='retry') notifyRetries,
    (SELECT COUNT(*) FROM collect_sources WHERE running=1 AND enabled=1) collectRunning,
    (SELECT COUNT(*) FROM work_orders WHERE status IN ('todo','doing','blocked')) workOpen,
    (SELECT COUNT(*) FROM work_orders WHERE status IN ('todo','doing') AND due_at IS NOT NULL AND due_at<?) workOverdue,
    (SELECT COUNT(*) FROM work_orders WHERE escalated>0 AND status IN ('todo','doing','blocked')) workEscalated,
    (SELECT COUNT(*) FROM work_orders WHERE dispatch_state='stalled') workDispatchStalled,
    (SELECT COUNT(*) FROM prop_paths WHERE stage='outbreak' AND status='active') propOutbreak,
    (SELECT COUNT(*) FROM prop_paths WHERE status='active') propActive,
    (SELECT COUNT(*) FROM crisis_reports WHERE status='draft') reportDraft,
    (SELECT COUNT(*) FROM crisis_reports WHERE status='reviewing') reportReviewing,
    (SELECT COUNT(*) FROM crisis_reports WHERE status='published') reportPublished,
    (SELECT COUNT(*) FROM crisis_statements WHERE status='review') stmtReview,
    (SELECT COUNT(*) FROM crisis_statements WHERE status IN ('publishing','partial')) stmtPublishing,
    (SELECT COUNT(*) FROM crisis_statements WHERE status='partial') stmtPartial,
    (SELECT COUNT(*) FROM crisis_statement_channels WHERE status IN ('pending','publishing')) stmtChannelOpen,
    (SELECT COUNT(*) FROM crisis_statement_channels WHERE status='failed') stmtChannelFailed,
    (SELECT COUNT(*) FROM ext_submissions WHERE status='pending') extPending,
    (SELECT COUNT(*) FROM ext_submissions WHERE status='reviewing') extReviewing,
    (SELECT COUNT(*) FROM ext_submissions WHERE is_urgent=1 AND status IN ('pending','reviewing')) extUrgentOpen,
    (SELECT COUNT(*) FROM ext_submissions WHERE status='accepted') extAccepted`, Date.now())
  // 热度趋势（近7时段）
  const nowH = new Date().getHours()
  const trend = []
  for (let i = 6; i >= 0; i--) {
    const seg = nowH - i
    const label = (seg + 24) % 24
    const len = posts.length
    const v = Math.round((len * (0.55 + ((i % 3) * 0.15))) + (Math.sin(i * 1.7) * 6))
    trend.push({ label, value: Math.max(18, v) })
  }
  res.json({
    sources, hotWords: hot, activeAlerts, crises,
    stats: { ...statsSummary(posts), ...loop },
    trend
  })
})

// ===== 舆情列表（支持筛选） =====
app.get('/api/posts', (req, res) => {
  const { sentiment, source, topic, q: kw } = req.query
  let sql = 'SELECT * FROM posts WHERE 1=1'
  const args = []
  if (sentiment && sentiment !== 'all') { args.push(sentiment); sql += ` AND sentiment=?` }
  if (source && source !== 'all') { args.push(+source); sql += ` AND source_id=?` }
  if (topic) { args.push(topic); sql += ` AND topic LIKE ?`; args.push(`%${topic}%`) }
  if (kw) { args.push(`%${kw}%`); args.push(`%${kw}%`); sql += ` AND (title LIKE ? OR content LIKE ?)` }
  sql += ' ORDER BY published DESC'
  res.json(q(sql, ...args))
})
app.get('/api/topics', (req, res) => {
  res.json(db.prepare('SELECT DISTINCT topic FROM posts').all().map((r) => r.topic))
})

// 新增舆情（单条录入，走统一管线，支持可选条目幂等键；响应结构保持不变）
app.post('/api/posts', (req, res) => {
  const err = validateItem(req.body, 0)
  if (err) return res.status(400).json({ error: err })
  const r = ingestPost(req.body, { idemKey: (req.body.idem_key || '').trim() || null })
  if (r.duplicate) {
    const p = q1('SELECT sentiment, heat FROM posts WHERE id=?', r.id)
    return res.json({ ok: true, id: r.id, duplicate: true, sentiment: p?.sentiment, heat: p?.heat, triggered: [] })
  }
  res.json({ ok: true, id: r.id, sentiment: r.sentiment, heat: r.heat, triggered: r.triggered })
})

// ===== 可恢复批量导入任务 =====
function parseFailSeqs(req) {
  // 演练用：请求头 x-sim-fail: "2,5" → 指定条目首轮注入瞬时故障，验证自动重试
  const raw = String(req.headers['x-sim-fail'] || '')
  return raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n))
}
function parseAlwaysFailSeqs(req) {
  // 演练用：x-sim-fail-always → 每轮都失败（验证条目达到上限 → 任务 failed → 手动重试恢复）
  const raw = String(req.headers['x-sim-fail-always'] || '')
  return raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n))
}

// 创建导入任务（任务幂等：同 idem_key 重复提交返回同一任务，不重复执行）
app.post('/api/imports', (req, res) => {
  const items = req.body && req.body.items
  const jobKey = typeof req.body?.idem_key === 'string' ? req.body.idem_key.trim() : ''
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items 不能为空' })
  if (items.length > JOB_MAX) return res.status(400).json({ error: `单次最多导入 ${JOB_MAX} 条` })
  // 创建前整批预校验，任一不合格拒绝建任务（尚未写库）
  const errors = items.map((it, i) => validateItem(it, i)).filter(Boolean)
  if (errors.length) return res.status(400).json({ error: '校验失败，未创建导入任务', details: errors })

  const { job, createdNow } = createJob({ idemKey: jobKey, items, failSeqs: parseFailSeqs(req), alwaysFailSeqs: parseAlwaysFailSeqs(req) })
  if (!createdNow) {
    return res.status(200).json({ ok: true, reused: true, jobId: job.id, job: getJob(job.id) })
  }
  const started = resumeJob(job.id)
  res.status(202).json({ ok: true, jobId: job.id, status: started.status, job: getJob(job.id) })
})

// 任务列表（最近导入）
app.get('/api/imports', (req, res) => res.json({ jobs: listJobs(20) }))

// 任务详情：进度 + 逐条结果回写
app.get('/api/imports/:id', (req, res) => {
  const detail = getJob(+req.params.id)
  if (!detail) return res.status(404).json({ error: '任务不存在' })
  res.json(detail)
})

// 暂停（状态立即落库，当前块跑完后停在断点）
app.post('/api/imports/:id/pause', (req, res) => {
  const job = pauseJob(+req.params.id)
  if (!job) return res.status(404).json({ error: '任务不存在' })
  res.json({ ok: true, job: getJob(job.id) })
})

// 续跑 / 失败重试：pending 继续，failed 条目重置后续跑；幂等键保证不产生重复数据。
// 请求头 x-clear-injection: 1 为演练用——清除持续故障注入，模拟外部依赖恢复后手动重试。
app.post('/api/imports/:id/resume', (req, res) => {
  const job = resumeJob(+req.params.id, { clearInjection: req.headers['x-clear-injection'] === '1' })
  if (!job) return res.status(404).json({ error: '任务不存在' })
  res.json({ ok: true, job: getJob(job.id) })
})

// 旧版整批接口（同步语义保留）：内部改为创建可恢复任务并等待结束，任一失败返回 207 + 逐条结果
app.post('/api/posts/batch', async (req, res) => {
  const items = req.body && req.body.items
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items 不能为空' })
  if (items.length > 200) return res.status(400).json({ error: '单次最多导入 200 条' })
  const errors = items.map((it, i) => validateItem(it, i)).filter(Boolean)
  if (errors.length) return res.status(400).json({ error: '校验失败，未导入任何数据', details: errors })

  const { job } = createJob({ items, failSeqs: parseFailSeqs(req) })
  resumeJob(job.id)
  let detail
  for (let i = 0; i < 6000; i++) { // 最多等待约 2 分钟
    await new Promise((r) => setTimeout(r, 20))
    detail = getJob(job.id)
    if (['done', 'failed'].includes(detail.job.status)) break
  }
  const results = detail.items.map((it) => it.result || { title: it.payload?.title, error: it.error })
  const fired = results.flatMap((r) => r.triggered || [])
  const body = {
    ok: detail.job.status === 'done',
    jobId: detail.job.id,
    imported: detail.job.total_ok,
    duplicates: detail.job.total_duplicate,
    failed: detail.job.total_failed,
    failures: detail.items.filter((it) => it.status === 'failed').map((it) => ({ seq: it.seq, error: it.error })),
    results,
    summary: {
      alerts: fired.length,
      crisesCreated: fired.filter((t) => t.crisisId && !t.deduped).length,
      crisesMerged: fired.filter((t) => t.deduped).length
    },
    stats: statsSummary()
  }
  res.status(detail.job.status === 'done' ? 200 : 207).json(body)
})

// ===== 热门词 =====
app.post('/api/hotwords', (req, res) => {
  const { word, weight, sentiment = 'neutral' } = req.body
  run('INSERT INTO hot_words (word,weight,sentiment) VALUES (?,?,?)', word, weight, sentiment)
  res.json({ ok: true })
})
app.delete('/api/hotwords/:id', (req, res) => {
  run('DELETE FROM hot_words WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// ===== 预警 =====
app.get('/api/alerts', (req, res) => {
  // 未解除计数按规则 SQL 聚合（触发记录列表仅取最近 60 条，计数不能受其限制）
  const openCounts = {}
  for (const r of q("SELECT alert_id, COUNT(*) c FROM alert_events WHERE status='open' GROUP BY alert_id")) openCounts[r.alert_id] = r.c
  res.json({
    alerts: q('SELECT * FROM alerts ORDER BY id DESC'),
    events: q(`SELECT ae.*, p.title pt, p.heat heat, p.sentiment sent, c.title crisis_title
      FROM alert_events ae LEFT JOIN posts p ON p.id=ae.post_id LEFT JOIN crisis c ON c.id=ae.crisis_id
      ORDER BY ae.id DESC LIMIT 60`),
    openCounts
  })
})
app.post('/api/alerts', (req, res) => {
  const { title, level, keyword, sentiment, heat_min, merge_topic, merge_window } = req.body
  run('INSERT INTO alerts (title,level,keyword,sentiment,heat_min,active,created,trigger_count,merge_topic,merge_window) VALUES (?,?,?,?,?,1,?,0,?,?)',
    title, level, keyword || '', sentiment || '', heat_min || 0, now(), (merge_topic || '').trim(), Math.max(0, +merge_window || 0))
  res.json({ ok: true })
})
// 编辑规则（含归并话题/时间窗口变更）：新参数即时作用于后续触发归并；
// 归并参数变更写入关联未结案事件的统一时间线，历史归并保持不变
app.put('/api/alerts/:id', (req, res) => {
  const al = q1('SELECT * FROM alerts WHERE id=?', req.params.id)
  if (!al) return res.status(404).json({ error: 'not found' })
  const b = req.body || {}
  const next = {
    title: typeof b.title === 'string' && b.title.trim() ? b.title.trim() : al.title,
    level: ['red', 'orange', 'yellow'].includes(b.level) ? b.level : al.level,
    keyword: b.keyword !== undefined ? String(b.keyword).trim() : al.keyword,
    sentiment: b.sentiment !== undefined ? String(b.sentiment) : al.sentiment,
    heat_min: b.heat_min !== undefined ? Math.max(0, +b.heat_min || 0) : al.heat_min,
    merge_topic: b.merge_topic !== undefined ? String(b.merge_topic).trim() : al.merge_topic,
    merge_window: b.merge_window !== undefined ? Math.max(0, parseInt(b.merge_window, 10) || 0) : al.merge_window
  }
  run('UPDATE alerts SET title=?,level=?,keyword=?,sentiment=?,heat_min=?,merge_topic=?,merge_window=? WHERE id=?',
    next.title, next.level, next.keyword, next.sentiment, next.heat_min, next.merge_topic, next.merge_window, al.id)
  if (next.merge_topic !== al.merge_topic || next.merge_window !== al.merge_window) {
    const fmtT = (t) => (t ? `「${t}」` : '取舆情话题')
    const fmtW = (w) => (w > 0 ? `${w} 分钟` : '不限')
    const note = `规则「${next.title}」归并参数调整：话题 ${fmtT(al.merge_topic)}→${fmtT(next.merge_topic)}，时间窗口 ${fmtW(al.merge_window)}→${fmtW(next.merge_window)}（后续触发按新参数归并，历史归并保持不变）`
    const linked = q(`SELECT c.id FROM crisis_alerts ca JOIN crisis c ON c.id=ca.crisis_id WHERE ca.alert_id=? AND c.status!='closed'`, al.id)
    for (const c of linked) addTimeline(c.id, '规则变更', note)
  }
  res.json({ ok: true })
})
app.post('/api/alerts/:id/toggle', (req, res) => {
  const al = q1('SELECT * FROM alerts WHERE id=?', req.params.id)
  if (!al) return res.status(404).json({ error: 'not found' })
  run('UPDATE alerts SET active=? WHERE id=?', al.active ? 0 : 1, al.id)
  res.json({ ok: true, active: al.active ? 0 : 1 })
})
app.delete('/api/alerts/:id', (req, res) => {
  // 保留 alert_events 触发记录（危机回溯/历史时间线的一部分），仅解除事件↔规则关联
  run('DELETE FROM crisis_alerts WHERE alert_id=?', req.params.id)
  run('DELETE FROM alerts WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// 解除单条触发记录：幂等（重复解除不重复写时间线），同步危机时间线，返回该危机剩余未解除数
app.post('/api/alert-events/:id/resolve', (req, res) => {
  const ev = q1('SELECT * FROM alert_events WHERE id=?', req.params.id)
  if (!ev) return res.status(404).json({ error: 'not found' })
  const openLeftOf = (cid) => (cid ? q1("SELECT COUNT(*) c FROM alert_events WHERE crisis_id=? AND status='open'", cid).c : 0)
  if (ev.status === 'resolved') {
    // 重复解除：幂等忽略，不回写时间线，返回当前未解除计数
    return res.json({ ok: true, already: true, crisisId: ev.crisis_id, openLeft: openLeftOf(ev.crisis_id) })
  }
  const note = (req.body.note || '').trim() || '风险指标回落，预警解除'
  const ts = now()
  // 状态守卫：并发/重复提交下仅首次生效
  const r = run("UPDATE alert_events SET status='resolved', resolved=?, resolve_kind='manual' WHERE id=? AND status='open'", ts, ev.id)
  if (!Number(r.changes)) return res.json({ ok: true, already: true, crisisId: ev.crisis_id, openLeft: openLeftOf(ev.crisis_id) })
  if (ev.crisis_id) {
    const c = q1('SELECT * FROM crisis WHERE id=?', ev.crisis_id)
    if (c && c.status !== 'closed') {
      const al = q1('SELECT title FROM alerts WHERE id=?', ev.alert_id)
      addTimeline(c.id, '预警解除', al ? `规则「${al.title}」：${note}` : note, ts)
    }
  }
  res.json({ ok: true, crisisId: ev.crisis_id, openLeft: openLeftOf(ev.crisis_id) })
})

// 批量解除某规则全部未解除触发（按危机合并写入时间线；无未解除时幂等返回 0）
app.post('/api/alerts/:id/resolve', (req, res) => {
  const al = q1('SELECT * FROM alerts WHERE id=?', req.params.id)
  if (!al) return res.status(404).json({ error: 'not found' })
  const events = q("SELECT * FROM alert_events WHERE alert_id=? AND status='open'", al.id)
  if (!events.length) return res.json({ ok: true, resolved: 0 })
  const note = (req.body.note || '').trim() || '风险指标回落，批量解除'
  const ts = now()
  const byCrisis = {}
  db.exec('BEGIN')
  try {
    for (const ev of events) {
      run("UPDATE alert_events SET status='resolved', resolved=?, resolve_kind='batch' WHERE id=? AND status='open'", ts, ev.id)
      if (ev.crisis_id) (byCrisis[ev.crisis_id] ||= []).push(ev)
    }
    for (const [cid, evs] of Object.entries(byCrisis)) {
      const c = q1('SELECT * FROM crisis WHERE id=?', cid)
      if (c && c.status !== 'closed') {
        addTimeline(c.id, '预警解除', `规则「${al.title}」：${note}（一并解除 ${evs.length} 条触发记录）`, ts)
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    return res.status(500).json({ error: String(e.message || e) })
  }
  res.json({ ok: true, resolved: events.length })
})

// ===== 危机处置 =====
app.get('/api/crisis', (req, res) => {
  res.json(crisisList(true))
})
app.post('/api/crisis', (req, res) => {
  const { title, level, keyword, topic, plan, analysis, linked_email } = req.body
  const r = run("INSERT INTO crisis (title,level,status,plan,analysis,created,updated,linked_email,keyword,origin,topic,last_trigger_at) VALUES (?,?,?,?,?,?,?,?,?,'manual',?,NULL)",
    title, level || 'orange', 'monitoring', plan || '', analysis || '', now(), now(), linked_email || '', keyword || '', (topic || '').trim())
  const id = Number(r.lastInsertRowid)
  run('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)', id, '事件建档', '人工建档，初始响应', now())
  generateForCrisisStatus(id, 'monitoring') // 通知编排：人工建档进入监测中
  res.json({ ok: true, id })
})
app.post('/api/crisis/:id/status', (req, res) => {
  const { status, action, note } = req.body
  const c = q1('SELECT * FROM crisis WHERE id=?', req.params.id)
  if (!c) return res.status(404).json({ error: 'not found' })
  // 闭环一致性：结案/重开必须走专用链路（级联解除、结案档案、回滚恢复）
  if (status === 'closed') return res.status(400).json({ error: '请使用结案接口（级联解除未解除预警并写入结案档案）' })
  if (c.status === 'closed') return res.status(400).json({ error: '已结案事件请先回滚结案再变更状态' })
  run('UPDATE crisis SET status=? WHERE id=?', status || c.status, c.id)
  addTimeline(c.id, action || '状态更新', note || '')
  if (status && status !== c.status) generateForCrisisStatus(c.id, status) // 通知编排：状态流转
  res.json({ ok: true })
})
app.post('/api/crisis/:id/timeline', (req, res) => {
  const { action, note } = req.body
  addTimeline(req.params.id, action, note || '')
  res.json({ ok: true })
})

// 回溯：危机档案 + 承接规则 + 关联预警触发记录（按规则拆分）+ 统计
app.get('/api/crisis/:id/review', (req, res) => {
  const c = q1('SELECT c.*, a.title alert_title FROM crisis c LEFT JOIN alerts a ON a.id=c.alert_id WHERE c.id=?', req.params.id)
  if (!c) return res.status(404).json({ error: 'not found' })
  const timeline = q('SELECT * FROM crisis_timeline WHERE crisis_id=? ORDER BY id DESC', c.id)
  const events = q(`SELECT ae.*, p.title pt, p.heat, p.sentiment sent, a.title alert_title, a.level alert_level
    FROM alert_events ae LEFT JOIN posts p ON p.id=ae.post_id LEFT JOIN alerts a ON a.id=ae.alert_id
    WHERE ae.crisis_id=? ORDER BY ae.id DESC`, c.id)
  const open = events.filter((e) => e.status === 'open').length
  // 按规则拆分触发统计（同一事件承接多条规则时分别统计）
  const rules = q(`SELECT ca.alert_id, ca.is_origin, ca.first_at, ca.last_at,
      al.title alert_title, al.level alert_level,
      (SELECT COUNT(*) FROM alert_events ae WHERE ae.crisis_id=ca.crisis_id AND ae.alert_id=ca.alert_id) triggers,
      (SELECT COUNT(*) FROM alert_events ae WHERE ae.crisis_id=ca.crisis_id AND ae.alert_id=ca.alert_id AND ae.status='open') open
    FROM crisis_alerts ca LEFT JOIN alerts al ON al.id=ca.alert_id
    WHERE ca.crisis_id=? ORDER BY ca.is_origin DESC, ca.alert_id`, c.id)
  // 结案档案（含已回滚）：回溯面板展示结案/回滚历史
  const closures = q('SELECT * FROM crisis_closures WHERE crisis_id=? ORDER BY id DESC', c.id)
  // 复盘报告回写状态（统计口径同源：已发布版本回写结案档案）
  const reportRow = q1('SELECT id,title,status,current_version,published_version,reviewed_by,published_at FROM crisis_reports WHERE crisis_id=? ORDER BY id DESC LIMIT 1', c.id)
  const report = reportRow ? { ...reportRow, statusText: REPORT_STATUS[reportRow.status] || reportRow.status } : null
  // 统一结案状态守卫：未结案时返回阻塞项与联动收口项，回溯面板据此展示「结案就绪清单」
  const readiness = c.status === 'closed' ? null : closureReadiness(c.id)
  res.json({
    crisis: c, timeline, events, rules, closures, report, readiness,
    stats: {
      triggers: events.length,
      open,
      resolved: events.length - open,
      rules: rules.length,
      posts: new Set(events.map((e) => e.post_id).filter((x) => x != null)).size,
      firstAt: events.length ? events[events.length - 1].time : null,
      lastAt: events.length ? events[0].time : null
    }
  })
})

// 结案就绪检查（统一状态守卫只读快照）：回溯面板/结案按钮据此展示阻塞项与联动收口项
app.get('/api/crisis/:id/closure-readiness', (req, res) => {
  const readiness = closureReadiness(req.params.id)
  if (!readiness) return res.status(404).json({ error: 'not found' })
  res.json(readiness)
})

// 结案：统一状态守卫 + 事务化联动收口（预警解除 / 通知回执链路收口）+ 结案档案，完成闭环（重复结案幂等）
// 守卫（closureReadiness 统一口径）：未完结协同工单 / 未完结危机声明 / 待审核外部协作提交 / 待审核复盘报告 → 拦截；
// 未解除预警与未闭环通知不阻塞，由结案事务级联解除与收口，变更前状态写入档案，回滚时精确恢复。
app.post('/api/crisis/:id/close', (req, res) => {
  const c = q1('SELECT * FROM crisis WHERE id=?', req.params.id)
  if (!c) return res.status(404).json({ error: 'not found' })
  if (c.status === 'closed') return res.json({ ok: true, already: true })
  // 统一状态守卫：聚合工单/声明/外部协作/复盘报告阻塞项（预警与通知在事务中联动收口，不在此拦截）
  const readiness = closureReadiness(c.id)
  if (!readiness.ready) {
    return res.status(400).json({ error: '结案条件未满足', blocks: readiness.blocks })
  }
  const summary = (req.body.summary || '').trim() || '预警解除，舆情回落，完成处置闭环。'
  const ts = now()
  let closureId = null
  let settled = { resolved: 0, ruleNames: [], settledNotify: [] }
  db.exec('BEGIN')
  try {
    // 联动收口：级联解除未解除预警 + 收口未闭环通知任务（在途/失败/暂停/待回执）
    settled = settleOnClose(c.id, ts)
    // 结案档案：记录联动解除清单、通知收口清单与结案前状态，供结案回滚精确恢复
    const cr = run('INSERT INTO crisis_closures (crisis_id,summary,resolved_events,settled_notify,prev_status,closed_at) VALUES (?,?,?,?,?,?)',
      c.id, summary, JSON.stringify(settled.resolvedIds),
      serializeSettled(settled.settledNotify), c.status, ts)
    closureId = Number(cr.lastInsertRowid)
    run("UPDATE crisis SET status='closed' WHERE id=?", c.id)
    // 结案时间线：预警级联解除 + 通知回执链路收口统一留痕（单条口径，与回滚时间线一一对应）
    const parts = [summary]
    if (settled.resolved) {
      parts.push(`（同步解除 ${settled.resolved} 条未解除预警${settled.ruleNames.length ? '：' + settled.ruleNames.join('、') : ''}）`)
    }
    if (settled.settledNotify.length) {
      parts.push(`（统一收口 ${settled.settledNotify.length} 个未闭环通知任务，回滚结案时恢复）`)
    }
    addTimeline(c.id, '事件结案', parts.join(''), ts)
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    return res.status(500).json({ error: String(e.message || e) })
  }
  generateForCrisisStatus(c.id, 'closed') // 通知编排：结案通报（在收口之后生成，不会被结案收口取消）
  res.json({ ok: true, resolved: settled.resolved, settledNotify: settled.settledNotify.length, closureId })
})

// 结案回滚：恢复最近一次未回滚结案联动解除的预警与收口的通知任务、撤销结案通报，事件重回结案前状态
app.post('/api/crisis/:id/reopen', (req, res) => {
  const c = q1('SELECT * FROM crisis WHERE id=?', req.params.id)
  if (!c) return res.status(404).json({ error: 'not found' })
  if (c.status !== 'closed') return res.json({ ok: true, already: true, status: c.status })
  const closure = q1('SELECT * FROM crisis_closures WHERE crisis_id=? AND rolled_back=0 ORDER BY id DESC LIMIT 1', c.id)
  const note = (req.body.note || '').trim()
  const ts = now()
  const ST = { monitoring: '监测中', disposal: '处置中' }
  const backTo = closure && closure.prev_status && closure.prev_status !== 'closed' ? closure.prev_status : 'disposal'
  let restored = 0
  let restoredNotify = 0
  let staleClosed = 0
  db.exec('BEGIN')
  try {
    if (closure) {
      // 联动恢复：预警为未解除；通知任务按档案恢复结案前状态（历史档案无通知清单则跳过，兼容旧数据）
      const r = restoreOnReopen(c.id, closure, ts)
      restored = r.restored
      restoredNotify = r.restoredNotify
      staleClosed = r.staleClosed
      run('UPDATE crisis_closures SET rolled_back=1, rolled_back_at=?, rollback_note=? WHERE id=?', ts, note, closure.id)
      // 复盘报告回写随结案档案回滚一并撤销（已发布报告回到编制中，由报告模块独立管理）
      if (closure.report_id) {
        const rep = q1('SELECT status,title FROM crisis_reports WHERE id=?', closure.report_id)
        run("UPDATE crisis_closures SET report_id=NULL, report_version=0, report_title='' WHERE id=?", closure.id)
        if (rep) addTimeline(c.id, '复盘回滚', `结案档案回滚：已发布复盘报告「${rep.title}」的结案回写已撤销，报告保留可在复盘报告页查阅或回滚重编`, ts)
      }
    }
    run('UPDATE crisis SET status=? WHERE id=?', backTo, c.id)
    const bits = [`结案回滚：事件重回「${ST[backTo] || backTo}」`]
    if (closure) {
      if (restored) bits.push(`恢复 ${restored} 条结案联动解除的预警为未解除`)
      if (restoredNotify) bits.push(`恢复 ${restoredNotify} 个结案收口通知为结案前状态`)
      if (!restored && !restoredNotify) bits.push('无需要恢复的联动项（历史档案或结案时预警/通知均已闭环），仅恢复事件状态')
    } else {
      bits.push('（历史结案无回滚档案，仅恢复状态）')
    }
    if (staleClosed) bits.push(`撤销 ${staleClosed} 个未发送的结案通报`)
    if (note) bits.push(note)
    addTimeline(c.id, '结案回滚', bits.join(' · '), ts)
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    return res.status(500).json({ error: String(e.message || e) })
  }
  generateForCrisisStatus(c.id, backTo) // 通知编排：结案回滚后的状态流转
  res.json({ ok: true, restored, restoredNotify, staleClosed, status: backTo })
})
app.delete('/api/crisis/:id', (req, res) => {
  const cid = +req.params.id
  let notifyClean = { deleted: 0, detached: 0 }
  // 删除前先修复升级链来源（独立事务，幂等）：确保传播/外部协作升级子任务带着正确来源进入级联判定，
  // 否则丢失来源的升级子任务会被误当孤儿删除或错误解除来源归属，造成追踪口径不一致。
  healNotifySourceLinks()
  // 整条删除链路事务化：危机、时间线、结案档案、复盘报告、工单、声明与通知任务级联要么全部生效，要么整体回滚
  db.exec('BEGIN')
  try {
    run('DELETE FROM crisis_alerts WHERE crisis_id=?', cid)
    run('UPDATE alert_events SET crisis_id=NULL WHERE crisis_id=?', cid)
    run('DELETE FROM crisis_timeline WHERE crisis_id=?', cid)
    run('DELETE FROM crisis_closures WHERE crisis_id=?', cid)
    // 复盘报告随事件删除（版本归档与操作留痕一并清理）
    deleteReportsOfCrisis(cid)
    // 通知任务级联（须在工单删除前执行，按工单归属识别任务）：工单链路/危机状态类任务随事件删除，
    // 预警/传播/外部协作类任务仅解除危机引用（来源对象保留）——不留幽灵任务，调度器不再发送，统计同步扣减
    notifyClean = deleteNotifyOfCrisis(cid)
    // 协同工单随事件删除（工单日志一并清理）
    const woIds = q('SELECT id FROM work_orders WHERE crisis_id=?', cid).map((r) => r.id)
    for (const wid of woIds) run('DELETE FROM work_order_logs WHERE wo_id=?', wid)
    run('DELETE FROM work_orders WHERE crisis_id=?', cid)
    // 危机声明随事件删除（分渠道登记与声明留痕一并清理）
    deleteStatementsOfCrisis(cid)
    // 外部协作提交保留（外部方提交的证据/进度是跨主体留痕），仅解除危机与工单引用
    detachSubmissionsOfCrisis(cid)
    // 传播路径保留（沉淀的来源/节点/转发关系不随事件删除），仅解除危机引用
    run('UPDATE prop_paths SET crisis_id=NULL WHERE crisis_id=?', cid)
    run('DELETE FROM crisis WHERE id=?', cid)
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    return res.status(500).json({ error: String(e.message || e) })
  }
  res.json({ ok: true, notify: notifyClean })
})

// ===== 权限守卫（演示）：viewer 只读 / ops 任务操作 / admin 配置 =====
const NEED_TEXT = { admin: '管理员', ops: '值班员' }
function guard(need) {
  return (req, res, next) => {
    const a = permit(req, need)
    if (!a) return res.status(403).json({ error: `权限不足：该操作需要${NEED_TEXT[need] || need}权限（当前：${ROLE_TEXT[actorOf(req).role]}）`, need })
    req.actor = a
    next()
  }
}

// ===== 跨角色危机协同工单 =====
// 权限：viewer 只读 / ops 值班员（拆分·指派·认领·流转·阻塞·完成·回退·取消） / admin 同 ops 且可配置
// 工单看板（含状态/处理人/危机过滤、看板汇总、常量字典）
app.get('/api/work-orders', (req, res) => {
  const items = listWorkOrders({
    status: String(req.query.status || ''),
    crisisId: req.query.crisis_id ? +req.query.crisis_id : null,
    assignee: String(req.query.assignee || ''),
    limit: Math.min(300, +req.query.limit || 200)
  })
  res.json({
    items,
    summary: workOrderSummary(),
    dict: { status: WO_STATUS, priority: WO_PRIORITY, role: WO_ROLE, category: WO_CATEGORY },
    actor: actorOf(req)
  })
})
// 工单详情（含操作日志与统一调度链路：工单动作 + 通知发送/重试/回执归并）
app.get('/api/work-orders/:id', (req, res) => {
  const w = getWorkOrder(+req.params.id)
  if (!w) return res.status(404).json({ error: '工单不存在' })
  res.json({ workOrder: w, logs: workOrderLogs(w.id), trace: workOrderDispatchTrace(w.id) })
})
// 从危机拆分工单（ops+）
app.post('/api/work-orders', guard('ops'), (req, res) => {
  const r = createWorkOrder(req.body, req.actor)
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
// 工单操作统一入口（ops+；服务端状态机守卫，越权/越态返回 400/403）
function woAction(handler) {
  return (req, res) => {
    const r = handler(+req.params.id, req.body || {}, req.actor, req.actor.role)
    if (!r) return res.status(404).json({ error: '工单不存在' })
    if (r.error) return res.status(400).json({ error: r.error })
    res.json(r)
  }
}
app.post('/api/work-orders/:id/assign', guard('ops'), woAction(assignWorkOrder))
app.post('/api/work-orders/:id/claim', guard('ops'), (req, res) => {
  const r = claimWorkOrder(+req.params.id, req.actor, req.actor.role)
  if (!r) return res.status(404).json({ error: '工单不存在' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
app.post('/api/work-orders/:id/start', guard('ops'), woAction(startWorkOrder))
app.post('/api/work-orders/:id/block', guard('ops'), woAction(blockWorkOrder))
app.post('/api/work-orders/:id/complete', guard('ops'), woAction(completeWorkOrder))
app.post('/api/work-orders/:id/rework', guard('ops'), woAction(reworkWorkOrder))
app.post('/api/work-orders/:id/cancel', guard('ops'), woAction(cancelWorkOrder))

// ===== 舆情传播路径分析 =====
// 权限：viewer 只读 / ops 建档·记录转发·关联·阶段操作 / admin 同 ops 且可删除
app.get('/api/prop', (req, res) => {
  res.json({
    items: listProp({
      stage: String(req.query.stage || ''),
      crisisId: req.query.crisis_id ? +req.query.crisis_id : null,
      topic: String(req.query.topic || '')
    }),
    summary: propSummary(),
    dict: { stage: PROP_STAGE, nodeKind: NODE_KIND, outbreakHeat: OUTBREAK_HEAT, kolFollowers: KOL_FOLLOWERS },
    actor: actorOf(req)
  })
})
app.get('/api/prop/:id', (req, res) => {
  const p = getProp(+req.params.id)
  if (!p) return res.status(404).json({ error: '传播路径不存在' })
  res.json({ path: p })
})
app.post('/api/prop', guard('ops'), (req, res) => {
  const r = createProp(req.body, req.actor)
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
app.put('/api/prop/:id', guard('ops'), (req, res) => {
  const r = updateProp(+req.params.id, req.body, req.actor)
  if (!r) return res.status(404).json({ error: '传播路径不存在' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
app.delete('/api/prop/:id', guard('admin'), (req, res) => {
  const r = deleteProp(+req.params.id)
  if (!r) return res.status(404).json({ error: '传播路径不存在' })
  res.json(r)
})
// 关联/解除危机事件
app.post('/api/prop/:id/crisis', guard('ops'), (req, res) => {
  const r = bindCrisis(+req.params.id, req.body.crisis_id || null, req.actor)
  if (!r) return res.status(404).json({ error: '传播路径不存在' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
// 关联/解除预警规则
app.post('/api/prop/:id/alerts', guard('ops'), (req, res) => {
  const r = attachAlert(+req.params.id, +req.body.alert_id, !!req.body.is_origin, req.actor)
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
app.delete('/api/prop/:id/alerts/:alertId', guard('ops'), (req, res) => {
  const r = detachAlert(+req.params.id, +req.params.alertId)
  if (!r) return res.status(404).json({ error: '传播路径不存在' })
  res.json(r)
})
// 记录转发/引用关系（自动 upsert 节点、重算影响阶段、按变化触发通知与爆发自动工单）
app.post('/api/prop/:id/edges', guard('ops'), (req, res) => {
  const r = addEdge(+req.params.id, req.body, req.actor)
  if (!r) return res.status(404).json({ error: '传播路径不存在' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
// 标记回落期
app.post('/api/prop/:id/decline', guard('ops'), (req, res) => {
  const r = markDecline(+req.params.id, (req.body.note || '').trim(), req.actor)
  if (!r) return res.status(404).json({ error: '传播路径不存在' })
  res.json(r)
})
// 手动生成跨角色处置工单
app.post('/api/prop/:id/work-orders', guard('ops'), (req, res) => {
  const r = createPropWorkOrder(+req.params.id, req.body, req.actor)
  if (!r) return res.status(404).json({ error: '传播路径不存在' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json({ ok: true, id: r.id })
})

// ===== 通知中心：多渠道订阅与通知编排 =====
// 权限：viewer 只读 / ops 任务操作（暂停·恢复·重试·回执·取消） / admin 渠道与订阅配置

// 总览：渠道 + 订阅 + 任务计数 + 当前身份（前端据此渲染权限化界面）
app.get('/api/notify/overview', (req, res) => {
  const { channels, subs } = listConfig()
  const counts = {}
  for (const r of q('SELECT status, COUNT(*) c FROM notify_tasks GROUP BY status')) counts[r.status] = r.c
  res.json({
    channels, subs, counts,
    actor: actorOf(req), roles: ROLE_TEXT, channelTypes: CHANNEL_TYPES,
    taskStatus: TASK_STATUS, crisisStatus: CRISIS_STATUS_TEXT
  })
})

// 渠道配置（admin）
app.post('/api/notify/channels', guard('admin'), (req, res) => {
  const err = validateChannel(req.body)
  if (err) return res.status(400).json({ error: err })
  run('INSERT INTO notify_channels (name,type,target,enabled,created,created_by) VALUES (?,?,?,1,?,?)',
    req.body.name.trim(), req.body.type, req.body.target.trim(), now(), req.actor.user)
  res.json({ ok: true })
})
app.put('/api/notify/channels/:id', guard('admin'), (req, res) => {
  const ch = q1('SELECT * FROM notify_channels WHERE id=?', req.params.id)
  if (!ch) return res.status(404).json({ error: '渠道不存在' })
  const b = req.body || {}
  const next = {
    name: typeof b.name === 'string' && b.name.trim() ? b.name.trim() : ch.name,
    type: CHANNEL_TYPES[b.type] ? b.type : ch.type,
    target: typeof b.target === 'string' && b.target.trim() ? b.target.trim() : ch.target
  }
  run('UPDATE notify_channels SET name=?, type=?, target=? WHERE id=?', next.name, next.type, next.target, ch.id)
  res.json({ ok: true })
})
app.post('/api/notify/channels/:id/toggle', guard('admin'), (req, res) => {
  const ch = q1('SELECT * FROM notify_channels WHERE id=?', req.params.id)
  if (!ch) return res.status(404).json({ error: '渠道不存在' })
  run('UPDATE notify_channels SET enabled=? WHERE id=?', ch.enabled ? 0 : 1, ch.id)
  res.json({ ok: true, enabled: ch.enabled ? 0 : 1 })
})
app.delete('/api/notify/channels/:id', guard('admin'), (req, res) => {
  run('DELETE FROM notify_channels WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// 订阅编排（admin）
app.post('/api/notify/subs', guard('admin'), (req, res) => {
  const err = validateSub(req.body)
  if (err) return res.status(400).json({ error: err })
  const b = req.body
  run(`INSERT INTO notify_subs (name,alert_id,topic,crisis_status,levels,channel_ids,require_ack,ack_timeout_min,escalate_channel_id,max_retry,wo_event,prop_event,ext_event,stmt_event,active,created,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
    b.name.trim(), b.alert_id ? +b.alert_id : null, (b.topic || '').trim(), String(b.crisis_status || ''),
    (Array.isArray(b.levels) ? b.levels : []).filter((x) => ['red', 'orange', 'yellow'].includes(x)).join(','),
    JSON.stringify(b.channel_ids.map(Number)), b.require_ack ? 1 : 0,
    Math.max(1, +b.ack_timeout_min || 30), b.escalate_channel_id ? +b.escalate_channel_id : null,
    Math.min(5, Math.max(1, +b.max_retry || 3)), String(b.wo_event || ''), String(b.prop_event || ''), String(b.ext_event || ''), String(b.stmt_event || ''), now(), req.actor.user)
  res.json({ ok: true })
})
app.put('/api/notify/subs/:id', guard('admin'), (req, res) => {
  const s = q1('SELECT * FROM notify_subs WHERE id=?', req.params.id)
  if (!s) return res.status(404).json({ error: '订阅不存在' })
  const err = validateSub(req.body)
  if (err) return res.status(400).json({ error: err })
  const b = req.body
  run(`UPDATE notify_subs SET name=?,alert_id=?,topic=?,crisis_status=?,levels=?,channel_ids=?,require_ack=?,ack_timeout_min=?,escalate_channel_id=?,max_retry=?,wo_event=?,prop_event=?,ext_event=?,stmt_event=? WHERE id=?`,
    b.name.trim(), b.alert_id ? +b.alert_id : null, (b.topic || '').trim(), String(b.crisis_status || ''),
    (Array.isArray(b.levels) ? b.levels : []).filter((x) => ['red', 'orange', 'yellow'].includes(x)).join(','),
    JSON.stringify(b.channel_ids.map(Number)), b.require_ack ? 1 : 0,
    Math.max(1, +b.ack_timeout_min || 30), b.escalate_channel_id ? +b.escalate_channel_id : null,
    Math.min(5, Math.max(1, +b.max_retry || 3)), String(b.wo_event || ''), String(b.prop_event || ''), String(b.ext_event || ''), String(b.stmt_event || ''), s.id)
  res.json({ ok: true })
})
app.post('/api/notify/subs/:id/toggle', guard('admin'), (req, res) => {
  const s = q1('SELECT * FROM notify_subs WHERE id=?', req.params.id)
  if (!s) return res.status(404).json({ error: '订阅不存在' })
  run('UPDATE notify_subs SET active=? WHERE id=?', s.active ? 0 : 1, s.id)
  res.json({ ok: true, active: s.active ? 0 : 1 })
})
app.delete('/api/notify/subs/:id', guard('admin'), (req, res) => {
  run('DELETE FROM notify_subs WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// 任务看板与操作（ops 及以上）
app.get('/api/notify/tasks', (req, res) => {
  res.json(listTasks({ status: String(req.query.status || ''), limit: Math.min(200, +req.query.limit || 100) }))
})
app.get('/api/notify/tasks/:id', (req, res) => {
  const task = getTask(+req.params.id)
  if (!task) return res.status(404).json({ error: '任务不存在' })
  res.json({ task, logs: listLogs({ taskId: task.id, limit: 50 }) })
})
function taskAction(handler) {
  return (req, res) => {
    const r = handler(+req.params.id, req.actor, (req.body && req.body.note || '').trim())
    if (!r) return res.status(404).json({ error: '任务不存在' })
    if (r.error) return res.status(400).json({ error: r.error })
    res.json({ ok: true, already: !!r.already, resolved: r.resolved || 0, crisisId: r.crisisId ?? null, task: r.task })
  }
}
app.post('/api/notify/tasks/:id/pause', guard('ops'), taskAction(pauseTask))
app.post('/api/notify/tasks/:id/resume', guard('ops'), taskAction(resumeTask))
app.post('/api/notify/tasks/:id/retry', guard('ops'), taskAction(retryTask))
app.post('/api/notify/tasks/:id/cancel', guard('ops'), taskAction(cancelTask))
app.post('/api/notify/tasks/:id/ack', guard('ops'), taskAction(ackTask))

// 历史追踪（全部任务或单任务留痕）
app.get('/api/notify/logs', (req, res) => {
  res.json({
    logs: listLogs({
      taskId: req.query.task_id ? +req.query.task_id : null,
      limit: Math.min(200, +req.query.limit || 100)
    })
  })
})

// ===== 数据源接入与采集调度 =====
// 权限：admin 配置数据源连接（含游标归零）；ops 启停采集任务与手动采集；viewer 只读
app.get('/api/collect/overview', (req, res) => {
  const sources = listSources()
  const counts = { running: 0, retrying: 0, stopped: 0, failed: 0, disabled: 0 }
  for (const s of sources) counts[s.task_status] = (counts[s.task_status] || 0) + 1
  const totals = q1(`SELECT COALESCE(SUM(total_runs),0) runs, COALESCE(SUM(total_inserted),0) inserted,
    COALESCE(SUM(total_duplicated),0) duplicated FROM collect_sources`)
  res.json({
    sources, counts, totals,
    runs: listRuns({ limit: 30 }),
    actor: actorOf(req), roles: ROLE_TEXT,
    sourceTypes: SOURCE_TYPES, collectStatus: COLLECT_STATUS,
    channels: q('SELECT id,name FROM sources ORDER BY id')
  })
})

// 数据源连接配置（admin）
app.post('/api/collect/sources', guard('admin'), (req, res) => {
  const err = validateSource(req.body)
  if (err) return res.status(400).json({ error: err })
  const b = req.body
  run(`INSERT INTO collect_sources (name,type,endpoint,source_id,topic,media,interval_sec,batch_size,max_retry,enabled,running,created,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,1,0,?,?)`,
    b.name.trim(), b.type, b.endpoint.trim(), +b.source_id, (b.topic || '').trim(), (b.media || '').trim(),
    Math.max(5, +b.interval_sec || 15), Math.min(50, Math.max(1, +b.batch_size || 5)),
    Math.min(10, Math.max(1, +b.max_retry || 5)), now(), req.actor.user)
  res.json({ ok: true })
})
app.put('/api/collect/sources/:id', guard('admin'), (req, res) => {
  const s = q1('SELECT * FROM collect_sources WHERE id=?', req.params.id)
  if (!s) return res.status(404).json({ error: '数据源不存在' })
  const err = validateSource(req.body)
  if (err) return res.status(400).json({ error: err })
  const b = req.body
  run(`UPDATE collect_sources SET name=?,type=?,endpoint=?,source_id=?,topic=?,media=?,interval_sec=?,batch_size=?,max_retry=? WHERE id=?`,
    b.name.trim(), b.type, b.endpoint.trim(), +b.source_id, (b.topic || '').trim(), (b.media || '').trim(),
    Math.max(5, +b.interval_sec || 15), Math.min(50, Math.max(1, +b.batch_size || 5)),
    Math.min(10, Math.max(1, +b.max_retry || 5)), s.id)
  res.json({ ok: true })
})
// 连接启停（admin）：停用连接同时停止其采集任务
app.post('/api/collect/sources/:id/toggle', guard('admin'), (req, res) => {
  const s = q1('SELECT * FROM collect_sources WHERE id=?', req.params.id)
  if (!s) return res.status(404).json({ error: '数据源不存在' })
  const next = s.enabled ? 0 : 1
  run('UPDATE collect_sources SET enabled=?, running=CASE WHEN ?=0 THEN 0 ELSE running END WHERE id=?', next, next, s.id)
  res.json({ ok: true, enabled: next })
})
app.delete('/api/collect/sources/:id', guard('admin'), (req, res) => {
  run('DELETE FROM collect_sources WHERE id=?', req.params.id) // 采集记录保留（历史留痕）
  res.json({ ok: true })
})

// 采集任务启停与手动采集（ops）：启动即到期立即采一轮；停止后调度器跳过
app.post('/api/collect/tasks/:id/start', guard('ops'), (req, res) => {
  const r = startTask(+req.params.id)
  if (!r) return res.status(404).json({ error: '数据源不存在' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json({ ok: true, already: !!r.already })
})
app.post('/api/collect/tasks/:id/stop', guard('ops'), (req, res) => {
  const r = stopTask(+req.params.id)
  if (!r) return res.status(404).json({ error: '数据源不存在' })
  res.json({ ok: true, already: !!r.already })
})
app.post('/api/collect/tasks/:id/run', guard('ops'), (req, res) => {
  const r = runNowTask(+req.params.id, req.actor.user)
  if (!r) return res.status(404).json({ error: '数据源不存在' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json({ ok: true, result: r.result })
})
// 游标归零（admin）：重新采集历史条目，幂等键自动去重
app.post('/api/collect/tasks/:id/reset-cursor', guard('admin'), (req, res) => {
  const r = resetCursor(+req.params.id)
  if (!r) return res.status(404).json({ error: '数据源不存在' })
  res.json({ ok: true })
})

// 采集记录（可按数据源过滤）
app.get('/api/collect/runs', (req, res) => {
  res.json({
    runs: listRuns({
      sourceId: req.query.source_id ? +req.query.source_id : null,
      limit: Math.min(200, +req.query.limit || 50)
    })
  })
})

// ===== 危机复盘报告 =====
// 权限：viewer 只读 / ops 编制·分段保存·刷新快照·送审 / admin 同 ops 且可审核（通过/驳回）与版本回滚
// 报告看板（状态/危机过滤 + 汇总 + 章节与状态字典）
app.get('/api/reports', (req, res) => {
  res.json({
    items: listReports({
      status: String(req.query.status || ''),
      crisisId: req.query.crisis_id ? +req.query.crisis_id : null
    }),
    summary: reportSummary(),
    dict: { status: REPORT_STATUS, sections: SECTIONS, roles: ROLE_TEXT },
    actor: actorOf(req)
  })
})
// 报告详情（含聚合快照、归档版本、操作留痕）
app.get('/api/reports/:id', (req, res) => {
  const r = getReport(+req.params.id)
  if (!r) return res.status(404).json({ error: '复盘报告不存在' })
  res.json({ report: r })
})
// 创建报告（一个危机一份；建档即冻结首版聚合快照）
app.post('/api/reports', guard('ops'), (req, res) => {
  const r = createReport(req.body, req.actor)
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
// 修改标题（编制中）
app.put('/api/reports/:id', guard('ops'), (req, res) => {
  const r = renameReport(+req.params.id, req.body, req.actor)
  if (!r) return res.status(404).json({ error: '复盘报告不存在' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
// 跨角色分段编制：保存单章节（记录章节最后编辑人）
app.put('/api/reports/:id/sections/:section', guard('ops'), (req, res) => {
  const r = editSection(+req.params.id, req.params.section, req.body?.content, req.actor)
  if (!r) return res.status(404).json({ error: '复盘报告不存在' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
// 手动刷新聚合快照（重新汇总预警/时间线/传播/工单/回执）
app.post('/api/reports/:id/snapshot', guard('ops'), (req, res) => {
  const r = refreshSnapshot(+req.params.id, req.actor)
  if (!r) return res.status(404).json({ error: '复盘报告不存在' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
// 提交审核（冻结快照 + 归档送审版本）
app.post('/api/reports/:id/submit', guard('ops'), (req, res) => {
  const r = submitReport(+req.params.id, req.body, req.actor)
  if (!r) return res.status(404).json({ error: '复盘报告不存在' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
// 审核通过并发布（归档发布版本 + 回写结案档案与统计口径，仅 admin）
app.post('/api/reports/:id/approve', guard('admin'), (req, res) => {
  const r = approveReport(+req.params.id, req.body, req.actor)
  if (!r) return res.status(404).json({ error: '复盘报告不存在' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
// 审核驳回（退回编制中，仅 admin）
app.post('/api/reports/:id/reject', guard('admin'), (req, res) => {
  const r = rejectReport(+req.params.id, req.body, req.actor)
  if (!r) return res.status(404).json({ error: '复盘报告不存在' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
// 版本回滚（恢复归档版本内容、回退编制中、再归档回滚版本，仅 admin）
app.post('/api/reports/:id/rollback', guard('admin'), (req, res) => {
  const r = rollbackReport(+req.params.id, req.body, req.actor)
  if (!r) return res.status(404).json({ error: '复盘报告不存在' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})

// ===== 危机声明（公关起草 → 法务审核 → 分渠道发布执行与结果登记） =====
// 权限：viewer 只读 / ops 起草·送审·发起发布·渠道执行登记·取消 / admin 同 ops 且独占法务审核（通过/驳回）
// 声明看板（状态/危机过滤 + 汇总 + 渠道与状态字典）
app.get('/api/statements', (req, res) => {
  res.json({
    items: listStatements({
      status: String(req.query.status || ''),
      crisisId: req.query.crisis_id ? +req.query.crisis_id : null
    }),
    summary: statementSummary(),
    dict: { status: STMT_STATUS, priority: STMT_PRIORITY, channels: STMT_CHANNELS, channelStatus: CH_STATUS },
    actor: actorOf(req)
  })
})
// 声明详情（含分渠道登记与全程留痕）
app.get('/api/statements/:id', (req, res) => {
  const s = getStatement(+req.params.id)
  if (!s) return res.status(404).json({ error: '危机声明不存在' })
  res.json({ statement: s })
})
// 起草声明（ops+，可关联处置工单）
app.post('/api/statements', guard('ops'), (req, res) => {
  const r = createStatement(req.body, req.actor)
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
// 编辑声明（起草中；驳回退回后可修改）
app.put('/api/statements/:id', guard('ops'), (req, res) => {
  const r = editStatement(+req.params.id, req.body, req.actor)
  if (!r) return res.status(404).json({ error: '危机声明不存在' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
// 提交法务审核
app.post('/api/statements/:id/submit', guard('ops'), (req, res) => {
  const r = submitStatement(+req.params.id, req.body, req.actor)
  if (!r) return res.status(404).json({ error: '危机声明不存在' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
// 法务审核通过（仅 admin：演示中法务由管理员角色承担）
app.post('/api/statements/:id/approve', guard('admin'), (req, res) => {
  const r = approveStatement(+req.params.id, req.body, req.actor)
  if (!r) return res.status(404).json({ error: '危机声明不存在' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
// 法务审核驳回（仅 admin）
app.post('/api/statements/:id/reject', guard('admin'), (req, res) => {
  const r = rejectStatement(+req.params.id, req.body, req.actor)
  if (!r) return res.status(404).json({ error: '危机声明不存在' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
// 发起分渠道发布（审核通过 → 发布中；落渠道执行行）
app.post('/api/statements/:id/publish', guard('ops'), (req, res) => {
  const r = startPublishing(+req.params.id, req.body, req.actor)
  if (!r) return res.status(404).json({ error: '危机声明不存在' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
// 取消整份声明
app.post('/api/statements/:id/cancel', guard('ops'), (req, res) => {
  const r = cancelStatement(+req.params.id, req.body, req.actor)
  if (!r) return res.status(404).json({ error: '危机声明不存在' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
function stmtChannelAction(handler) {
  return (req, res) => {
    const r = handler(+req.params.chId, req.body || {}, req.actor)
    if (!r) return res.status(404).json({ error: '发布渠道记录不存在' })
    if (r.error) return res.status(400).json({ error: r.error })
    res.json(r)
  }
}
// 登记渠道执行结果（执行中/成功/失败，发布人员分渠道登记）
app.post('/api/statement-channels/:chId/register', guard('ops'), stmtChannelAction(registerChannel))
// 失败渠道重试
app.post('/api/statement-channels/:chId/retry', guard('ops'), stmtChannelAction(retryChannel))
// 取消单个渠道
app.post('/api/statement-channels/:chId/cancel', guard('ops'), stmtChannelAction(cancelChannel))

// ===== 外部协作反馈门户 =====
// 外部接口：协作方凭门户口令（x-access-code）提交证据/整改进度、查看本人提交与审核结果
// 内部接口：viewer 只读 / ops 受理·补挂 / admin 协作方管理 + 审核采纳/驳回
//
// ---------- 外部门户（口令鉴权） ----------
// 门户首页：协作方信息、可关联的未结案危机、本人历史提交与审核结果
app.get('/api/portal/bootstrap', (req, res) => {
  const partner = partnerOf(req)
  if (!partner) return res.status(401).json({ error: '门户口令无效或协作方已停用，请在门户页选择协作方身份' })
  res.json(portalBootstrap(partner))
})
// 提交证据/整改进度（关联未结案危机；紧急提交联动通知升级）
app.post('/api/portal/submissions', (req, res) => {
  const partner = partnerOf(req)
  if (!partner) return res.status(401).json({ error: '门户口令无效或协作方已停用' })
  const r = createSubmission(req.body, partner)
  if (r.error) return res.status(400).json({ error: r.error })
  res.status(201).json(r)
})
// 查看本人单条提交（含审核意见、驳回原因与留痕）
app.get('/api/portal/submissions/:id', (req, res) => {
  const partner = partnerOf(req)
  if (!partner) return res.status(401).json({ error: '门户口令无效或协作方已停用' })
  const s = getSubmissionForPartner(+req.params.id, partner.id)
  if (!s) return res.status(404).json({ error: '提交不存在或无权查看' })
  res.json({ submission: s })
})
// 补充材料（待审核/受理中/已驳回可补充）
app.post('/api/portal/submissions/:id/supplement', (req, res) => {
  const partner = partnerOf(req)
  if (!partner) return res.status(401).json({ error: '门户口令无效或协作方已停用' })
  const r = supplementSubmission(+req.params.id, req.body, partner)
  if (!r) return res.status(404).json({ error: '提交不存在或无权操作' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
// 主动撤回（未采纳前）
app.post('/api/portal/submissions/:id/withdraw', (req, res) => {
  const partner = partnerOf(req)
  if (!partner) return res.status(401).json({ error: '门户口令无效或协作方已停用' })
  const r = withdrawSubmission(+req.params.id, req.body, partner)
  if (!r) return res.status(404).json({ error: '提交不存在或无权操作' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})

// ---------- 内部审核看板（内部权限模型） ----------
app.get('/api/ext-partners', (req, res) => {
  res.json({ items: listPartners(), dict: { kind: PARTNER_KIND } })
})
app.post('/api/ext-partners', guard('admin'), (req, res) => {
  const r = createPartner(req.body, req.actor)
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
app.put('/api/ext-partners/:id', guard('admin'), (req, res) => {
  const r = updatePartner(+req.params.id, req.body)
  if (!r) return res.status(404).json({ error: '协作方不存在' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
app.post('/api/ext-partners/:id/toggle', guard('admin'), (req, res) => {
  const r = togglePartner(+req.params.id)
  if (!r) return res.status(404).json({ error: '协作方不存在' })
  res.json(r)
})
// 提交看板（状态/危机/协作方类型过滤 + 汇总 + 字典）
app.get('/api/ext-submissions', (req, res) => {
  res.json({
    items: listSubmissions({
      status: String(req.query.status || ''),
      crisisId: req.query.crisis_id ? +req.query.crisis_id : null,
      kind: String(req.query.kind || ''),
      partnerId: req.query.partner_id ? +req.query.partner_id : null
    }),
    summary: submissionSummary(),
    dict: { status: SUB_STATUS, kind: PARTNER_KIND, docType: DOC_TYPE },
    actor: actorOf(req)
  })
})
app.get('/api/ext-submissions/:id', (req, res) => {
  const s = getSubmission(+req.params.id)
  if (!s) return res.status(404).json({ error: '外部提交不存在' })
  res.json({ submission: s })
})
// 受理（ops+）
app.post('/api/ext-submissions/:id/receive', guard('ops'), (req, res) => {
  const r = receiveSubmission(+req.params.id, req.actor)
  if (!r) return res.status(404).json({ error: '外部提交不存在' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
// 审核采纳（admin；回写工单 + 联动解除预警 + 危机时间线）
app.post('/api/ext-submissions/:id/accept', guard('admin'), (req, res) => {
  const r = acceptSubmission(+req.params.id, req.body, req.actor)
  if (!r) return res.status(404).json({ error: '外部提交不存在' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
// 审核驳回（admin；驳回原因外部门户可见）
app.post('/api/ext-submissions/:id/reject', guard('admin'), (req, res) => {
  const r = rejectSubmission(+req.params.id, req.body, req.actor)
  if (!r) return res.status(404).json({ error: '外部提交不存在' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})
// 内部补挂/改挂危机（ops+）
app.post('/api/ext-submissions/:id/crisis', guard('ops'), (req, res) => {
  const r = bindSubmissionCrisis(+req.params.id, req.body, req.actor)
  if (!r) return res.status(404).json({ error: '外部提交不存在' })
  if (r.error) return res.status(400).json({ error: r.error })
  res.json(r)
})

const PORT = Number(process.env.PORT) || 4130
app.listen(PORT, () => console.log(`[PUBMON] API running at http://localhost:${PORT}`))
