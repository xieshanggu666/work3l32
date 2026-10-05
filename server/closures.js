// ===== 危机结案闭环（统一状态守卫 + 联动中止/解除 + 回滚恢复） =====
// 所有结案/回滚动作经此模块，保证口径唯一：
//   ① 统一守卫：未完结协同工单、未完结危机声明、待审核外部协作提交、未发布复盘报告——四类硬阻断；
//      未解除预警与在途通知任务不阻断（前者级联解除、后者联动中止并留档，回滚精确恢复）。
//   ② 联动：结案级联解除预警（resolve_kind=close）、中止该事件全部在途通知任务（待回执不再催办/超时升级），
//      守卫快照与中止清单冻结进结案档案；结案通报在事务提交后生成。
//   ③ 回滚：按档案精确恢复预警与通知任务状态（含回执超时倒计时），事件重回结案前状态；
//      历史结案档案（无中止清单/守卫快照）同样可回滚，仅恢复状态与预警。
import { db } from './db.js'
import { now, addTimeline } from './pipeline.js'
import { REPORT_STATUS } from './reports.js'
import { recomputeWorkOrderState } from './dispatch.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

const ST_TEXT = { monitoring: '监测中', disposal: '处置中', closed: '已结案' }

// 该事件在途（结案须联动中止）通知任务状态：
// pending 待发送 / failed 发送失败可重试 / paused 已暂停 / sent 已发送待回执 / escalated 已升级待回执
const INFLIGHT_SQL = "('pending','failed','paused','sent','escalated')"

// ===== 统一状态守卫：返回阻断项与级联项快照（结案按钮清单/结案接口/回滚后复检同源） =====
export function closureReadiness(crisisId) {
  const c = q1('SELECT * FROM crisis WHERE id=?', crisisId)
  if (!c) return null

  const openWorkOrders = q(
    "SELECT id,title,status,assignee FROM work_orders WHERE crisis_id=? AND status IN ('todo','doing','blocked') ORDER BY id",
    crisisId)
  const openStatements = q(
    "SELECT id,title,status FROM crisis_statements WHERE crisis_id=? AND status IN ('draft','review','approved','publishing','partial') ORDER BY id",
    crisisId)
  const openSubmissions = q(
    "SELECT id,code,title,status,is_urgent,kind FROM ext_submissions WHERE crisis_id=? AND status IN ('pending','reviewing') ORDER BY is_urgent DESC, id",
    crisisId)
  const openAlerts = q("SELECT id,alert_id FROM alert_events WHERE crisis_id=? AND status='open'", crisisId)
  const inflightTasks = q(
    `SELECT id,title,status,kind,require_ack,work_order_id,escalated_from FROM notify_tasks
     WHERE crisis_id=? AND status IN ${INFLIGHT_SQL} ORDER BY id`,
    crisisId)
  const report = q1(
    'SELECT id,title,status,current_version,published_version FROM crisis_reports WHERE crisis_id=? ORDER BY id DESC LIMIT 1',
    crisisId)

  const blockers = []
  if (openWorkOrders.length) blockers.push({ key: 'workorder', label: '未完结协同工单', count: openWorkOrders.length })
  if (openStatements.length) blockers.push({ key: 'statement', label: '未完结危机声明', count: openStatements.length })
  if (openSubmissions.length) blockers.push({ key: 'external', label: '待审核外部协作提交', count: openSubmissions.length })
  if (!report || report.status !== 'published') blockers.push({ key: 'report', label: '复盘报告未发布', count: 1 })

  return {
    crisisId,
    status: c.status,
    ready: c.status !== 'closed' && blockers.length === 0,
    blockers,
    workOrders: openWorkOrders,
    statements: openStatements,
    submissions: openSubmissions,
    openAlerts,
    inflightTasks,
    report: report
      ? { id: report.id, title: report.title, status: report.status, statusText: REPORT_STATUS[report.status] || report.status,
          version: report.current_version, publishedVersion: report.published_version }
      : null,
    cascades: { alerts: openAlerts.length, tasks: inflightTasks.length }
  }
}

// 阻断项的可读错误文案（与守卫快照同源）
export function blockerError(rd) {
  const parts = rd.blockers.map((b) => {
    if (b.key === 'workorder') return `${b.count} 个未完结协同工单（待分派/处理中/已阻塞，请先完成或取消）`
    if (b.key === 'statement') return `${b.count} 份未完结危机声明（起草/待审/发布中/部分渠道失败，请先完成发布或取消）`
    if (b.key === 'external') return `${b.count} 条待审核外部协作提交（待审核/受理中，请先受理后采纳、驳回或由提交方撤回）`
    return '复盘报告尚未审核发布（请完成跨角色编制并由管理员审核通过后再结案）'
  })
  return '结案统一守卫未通过：' + parts.join('；')
}

// 通知留痕 + 工单日志镜像（与 notify.addLog 同口径，避免跨模块事务边界问题，不触发链路重算）
function logTask(taskId, action, detail, operator = '系统') {
  const ts = now()
  run('INSERT INTO notify_logs (task_id,action,detail,operator,time) VALUES (?,?,?,?,?)', taskId, action, detail || '', operator, ts)
  const t = q1('SELECT work_order_id FROM notify_tasks WHERE id=?', taskId)
  if (t && t.work_order_id) {
    run('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time,notify_task_id,wo_event) VALUES (?,?,?,?,?,?,?,?)',
      t.work_order_id, 'notify_cancelled', detail || '', operator, '', ts, taskId, 'notify_cancel')
  }
  return ts
}

// ===== 结案：统一守卫 → 事务化档案 + 级联解除预警 + 联动中止通知任务 =====
// 返回 { ok, closureId, resolved, cancelled }；未通过守卫返回 { error }
export function closeCrisis(crisisId, rawSummary = '') {
  const c = q1('SELECT * FROM crisis WHERE id=?', crisisId)
  if (!c) return { error: 'not found' }
  if (c.status === 'closed') return { ok: true, already: true }
  const rd = closureReadiness(crisisId)
  if (!rd.ready) return { error: blockerError(rd), readiness: rd }

  const summary = (rawSummary || '').trim() || '预警解除，舆情回落，完成处置闭环。'
  const ts = now()
  const opens = q("SELECT * FROM alert_events WHERE crisis_id=? AND status='open'", crisisId)
  // 在途通知任务全量快照：回滚时按快照逐字段恢复（状态机之外的中止，不删任务、不断链路）
  const tasks = q(`SELECT * FROM notify_tasks WHERE crisis_id=? AND status IN ${INFLIGHT_SQL}`, crisisId)
  const taskSnapshots = tasks.map((t) => ({
    id: t.id,
    status: t.status,
    require_ack: t.require_ack,
    escalate_at: t.escalate_at ?? null,
    next_retry_at: t.next_retry_at ?? null,
    work_order_id: t.work_order_id ?? null
  }))
  // 守卫快照（冻结结案时点的全量口径，回溯面板展示，与历史空快照档案区分）
  const guardSnapshot = {
    closedAt: ts,
    prevStatus: c.status,
    workOrders: { open: rd.workOrders.length },
    statements: { open: rd.statements.length },
    submissions: { open: rd.submissions.length },
    alerts: { open: opens.length, resolved: opens.length },
    notifyTasks: { inflight: tasks.length, cancelled: tasks.length },
    report: rd.report ? { id: rd.report.id, title: rd.report.title, version: rd.report.publishedVersion || rd.report.version } : null
  }
  let closureId = null
  db.exec('BEGIN')
  try {
    // ① 级联解除未解除预警（横跨多条规则；状态守卫幂等）
    for (const ev of opens) {
      run("UPDATE alert_events SET status='resolved', resolved=?, resolve_kind='close' WHERE id=? AND status='open'", ts, ev.id)
    }
    // ② 联动中止在途通知任务：待发送不再发送、待回执不再催办/超时升级；任务与留痕保留可审计
    for (const t of tasks) {
      const reason = t.work_order_id
        ? `危机 #${crisisId} 结案：处置闭环，在途协同通知统一中止`
        : `危机 #${crisisId} 结案：事件已闭环，在途通知统一中止（回滚结案可恢复）`
      run(`UPDATE notify_tasks SET status='cancelled', updated=? WHERE id=? AND status IN ${INFLIGHT_SQL}`,
        ts, t.id)
      logTask(t.id, 'cancelled', reason, '系统')
    }
    // ③ 结案档案（统一守卫快照 + 解除清单 + 中止清单 + 结案前状态）
    const cr = run(`INSERT INTO crisis_closures
      (crisis_id,summary,resolved_events,cancelled_tasks,guard_snapshot,report_id,report_version,report_title,prev_status,closed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      crisisId, summary, JSON.stringify(opens.map((e) => e.id)), JSON.stringify(taskSnapshots), JSON.stringify(guardSnapshot),
      rd.report ? rd.report.id : null, rd.report ? (rd.report.publishedVersion || rd.report.version) : 0,
      rd.report ? rd.report.title : '', c.status, ts)
    closureId = Number(cr.lastInsertRowid)
    // ④ 事件置结案 + 统一时间线
    run("UPDATE crisis SET status='closed' WHERE id=?", crisisId)
    const ruleNames = [...new Set(opens.map((e) => e.alert_id))].map((rid) => {
      const al = q1('SELECT title FROM alerts WHERE id=?', rid)
      return al ? `「${al.title}」` : '已删除规则'
    })
    const bits = [summary]
    if (opens.length) bits.push(`同步解除 ${opens.length} 条未解除预警${ruleNames.length ? '：' + ruleNames.join('、') : ''}`)
    if (tasks.length) bits.push(`联动中止 ${tasks.length} 条在途通知任务（回滚结案可恢复）`)
    if (rd.report) bits.push(`复盘报告「${rd.report.title}」已发布（v${rd.report.publishedVersion || rd.report.version}）`)
    addTimeline(crisisId, '事件结案', bits.join('（'), ts)
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  // 工单通知链路状态重算（在事务外，幂等聚合；无关联工单为空操作）
  for (const woId of [...new Set(taskSnapshots.map((t) => t.work_order_id).filter((x) => x != null))]) {
    recomputeWorkOrderState(woId)
  }
  return { ok: true, closureId, resolved: opens.length, cancelled: tasks.length }
}

// ===== 结案回滚：按档案恢复预警 + 恢复被中止的通知任务，事件重回结案前状态 =====
// 返回 { ok, restored, restoredTasks, status }；历史无档案结案仅恢复状态
export function reopenCrisis(crisisId, rawNote = '') {
  const c = q1('SELECT * FROM crisis WHERE id=?', crisisId)
  if (!c) return { error: 'not found' }
  if (c.status !== 'closed') return { ok: true, already: true, status: c.status }
  const closure = q1('SELECT * FROM crisis_closures WHERE crisis_id=? AND rolled_back=0 ORDER BY id DESC LIMIT 1', crisisId)
  const note = (rawNote || '').trim()
  const ts = now()
  const backTo = closure && closure.prev_status && closure.prev_status !== 'closed' ? closure.prev_status : 'disposal'

  let eventIds = []
  let taskSnapshots = []
  if (closure) {
    try { eventIds = JSON.parse(closure.resolved_events || '[]') } catch { eventIds = [] }
    try { taskSnapshots = JSON.parse(closure.cancelled_tasks || '[]') } catch { taskSnapshots = [] }
  }

  let restored = 0
  const restoredTasks = []
  db.exec('BEGIN')
  try {
    if (closure) {
      // ① 恢复结案联动解除的预警（仅恢复仍处解除态的，幂等；其他途径的后续解除不回退）
      for (const id of eventIds) {
        const r = run("UPDATE alert_events SET status='open', resolved=NULL, resolve_kind='' WHERE id=? AND status='resolved'", id)
        if (Number(r.changes)) restored += 1
      }
      // ② 恢复被结案中止的通知任务：按快照还原状态；待回执任务重新武装超时升级倒计时
      for (const snap of taskSnapshots) {
        const t = q1('SELECT * FROM notify_tasks WHERE id=?', snap.id)
        if (!t || t.status !== 'cancelled') continue // 已被删除/其他链路处理的任务跳过（幂等）
        const prevStatus = ['pending', 'failed', 'paused', 'sent', 'escalated'].includes(snap.status) ? snap.status : 'pending'
        let escAt = null
        if (prevStatus === 'sent' && t.require_ack) {
          // 重开后按订阅回执超时重新计时（原倒计时已随结案失效）
          const sub = t.sub_id ? q1('SELECT ack_timeout_min FROM notify_subs WHERE id=?', t.sub_id) : null
          const timeoutMin = Math.max(1, (sub && sub.ack_timeout_min) || 30)
          escAt = Date.now() + timeoutMin * 60000
        }
        run(`UPDATE notify_tasks SET status=?, escalate_at=?, updated=? WHERE id=? AND status='cancelled'`,
          prevStatus, escAt, ts, t.id)
        logTask(t.id, 'resumed',
          `危机 #${crisisId} 结案回滚：通知任务恢复为${{ pending: '待发送', failed: '发送失败', paused: '已暂停', sent: '已发送·待回执', escalated: '已升级' }[prevStatus] || prevStatus}` +
          (escAt ? '，回执超时倒计时重新计算' : ''), '系统')
        restoredTasks.push({ id: t.id, status: prevStatus, work_order_id: t.work_order_id ?? null })
      }
      // ③ 档案标记回滚（回写的复盘报告标记保留：已发布报告是历史事实，仅代表当次结案口径）
      run('UPDATE crisis_closures SET rolled_back=1, rolled_back_at=?, rollback_note=? WHERE id=?', ts, note, closure.id)
    }
    // ④ 事件重回结案前状态 + 统一时间线
    run('UPDATE crisis SET status=? WHERE id=?', backTo, crisisId)
    const bits = [`结案回滚：事件重回「${ST_TEXT[backTo] || backTo}」`]
    if (closure) {
      bits.push(`恢复 ${restored} 条结案联动解除的预警为未解除`)
      if (restoredTasks.length) bits.push(`恢复 ${restoredTasks.length} 条被中止的通知任务`)
      else if (taskSnapshots.length) bits.push(`中止清单中的 ${taskSnapshots.length} 条通知任务已被其他链路处理，跳过恢复`)
    } else {
      bits.push('历史结案无回滚档案，仅恢复状态')
    }
    if (note) bits.push(note)
    addTimeline(crisisId, '结案回滚', bits.join('；'), ts)
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  for (const woId of [...new Set(restoredTasks.map((t) => t.work_order_id).filter((x) => x != null))]) {
    recomputeWorkOrderState(woId)
  }
  return { ok: true, restored, restoredTasks: restoredTasks.length, status: backTo }
}

// 守卫快照（供回溯面板/复盘快照读取；历史档案解析失败返回 null）
export function parseGuardSnapshot(closure) {
  if (!closure || !closure.guard_snapshot) return null
  try { const v = JSON.parse(closure.guard_snapshot); return v && Object.keys(v).length ? v : null } catch { return null }
}

export function parseCancelledTasks(closure) {
  if (!closure || !closure.cancelled_tasks) return []
  try { const v = JSON.parse(closure.cancelled_tasks); return Array.isArray(v) ? v : [] } catch { return [] }
}
