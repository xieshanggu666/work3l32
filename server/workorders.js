import { db } from './db.js'
import { now } from './pipeline.js'
import {
  logWorkOrder, addDispatchTimeline, deliveryRollup, workOrderDeliveryTasks, workOrderTrace,
  WO_DISPATCH_STATE_TEXT, cancelWorkOrderDispatch
} from './dispatch.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// ===== 常量与口径 =====
export const WO_STATUS = { todo: '待分派', doing: '处理中', blocked: '已阻塞', done: '已完成', cancelled: '已取消' }
export const WO_PRIORITY = { urgent: '紧急', high: '高', normal: '普通' }
// 跨角色：处理人所属职能团队（区别于平台权限角色 admin/ops/viewer）
export const WO_ROLE = { pr: '公关', legal: '法务', ops: '运营', support: '客服', admin: '协调组' }
export const WO_CATEGORY = { pr: '公关口径', legal: '法务合规', ops: '现场运营', support: '客诉跟进', other: '其他' }

// ===== 调度参数（演示用小时间窗：SLA 1 分钟即可观察两级升级） =====
export const WO_TICK_MS = 3000       // 扫描间隔
const DUE_BATCH = 20                 // 每轮处理上限
const L2_AFTER_MS = 60000            // 一级升级后 1 分钟仍未处理 → 二级升级督办
const REMIND_COOLDOWN_MS = 30000     // 待分派超时提醒防抖间隔

// 通知联动在 index.js 中注入（避免模块循环依赖：notify ↔ workorders）
// dispatchTasks(woId, event, opts)：event=created/assign/reassign/claim/1/2；统一走通知调度链路
let notifyHooks = { dispatchTasks: null }
export function bindWorkOrderNotify(hooks) { notifyHooks = { ...notifyHooks, ...hooks } }

function addLog(woId, action, detail, actor = { user: '系统', role: '' }, woEvent = null) {
  logWorkOrder(woId, action, detail, actor, { woEvent })
}

// 分派/改派/认领触发通知（失败不影响主流程；携带当前调度轮次 seq 保证幂等口径一致）
function fireDispatch(woId, event, seq, to) {
  if (!notifyHooks.dispatchTasks) return
  try { notifyHooks.dispatchTasks(woId, event, { seq, to }) } catch (e) { console.error('[WORKORDER] 分派通知失败：', e.message) }
}
// SLA 超时升级触发通知（一级/二级）
function fireEscalate(woId, level) {
  if (!notifyHooks.dispatchTasks) return
  try { notifyHooks.dispatchTasks(woId, level) } catch (e) { console.error('[WORKORDER] 升级通知失败：', e.message) }
}

// 危机下未完结工单数（结案守卫/看板汇总）
export function crisisOpenCount(crisisId) {
  return q1("SELECT COUNT(*) c FROM work_orders WHERE crisis_id=? AND status IN ('todo','doing','blocked')", crisisId).c
}

// ===== 查询 =====
export function listWorkOrders({ status = '', crisisId = null, assignee = '', limit = 200 } = {}) {
  let sql = 'SELECT * FROM work_orders WHERE 1=1'
  const args = []
  if (status) { sql += ' AND status=?'; args.push(status) }
  if (crisisId) { sql += ' AND crisis_id=?'; args.push(crisisId) }
  if (assignee) { sql += ' AND assignee=?'; args.push(assignee) }
  sql += ' ORDER BY id DESC LIMIT ?'
  args.push(limit)
  const rows = q(sql, ...args).map(decorate)
  attachDelivery(rows)
  return rows
}

// 批量挂载通知链路汇总（一次查询，避免卡片 N+1）
function attachDelivery(rows) {
  const rollup = deliveryRollup(rows.map((w) => w.id))
  for (const w of rows) w.delivery = rollup[w.id] || null
}

export function getWorkOrder(id) {
  const w = q1(`SELECT w.*, c.title crisis_title, c.status crisis_status, c.level crisis_level
    FROM work_orders w LEFT JOIN crisis c ON c.id=w.crisis_id WHERE w.id=?`, id)
  if (!w) return null
  const d = decorate(w)
  d.delivery = deliveryRollup([id])[id] || null
  d.deliveryTasks = workOrderDeliveryTasks(id)
  return d
}

export function workOrderLogs(id) {
  return q('SELECT * FROM work_order_logs WHERE wo_id=? ORDER BY id ASC', id)
}

// 工单调度链路视图：工单动作与通知发送/重试/回执归并的统一时间序
export function workOrderDispatchTrace(id) {
  return workOrderTrace(id)
}

function decorate(w) {
  const nowMs = Date.now()
  let remaining = null, overdue = 0
  // 阻塞期间 SLA 挂起：剩余时间按暂停点冻结
  if (w.due_at && !['done', 'cancelled'].includes(w.status)) {
    remaining = (w.status === 'blocked' && w.paused_at ? w.due_at - w.paused_at : w.due_at - nowMs)
    overdue = remaining < 0 ? 1 : 0
  }
  // 最近一次关联危机声明回写的进度（卡片展示，点击可跳声明详情）
  let stmt = null
  if (w.last_statement_id) {
    stmt = q1('SELECT id,title,status FROM crisis_statements WHERE id=?', w.last_statement_id)
  }
  return {
    ...w,
    statusText: WO_STATUS[w.status] || w.status,
    priorityText: WO_PRIORITY[w.priority] || w.priority,
    categoryText: WO_CATEGORY[w.category] || w.category,
    roleText: WO_ROLE[w.assignee_role] || w.assignee_role || '',
    dispatchStateText: WO_DISPATCH_STATE_TEXT[w.dispatch_state] || '',
    remainingMs: remaining, overdue,
    stmt
  }
}

// 看板汇总（总览角标 / 看板头部）
export function workOrderSummary() {
  const rows = q('SELECT status, COUNT(*) c FROM work_orders GROUP BY status')
  const counts = { todo: 0, doing: 0, blocked: 0, done: 0, cancelled: 0 }
  for (const r of rows) counts[r.status] = r.c
  const nowMs = Date.now()
  const overdue = q1(`SELECT COUNT(*) c FROM work_orders
    WHERE status IN ('todo','doing') AND due_at IS NOT NULL AND due_at<?`, nowMs).c
  const escalated = q1("SELECT COUNT(*) c FROM work_orders WHERE escalated>0 AND status IN ('todo','doing','blocked')").c
  // 通知链路汇总（与通知中心、复盘快照同口径；仅统计工单类任务）
  const nt = q1(`SELECT
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
      SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) sent,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
      SUM(CASE WHEN status='acked' THEN 1 ELSE 0 END) acked,
      SUM(CASE WHEN status='escalated' THEN 1 ELSE 0 END) esc,
      COUNT(*) total
    FROM notify_tasks WHERE work_order_id IS NOT NULL`)
  const retries = q1(`SELECT COUNT(*) c FROM notify_logs nl JOIN notify_tasks t ON t.id=nl.task_id
    WHERE t.work_order_id IS NOT NULL AND nl.action='retry'`).c
  const dsRows = q("SELECT dispatch_state, COUNT(*) c FROM work_orders WHERE dispatch_state NOT IN ('','none') GROUP BY dispatch_state")
  const dispatch = { dispatching: 0, stalled: 0, partial: 0, delivered: 0, acked: 0, cancelled: 0 }
  for (const r of dsRows) dispatch[r.dispatch_state] = r.c
  return {
    counts, open: counts.todo + counts.doing + counts.blocked, overdue, escalated,
    delivery: {
      total: nt.total || 0, pending: nt.pending || 0, sent: nt.sent || 0,
      failed: nt.failed || 0, acked: nt.acked || 0, escalated: nt.esc || 0, retries: retries.c
    },
    dispatch
  }
}

// ===== 创建（从危机拆分） =====
export function createWorkOrder(body, actor) {
  const b = body || {}
  const title = String(b.title || '').trim()
  if (!title) return { error: '工单标题必填' }
  const crisisId = +b.crisis_id
  const c = q1('SELECT * FROM crisis WHERE id=?', crisisId)
  if (!c) return { error: '所属危机事件不存在' }
  if (c.status === 'closed') return { error: '事件已结案，不能再拆分工单（如需协同请先回滚结案）' }
  const category = WO_CATEGORY[b.category] ? b.category : 'other'
  const priority = WO_PRIORITY[b.priority] ? b.priority : 'normal'
  const slaMin = Math.max(0, Math.min(10080, +b.sla_min || 0)) // 上限 7 天，0=无时限
  const ts = now(), nowMs = Date.now()
  const dueAt = slaMin ? nowMs + slaMin * 60000 : null
  const assignee = String(b.assignee || '').trim()
  const assigneeRole = WO_ROLE[b.assignee_role] ? b.assignee_role : ''
  const propPathId = +b.prop_path_id || null
  const fromProp = propPathId && q1('SELECT 1 FROM prop_paths WHERE id=?', propPathId) ? propPathId : null
  const r = run(`INSERT INTO work_orders
    (crisis_id,prop_path_id,title,detail,category,priority,status,assignee,assignee_role,created_by,due_at,sla_budget_ms,started_at,dispatch_seq,dispatch_state,created,updated)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`,
    crisisId, fromProp, title, String(b.detail || '').trim(), category, priority,
    assignee ? 'doing' : 'todo', assignee, assigneeRole, actor.user, dueAt, slaMin ? slaMin * 60000 : null,
    assignee ? ts : null, assignee ? 'dispatching' : 'none', ts, ts)
  const id = Number(r.lastInsertRowid)
  addLog(id, 'created', `从危机「${c.title}」#${crisisId} 拆分工单（${WO_PRIORITY[priority]} · ${WO_CATEGORY[category]}）${slaMin ? ` · SLA ${slaMin} 分钟` : ' · 无时限'}`, actor, 'created')
  if (assignee) addLog(id, 'assigned', `分派给 ${assignee}（${WO_ROLE[assigneeRole] || '未指定团队'}）`, actor, 'assigned')
  addDispatchTimeline(crisisId, '工单拆分',
    `拆分协同工单 #${id}「${title}」（${WO_CATEGORY[category]}·${WO_PRIORITY[priority]}）` +
    (assignee ? `，处理人：${assignee}（${WO_ROLE[assigneeRole] || '未指定团队'}）` : '，待分派'),
    { woId: id, time: ts })
  // 通知联动：命中「新工单分派」订阅的渠道并发生成通知任务（同链路 corr_id，幂等）
  if (assignee) fireDispatch(id, 'created', 0, assignee)
  else fireDispatch(id, 'created', 0, '')
  return { ok: true, id }
}

// ===== 指派 / 改派（admin/ops） =====
export function assignWorkOrder(id, body, actor) {
  const w = q1('SELECT * FROM work_orders WHERE id=?', id)
  if (!w) return null
  const assignee = String(body?.assignee || '').trim()
  if (!assignee) return { error: '处理人必填' }
  if (['done', 'cancelled'].includes(w.status)) return { error: `工单已${WO_STATUS[w.status]}，不能再指派` }
  const role = WO_ROLE[body?.assignee_role] ? body.assignee_role : (w.assignee_role || '')
  const ts = now()
  // 待分派单指派后即进入处理中（与创建时指派一致）；处理中/已阻塞改派仅换处理人
  const isFirstAssign = !w.assignee
  const seq = (w.dispatch_seq || 0) + (isFirstAssign ? 0 : 1) // 首次分派沿用第 0 轮；改派进入下一轮
  run(`UPDATE work_orders SET assignee=?, assignee_role=?, status=CASE WHEN status='todo' THEN 'doing' ELSE status END,
    started_at=CASE WHEN status='todo' THEN COALESCE(started_at,?) ELSE started_at END, dispatch_seq=?, updated=? WHERE id=?`,
    assignee, role, ts, seq, ts, id)
  const event = isFirstAssign ? 'assign' : 'reassign'
  addLog(id, isFirstAssign ? 'assigned' : 'assigned', w.assignee
    ? `改派：${w.assignee}（${WO_ROLE[w.assignee_role] || '未指定团队'}）→ ${assignee}（${WO_ROLE[role] || '未指定团队'}）`
    : `分派给 ${assignee}（${WO_ROLE[role] || '未指定团队'}）`, actor, isFirstAssign ? 'assigned' : 'reassign')
  addDispatchTimeline(w.crisis_id, isFirstAssign ? '工单指派' : '工单改派', `工单 #${id}「${w.title}」` +
    (w.assignee ? `改派：${w.assignee} → ${assignee}` : `分派给 ${assignee}`), { woId: id, time: ts })
  // 分派/改派通知：携带轮次 seq 与新处理人，幂等键按 轮次×处理人 去重
  fireDispatch(id, event, seq, assignee)
  return { ok: true, workOrder: getWorkOrder(id) }
}

// ===== 认领（待分派 → 处理中；处理人置为当前用户） =====
export function claimWorkOrder(id, actor, reqRole) {
  const w = q1('SELECT * FROM work_orders WHERE id=?', id)
  if (!w) return null
  if (w.status !== 'todo') return { error: '仅待分派工单可认领' }
  const ts = now()
  const r = run(`UPDATE work_orders SET status='doing', assignee=?, assignee_role=COALESCE(NULLIF(assignee_role,''),?),
    started_at=COALESCE(started_at,?), updated=? WHERE id=? AND status='todo'`,
    actor.user, mapTeamRole(reqRole), ts, ts, id)
  if (!Number(r.changes)) return { error: '工单状态已变化，请刷新' }
  addLog(id, 'claimed', `${actor.user} 认领并开始处理`, actor, 'claim')
  addDispatchTimeline(w.crisis_id, '工单认领', `工单 #${id}「${w.title}」由 ${actor.user} 认领`, { woId: id, time: ts })
  fireDispatch(id, 'claim', w.dispatch_seq || 0, actor.user)
  return { ok: true, workOrder: getWorkOrder(id) }
}
// 平台权限角色 → 职能团队（认领时沿用团队归属）
function mapTeamRole(role) { return role === 'admin' ? 'admin' : role === 'ops' ? 'ops' : '' }

// ===== 开始处理 / 状态流转 =====
export function startWorkOrder(id, actor) {
  const w = q1('SELECT * FROM work_orders WHERE id=?', id)
  if (!w) return null
  if (!['todo', 'blocked'].includes(w.status)) return { error: `当前状态（${WO_STATUS[w.status]}）不能开始/恢复` }
  const ts = now(), nowMs = Date.now()
  db.exec('BEGIN')
  try {
    // 阻塞恢复：SLA 顺延（冻结多久就顺延多久）
    let dueAt = w.due_at
    if (w.status === 'blocked' && w.paused_at && w.due_at) {
      dueAt = w.due_at + (nowMs - w.paused_at)
      addLog(id, 'unblocked', '解除阻塞恢复处理，SLA 已顺延', actor)
      addDispatchTimeline(w.crisis_id, '工单恢复', `工单 #${id}「${w.title}」解除阻塞恢复处理，SLA 已顺延`, { woId: id, time: ts })
    }
    const r = run(`UPDATE work_orders SET status='doing', due_at=?, paused_at=NULL,
      blocked_reason='', started_at=COALESCE(started_at,?), updated=? WHERE id=? AND status IN ('todo','blocked')`,
      dueAt, ts, ts, id)
    if (!Number(r.changes)) { db.exec('ROLLBACK'); return { error: '工单状态已变化，请刷新' } }
    if (w.status === 'todo') addLog(id, 'started', `开始处理（处理人：${w.assignee || actor.user}）`, actor)
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  return { ok: true, workOrder: getWorkOrder(id) }
}

// ===== 阻塞挂起（doing → blocked，SLA 计时暂停） =====
export function blockWorkOrder(id, body, actor) {
  const w = q1('SELECT * FROM work_orders WHERE id=?', id)
  if (!w) return null
  if (w.status !== 'doing') return { error: '仅处理中的工单可标记阻塞' }
  const reason = String(body?.reason || '').trim()
  if (!reason) return { error: '请填写阻塞原因' }
  const ts = now()
  const r = run(`UPDATE work_orders SET status='blocked', blocked_reason=?, paused_at=?, updated=? WHERE id=? AND status='doing'`,
    reason, Date.now(), ts, id)
  if (!Number(r.changes)) return { error: '工单状态已变化，请刷新' }
  addLog(id, 'blocked', `阻塞挂起：${reason}（SLA 计时暂停）`, actor)
  addDispatchTimeline(w.crisis_id, '工单阻塞', `工单 #${id}「${w.title}」阻塞挂起：${reason}`, { woId: id, time: ts })
  return { ok: true, workOrder: getWorkOrder(id) }
}

// ===== 完成（处理结果回写危机时间线；可联动解除该危机全部未解除预警） =====
export function completeWorkOrder(id, body, actor) {
  const w = q1('SELECT * FROM work_orders WHERE id=?', id)
  if (!w) return null
  if (!['doing', 'blocked'].includes(w.status)) return { error: `当前状态（${WO_STATUS[w.status]}）不能完成` }
  const result = String(body?.result || '').trim()
  if (!result) return { error: '请填写处理结果' }
  const resolveAlerts = body?.resolve_alerts ? 1 : 0
  const ts = now()
  let resolved = 0
  const ruleNames = []
  db.exec('BEGIN')
  try {
    const r = run(`UPDATE work_orders SET status='done', result=?, resolve_alerts=?, done_at=?,
      blocked_reason='', paused_at=NULL, updated=? WHERE id=? AND status IN ('doing','blocked')`,
      result, resolveAlerts, ts, ts, id)
    if (!Number(r.changes)) { db.exec('ROLLBACK'); return { error: '工单状态已变化，请刷新' } }
    addLog(id, 'done', `完成：${result}` + (resolveAlerts ? '（联动解除该事件全部未解除预警）' : ''), actor)
    if (resolveAlerts) {
      const opens = q("SELECT * FROM alert_events WHERE crisis_id=? AND status='open'", w.crisis_id)
      for (const ev of opens) {
        run("UPDATE alert_events SET status='resolved', resolved=?, resolve_kind='workorder' WHERE id=? AND status='open'", ts, ev.id)
      }
      resolved = opens.length
      for (const rid of [...new Set(opens.map((e) => e.alert_id))]) {
        const al = q1('SELECT title FROM alerts WHERE id=?', rid)
        ruleNames.push(al ? `「${al.title}」` : '已删除规则')
      }
    }
    const c = q1('SELECT status FROM crisis WHERE id=?', w.crisis_id)
    if (c && c.status !== 'closed') {
      addDispatchTimeline(w.crisis_id, '工单完成',
        `协同工单 #${id}「${w.title}」已由 ${w.assignee || actor.user} 完成：${result}` +
        (resolved ? `（同步解除 ${resolved} 条未解除预警${ruleNames.length ? '：' + ruleNames.join('、') : ''}）` : ''),
        { woId: id, time: ts })
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  // 工单完结：在途（待发送/失败/暂停）分派与升级通知自动取消，避免完结后继续催办
  cancelWorkOrderDispatch(id, `工单 #${id} 已完成，在途通知自动取消`)
  return { ok: true, resolved, workOrder: getWorkOrder(id) }
}

// ===== 回退（打回重做：done/blocked/todo → doing，可附退回说明；保留完成结果留痕） =====
export function reworkWorkOrder(id, body, actor) {
  const w = q1('SELECT * FROM work_orders WHERE id=?', id)
  if (!w) return null
  if (!['done', 'blocked', 'todo'].includes(w.status)) return { error: `当前状态（${WO_STATUS[w.status]}）不能回退` }
  const note = String(body?.note || '').trim() || '处理不达标，打回重做'
  const assignee = String(body?.assignee || '').trim() || w.assignee
  const ts = now()
  const prevDone = w.status === 'done'
  const r = run(`UPDATE work_orders SET status='doing', blocked_reason='', paused_at=NULL,
    assignee=?, done_at=NULL, updated=? WHERE id=? AND status IN ('done','blocked','todo')`, assignee, ts, id)
  if (!Number(r.changes)) return { error: '工单状态已变化，请刷新' }
  addLog(id, 'rework', (prevDone && w.result ? `打回重做（原结果：${w.result}）` : '回退至处理中') + `：${note}` +
    (assignee !== w.assignee ? `；重新指派给 ${assignee}` : ''), actor)
  addDispatchTimeline(w.crisis_id, '工单回退',
    `工单 #${id}「${w.title}」被 ${actor.user} 打回重做：${note}` + (assignee !== w.assignee ? `（重新指派：${assignee}）` : ''), { woId: id, time: ts })
  return { ok: true, workOrder: getWorkOrder(id) }
}

// ===== 取消（未完成工单可取消，已完成不可取消） =====
export function cancelWorkOrder(id, body, actor) {
  const w = q1('SELECT * FROM work_orders WHERE id=?', id)
  if (!w) return null
  if (['done', 'cancelled'].includes(w.status)) return { error: `当前状态（${WO_STATUS[w.status]}）不能取消` }
  const note = String(body?.note || '').trim()
  const ts = now()
  const r = run(`UPDATE work_orders SET status='cancelled', cancelled_at=?, blocked_reason='', paused_at=NULL, updated=?
    WHERE id=? AND status IN ('todo','doing','blocked')`, ts, ts, id)
  if (!Number(r.changes)) return { error: '工单状态已变化，请刷新' }
  addLog(id, 'cancelled', note ? `取消：${note}` : '取消工单', actor)
  addDispatchTimeline(w.crisis_id, '工单取消', `工单 #${id}「${w.title}」已取消${note ? `：${note}` : ''}`, { woId: id, time: ts })
  cancelWorkOrderDispatch(id, `工单 #${id} 已取消，在途通知自动取消`)
  return { ok: true, workOrder: getWorkOrder(id) }
}

// ===== 超时升级调度：SLA 到期两级升级（待分派提醒 → 升级督办）；阻塞挂起期间不计时 =====
function runEscalate(w) {
  const nowMs = Date.now()
  const c = q1('SELECT title,status FROM crisis WHERE id=?', w.crisis_id)
  const ts = now()
  if (w.escalated === 0) {
    // 一级：待分派 → 分派提醒；处理中 → 超时提醒
    run('UPDATE work_orders SET escalated=1,last_remind_at=?,updated=? WHERE id=?', nowMs, ts, w.id)
    const who = w.status === 'todo' ? '工单仍待分派，请尽快认领或指派' : `处理人 ${w.assignee || '—'} 超时未完成`
    addLog(w.id, 'escalated', `SLA 已到期，一级升级：${who}`, { user: '调度器' }, 'escalate1')
    if (c && c.status !== 'closed') {
      addDispatchTimeline(w.crisis_id, '工单超时', `工单 #${w.id}「${w.title}」SLA 到期，一级升级（${who}）`, { woId: w.id, time: ts })
    }
    fireEscalate(w.id, 1)
    return
  }
  if (w.escalated === 1 && nowMs - (w.last_remind_at || 0) >= L2_AFTER_MS) {
    // 二级：升级督办（值班负责人/管理员）
    run('UPDATE work_orders SET escalated=2,last_remind_at=?,updated=? WHERE id=?', nowMs, ts, w.id)
    addLog(w.id, 'escalated', `一级升级后 ${L2_AFTER_MS / 1000} 秒仍未完成，二级升级：升级督办至管理员`, { user: '调度器' }, 'escalate2')
    if (c && c.status !== 'closed') {
      addDispatchTimeline(w.crisis_id, '工单升级', `工单 #${w.id}「${w.title}」持续超时，二级升级督办（管理员介入）`, { woId: w.id, time: ts })
    }
    fireEscalate(w.id, 2)
  }
}

export function runWorkOrderTick() {
  if (!notifyHooks.dispatchTasks) return // 通知钩子未注入前不扫描
  const nowMs = Date.now()
  const due = q(`SELECT * FROM work_orders WHERE status IN ('todo','doing')
    AND due_at IS NOT NULL AND due_at<=? AND escalated<2 ORDER BY due_at LIMIT ?`, nowMs, DUE_BATCH)
  for (const w of due) {
    // 防抖：一级升级后未到二级间隔则跳过（SQL 层无法表达）
    if (w.escalated === 1 && nowMs - (w.last_remind_at || 0) < L2_AFTER_MS) continue
    // 待分派单在一级升级前给一个提醒冷却窗口（避免与到期同一拍重复发信）
    if (w.escalated === 0 && w.status === 'todo' && w.last_remind_at && nowMs - w.last_remind_at < REMIND_COOLDOWN_MS) continue
    try { runEscalate(w) } catch (e) { console.error('[WORKORDER] 升级异常：', e.message) }
  }
}

let timer = null
export function startWorkOrderScheduler() {
  if (timer) return
  timer = setInterval(() => {
    try { runWorkOrderTick() } catch (e) { console.error('[WORKORDER] 调度异常：', e.message) }
  }, WO_TICK_MS)
  if (timer.unref) timer.unref()
  console.log(`[WORKORDER] 工单调度器已启动（每 ${WO_TICK_MS / 1000} 秒扫描：SLA 超时两级升级）`)
}
export function stopWorkOrderScheduler() { if (timer) clearInterval(timer); timer = null }
