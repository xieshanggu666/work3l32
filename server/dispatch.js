// ===== 协同调度链路（work order ↔ notify）共享状态流 =====
// 分派/改派/认领、SLA 超时升级、通知发送/重试/回执/回执升级共用同一套事件口径，
// 让工单日志、危机时间线、危机看板与复盘快照从同一数据源读取，保证跨视图一致。
import { db } from './db.js'
import { addTimeline } from './pipeline.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// 工单事件（wo_event）：创建分派 / 改派 / 认领 / 一级超时 / 二级督办
export const WO_EVENTS = {
  created: { label: '拆分分派', timeline: '工单拆分' },
  assigned: { label: '分派', timeline: '工单指派' },
  reassign: { label: '改派', timeline: '工单改派' },
  claim: { label: '认领', timeline: '工单认领' },
  escalate1: { label: '超时一级升级', timeline: '工单升级' },
  escalate2: { label: '超时二级督办', timeline: '工单升级' }
}

// 通知任务状态（与 notify.js 的 TASK_STATUS 同源，链路读取用）
export const DELIVERY_STATUS = {
  pending: '待发送', sent: '已发送', failed: '发送失败',
  acked: '已回执', escalated: '已升级', paused: '已暂停', cancelled: '已取消'
}

// 通知侧留痕动作 → 工单日志动作（映射到同一事件词汇表；重试逐次可见）
const MIRROR_ACTION = {
  sent: 'notify_sent',
  retry: 'notify_retry',
  failed: 'notify_failed',
  acked: 'notify_acked',
  escalated: 'notify_escalated',
  cancelled: 'notify_cancelled',
  paused: 'notify_paused',
  resumed: 'notify_resumed'
}
export const WO_LOG_ACTION_TEXT = {
  notify_sent: '通知送达',
  notify_retry: '通知重试',
  notify_failed: '通知失败',
  notify_acked: '通知回执',
  notify_escalated: '回执升级',
  notify_cancelled: '通知取消',
  notify_paused: '通知暂停',
  notify_resumed: '通知恢复'
}

// 工单留痕（operator_role 缺省由 actor 推导；notify_task_id 非空表示该条为通知侧镜像）
export function logWorkOrder(woId, action, detail, actor = { user: '系统', role: '' }, extra = {}) {
  run('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time,notify_task_id,wo_event) VALUES (?,?,?,?,?,?,?,?)',
    woId, action, detail || '', actor.user || '系统', actor.assigneeRole || actor.role || '', extra.time || new Date().toLocaleString('zh-CN'),
    extra.taskId || null, extra.woEvent || '')
}

// 通知侧动作镜像到工单日志：让「分派→发送→重试→回执/升级」在工单同一条时间线上可追踪
export function mirrorNotifyToWorkOrder(task, action, detail, operator = '系统') {
  if (!task || !task.work_order_id || !MIRROR_ACTION[action]) return
  logWorkOrder(task.work_order_id, MIRROR_ACTION[action], detail, { user: operator, role: '' }, {
    taskId: task.id,
    woEvent: action === 'escalated' ? 'notify_escalate' : null
  })
}

// 带链路引用的危机时间线写入（ref_type/ref_id 供看板/回溯锚定到具体工单）
export function addDispatchTimeline(crisisId, action, note, { woId = null, refType = '', refId = null, time = null } = {}) {
  const t = refType || (woId ? 'workorder' : '')
  const rid = refId != null ? refId : woId
  addTimeline(crisisId, action, note, time || undefined)
  if (t && rid != null) {
    run('UPDATE crisis_timeline SET ref_type=?, ref_id=? WHERE id=(SELECT MAX(id) FROM crisis_timeline WHERE crisis_id=?)',
      t, rid, crisisId)
  }
}

// 批量取工单关联通知任务的链路汇总（一次查询，避免卡片 N+1）
// 返回 { [woId]: { total, byStatus, sent, acked, failed, pending, retries, escalated, done } }
export function deliveryRollup(woIds = []) {
  const ids = [...new Set(woIds.filter((x) => x != null))]
  const out = {}
  if (!ids.length) return out
  const placeholder = ids.map(() => '?').join(',')
  // 升级链上的子任务（escalated_from）同样归属工单；escalated_from 回填由迁移/创建时补齐
  const rows = q(`SELECT work_order_id wo_id, status, COUNT(*) c, COALESCE(SUM(attempts),0) attempts
    FROM notify_tasks WHERE work_order_id IN (${placeholder}) GROUP BY work_order_id, status`, ...ids)
  // 自动重试次数：逐次留痕计数（attempts 不反映手动重试后的历史）
  const retryRows = q(`SELECT nt.work_order_id wo_id, COUNT(*) c FROM notify_logs nl
    JOIN notify_tasks nt ON nt.id=nl.task_id
    WHERE nt.work_order_id IN (${placeholder}) AND nl.action='retry'
    GROUP BY nt.work_order_id`, ...ids)
  for (const id of ids) {
    out[id] = { total: 0, byStatus: {}, sent: 0, acked: 0, failed: 0, pending: 0, escalated: 0, cancelled: 0, paused: 0, retries: 0 }
  }
  for (const r of rows) {
    const o = out[r.wo_id]
    o.byStatus[r.status] = r.c
    o.total += r.c
    if (r.status === 'sent') o.sent += r.c
    if (r.status === 'acked') o.acked += r.c
    if (r.status === 'failed') o.failed += r.c
    if (r.status === 'escalated') o.escalated += r.c
    if (r.status === 'cancelled') o.cancelled += r.c
    if (r.status === 'paused') o.paused += r.c
    if (r.status === 'pending') o.pending += r.c
  }
  for (const r of retryRows) if (out[r.wo_id]) out[r.wo_id].retries = r.c
  for (const id of ids) {
    const o = out[id]
    // 链路终态口径：全部渠道已回执或已取消（无在途/失败任务）
    o.done = o.total > 0 && (o.pending + o.sent + o.failed + o.escalated + o.paused) === 0
  }
  return out
}

// 单工单链路明细（工单详情：关联通知任务）
export function workOrderDeliveryTasks(woId) {
  return q(`SELECT nt.id, nt.status, nt.title, nt.attempts, nt.max_attempts, nt.last_error,
      nt.ack_by, nt.ack_at, nt.ack_note, nt.escalated, nt.escalated_from, nt.sent_at, nt.created,
      nc.name channel_name, nc.type channel_type, ns.name sub_name
    FROM notify_tasks nt LEFT JOIN notify_channels nc ON nc.id=nt.channel_id
    LEFT JOIN notify_subs ns ON ns.id=nt.sub_id
    WHERE nt.work_order_id=? ORDER BY nt.id ASC`, woId)
}

// 工单日志与通知日志按时间归并（工单详情「调度链路」视图）
export function workOrderTrace(woId) {
  const woLogs = q('SELECT * FROM work_order_logs WHERE wo_id=? ORDER BY id ASC', woId)
  const taskRows = q(`SELECT nl.*, nc.name channel_name FROM notify_logs nl
    JOIN notify_tasks nt ON nt.id=nl.task_id LEFT JOIN notify_channels nc ON nc.id=nt.channel_id
    WHERE nt.work_order_id=? ORDER BY nl.id ASC`, woId)
  // notify_logs 已通过 mirror 进入 work_order_logs（同一动作，重试可多次）。
  // 按「任务×动作 + 第 N 次出现」配对去重；通知侧独有的 created 留痕保留。
  const woOccur = new Map()
  const seenMirrored = new Set()
  for (const l of woLogs) {
    if (!l.notify_task_id) continue
    const base = `${l.notify_task_id}:${mirrorOf(l.action)}`
    const n = (woOccur.get(base) || 0) + 1
    woOccur.set(base, n)
    seenMirrored.add(`${base}#${n}`)
  }
  const traces = woLogs.map((l) => ({
    kind: 'wo', id: l.id, action: l.action, detail: l.detail,
    operator: l.operator, operatorRole: l.operator_role, time: l.time,
    taskId: l.notify_task_id, woEvent: l.wo_event
  }))
  const ntOccur = new Map()
  for (const l of taskRows) {
    if (MIRROR_ACTION[l.action]) {
      const base = `${l.task_id}:${l.action}`
      const n = (ntOccur.get(base) || 0) + 1
      ntOccur.set(base, n)
      if (seenMirrored.has(`${base}#${n}`)) continue
    }
    traces.push({
      kind: 'notify', id: l.id, action: l.action, detail: l.detail ? `${l.detail}（${l.channel_name || '渠道#' + l.task_id}）` : l.detail,
      operator: l.operator, operatorRole: '', time: l.time, taskId: l.task_id, woEvent: null
    })
  }
  traces.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
  return traces
}
function mirrorOf(woAction) {
  const inv = Object.entries(MIRROR_ACTION).find(([, v]) => v === woAction)
  return inv ? inv[0] : ''
}

// 危机维度调度链路汇总（危机看板角标 / 复盘快照同口径）
export function crisisDispatchSummary(crisisId) {
  const byStatus = {}
  for (const r of q('SELECT status, COUNT(*) c FROM notify_tasks WHERE crisis_id=? GROUP BY status', crisisId)) byStatus[r.status] = r.c
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0)
  const woEscRow = q1("SELECT COUNT(*) c FROM work_orders WHERE crisis_id=? AND escalated>0 AND status IN ('todo','doing','blocked')", crisisId)
  const woOverdueRow = q1("SELECT COUNT(*) c FROM work_orders WHERE crisis_id=? AND status IN ('todo','doing') AND due_at IS NOT NULL AND due_at<?",
    crisisId, Date.now())
  const retryRow = q1(`SELECT COUNT(*) c FROM notify_logs nl JOIN notify_tasks nt ON nt.id=nl.task_id
    WHERE nt.crisis_id=? AND nl.action='retry'`, crisisId)
  return {
    total,
    byStatus,
    pending: (byStatus.pending || 0) + (byStatus.failed || 0),
    sent: byStatus.sent || 0,
    acked: byStatus.acked || 0,
    failed: byStatus.failed || 0,
    escalated: byStatus.escalated || 0,
    retries: retryRow.c,
    woOverdue: woOverdueRow.c,
    woEscalated: woEscRow.c
  }
}

// 批量：危机 id → 调度链路汇总（看板一次查询，避免每卡子查询）
export function crisisDispatchRollup(crisisIds = []) {
  const ids = [...new Set(crisisIds.filter((x) => x != null))]
  const out = {}
  if (!ids.length) return out
  const placeholder = ids.map(() => '?').join(',')
  for (const id of ids) out[id] = { total: 0, byStatus: {}, pending: 0, sent: 0, acked: 0, failed: 0, escalated: 0, retries: 0, woOverdue: 0, woEscalated: 0 }
  const rows = q(`SELECT crisis_id, status, COUNT(*) c FROM notify_tasks
    WHERE crisis_id IN (${placeholder}) GROUP BY crisis_id, status`, ...ids)
  for (const r of rows) {
    const o = out[r.crisis_id]
    if (!o) continue
    o.byStatus[r.status] = r.c
    o.total += r.c
    if (r.status === 'sent') o.sent += r.c
    if (r.status === 'acked') o.acked += r.c
    if (r.status === 'failed') o.failed += r.c
    if (r.status === 'escalated') o.escalated += r.c
    if (r.status === 'pending' || r.status === 'failed') o.pending += r.c
  }
  const retries = q(`SELECT nt.crisis_id, COUNT(*) c FROM notify_logs nl
    JOIN notify_tasks nt ON nt.id=nl.task_id
    WHERE nt.crisis_id IN (${placeholder}) AND nl.action='retry' GROUP BY nt.crisis_id`, ...ids)
  for (const r of retries) if (out[r.crisis_id]) out[r.crisis_id].retries = r.c
  const woEsc = q(`SELECT crisis_id, COUNT(*) c FROM work_orders
    WHERE crisis_id IN (${placeholder}) AND escalated>0 AND status IN ('todo','doing','blocked') GROUP BY crisis_id`, ...ids)
  for (const r of woEsc) if (out[r.crisis_id]) out[r.crisis_id].woEscalated = r.c
  const woOver = q(`SELECT crisis_id, COUNT(*) c FROM work_orders
    WHERE crisis_id IN (${placeholder}) AND status IN ('todo','doing') AND due_at IS NOT NULL AND due_at<? GROUP BY crisis_id`,
    ...ids, Date.now())
  for (const r of woOver) if (out[r.crisis_id]) out[r.crisis_id].woOverdue = r.c
  return out
}

// 重算单工单通知链路状态（通知任务每次状态流转留痕时联动调用，保证看板/复盘读到的状态始终最新）
// none 未触发 / dispatching 发送中 / stalled 发送失败 / partial 部分送达 / delivered 全部送达 / acked 全部回执 / cancelled 已取消
export function recomputeWorkOrderState(woId) {
  const w = q1('SELECT status FROM work_orders WHERE id=?', woId)
  if (!w) return
  const r = q1(`SELECT
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
      SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) sent,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
      SUM(CASE WHEN status='acked' THEN 1 ELSE 0 END) acked,
      SUM(CASE WHEN status='escalated' THEN 1 ELSE 0 END) esc,
      SUM(CASE WHEN status='paused' THEN 1 ELSE 0 END) paused,
      SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) cancelled,
      COUNT(*) total
    FROM notify_tasks WHERE work_order_id=?`, woId)
  // 回执超时升级的父任务若其升级链子任务已确认回执，业务上视为闭环（父任务保留 escalated 归档）
  const escAcked = q1(`SELECT COUNT(*) c FROM notify_tasks p
    WHERE p.work_order_id=? AND p.status='escalated' AND p.escalated_from IS NULL
      AND EXISTS (SELECT 1 FROM notify_tasks c WHERE c.escalated_from=p.id AND c.status='acked')`, woId).c
  const effectiveAcked = (r.acked || 0) + (escAcked || 0)
  let state = ''
  if (!r || !r.total) state = 'none'
  else if (effectiveAcked >= r.total) state = 'acked'
  else if (r.cancelled === r.total) state = 'cancelled'
  else if (r.acked > 0 || r.sent > 0 || escAcked > 0) {
    // 存在成功送达/回执：其余任务决定整体语义
    if (r.failed > 0) state = 'partial'
    else if ((r.esc || 0) - escAcked > 0) state = 'partial' // 仍有任务在回执超时升级中，链路未闭环
    else if (r.pending > 0 || r.paused > 0) state = 'dispatching'
    else state = 'delivered'                              // 全部已送达（含未要求回执的 sent）
  }
  else if (r.failed > 0) state = 'stalled'
  else state = 'dispatching'
  run('UPDATE work_orders SET dispatch_state=? WHERE id=?', state, woId)
}

export const WO_DISPATCH_STATE_TEXT = {
  none: '通知未触发', dispatching: '通知发送中', stalled: '通知发送失败',
  partial: '部分渠道送达', delivered: '通知已送达', acked: '通知已回执', cancelled: '通知已取消'
}

// 工单终态联动：取消仍在途的分派/升级通知（已发送待回执的不再催办，待发送/暂停/失败任务置已取消）
// 返回取消条数；每条均留痕并镜像工单日志，最后重算链路状态
export function cancelWorkOrderDispatch(woId, reason = '') {
  const ts = new Date().toLocaleString('zh-CN')
  const rows = q(`SELECT * FROM notify_tasks WHERE work_order_id=? AND status IN ('pending','failed','paused')`, woId)
  for (const t of rows) {
    const r = run(`UPDATE notify_tasks SET status='cancelled', updated=? WHERE id=? AND status IN ('pending','failed','paused')`, ts, t.id)
    if (Number(r.changes)) {
      run('INSERT INTO notify_logs (task_id,action,detail,operator,time) VALUES (?,?,?,?,?)',
        t.id, 'cancelled', reason || '工单完结，在途通知自动取消', '系统', ts)
      mirrorNotifyToWorkOrder(t, 'cancelled', reason || '工单完结，在途通知自动取消', '系统')
    }
  }
  recomputeWorkOrderState(woId)
  return rows.length
}
