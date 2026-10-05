// ===== 危机结案闭环（统一状态守卫 + 联动收口 + 回滚恢复） =====
// 结案前统一核验：协同工单、危机声明、外部协作提交、复盘报告、预警解除、通知回执链路。
// 硬阻塞项（blocks）未清零时禁止结案；联动项（actions）在结案事务中一并收口，
// 并把变更前状态写入结案档案，供回滚（reopen）精确恢复。
// 历史结案档案（resolved_events/settled_notify 为空）按「仅恢复事件状态」口径兼容。
import { db } from './db.js'
import { crisisOpenCount } from './workorders.js'
import { crisisOpenStatementCount } from './statements.js'
import { crisisDispatchSummary, recomputeWorkOrderState } from './dispatch.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// 结案时需要统一收口的通知任务状态：
//   pending  待发送（在途，结案后不应再催办/推送处置类通知）
//   failed   发送失败（待人工重试，结案时一并归档取消）
//   paused   已暂停（在途）
//   sent     已发送待回执（结案后不再回执超时升级）
// 已回执/已升级（留痕归档）/已取消（终态）不动；结案通报在收口之后生成，不会被本逻辑取消。
export const SETTLE_TASK_STATUSES = ['pending', 'failed', 'paused', 'sent']

// ===== 结案前统一状态守卫 =====
// 返回 { ready, blocks:[...], actions:[...], notice:[...], counts:{...} }
//   blocks：硬阻塞，存在即拒绝结案（工单/声明/外部提交/待审核复盘）
//   actions：结案将自动执行的联动收口（预警解除/通知回执链路收口）
//   notice：非阻塞提示（编制中复盘、历史档案口径等）
// 与各业务模块（工单看板/声明/外部门户/复盘/通知中心）共用同一 SQL 口径。
export function closureReadiness(crisisId) {
  const c = q1('SELECT * FROM crisis WHERE id=?', crisisId)
  if (!c) return null
  const blocks = []
  const actions = []
  const notice = []

  // ① 协同工单：todo/doing/blocked 必须先完成或取消
  const woOpen = crisisOpenCount(crisisId)
  if (woOpen > 0) {
    blocks.push({ key: 'workorder', label: '协同工单', count: woOpen,
      text: `存在 ${woOpen} 个未完结协同工单，请先完成或取消全部工单后再结案` })
  }

  // ② 危机声明：draft/review/approved/publishing/partial 必须先发布完成或取消
  const stmtOpen = crisisOpenStatementCount(crisisId)
  if (stmtOpen > 0) {
    blocks.push({ key: 'statement', label: '危机声明', count: stmtOpen,
      text: `存在 ${stmtOpen} 份未完结危机声明（起草/待审/发布中/部分渠道失败），请先完成全部渠道发布或取消声明后再结案` })
  }

  // ③ 外部协作提交：pending/reviewing 必须先受理闭环（采纳/驳回/撤回）
  const extRows = q("SELECT id, code, title, is_urgent, kind FROM ext_submissions WHERE crisis_id=? AND status IN ('pending','reviewing') ORDER BY id", crisisId)
  if (extRows.length) {
    const urgent = extRows.filter((s) => s.is_urgent).length
    blocks.push({ key: 'ext', label: '外部协作', count: extRows.length, urgent,
      ids: extRows.map((s) => s.id), codes: extRows.map((s) => s.code),
      text: `存在 ${extRows.length} 条待审核外部协作提交${urgent ? `（含 ${urgent} 条紧急）` : ''}，请先采纳/驳回或由提交方撤回后再结案` })
  }

  // ④ 复盘报告：待审核（reviewing）中的报告必须先审核发布或驳回——审核可能要求补充整改
  const report = q1('SELECT id,title,status,current_version,published_version FROM crisis_reports WHERE crisis_id=? ORDER BY id DESC LIMIT 1', crisisId)
  if (report && report.status === 'reviewing') {
    blocks.push({ key: 'report', label: '复盘报告', reportId: report.id,
      text: `复盘报告「${report.title}」正在审核中，请等待管理员审核发布或驳回后再结案` })
  }

  // ⑤ 未解除预警：非阻塞，结案级联解除（resolve_kind=close），解除清单写入档案供回滚恢复
  const openEvents = q("SELECT id FROM alert_events WHERE crisis_id=? AND status='open'", crisisId)
  if (openEvents.length) {
    actions.push({ key: 'alerts', label: '预警解除', count: openEvents.length,
      text: `结案将同步解除 ${openEvents.length} 条未解除预警（回滚时恢复）` })
  }

  // ⑥ 通知回执链路：在途/失败/暂停/待回执任务结案时统一收口为已取消（回滚时按档案恢复）
  const inflight = q(`SELECT id, status FROM notify_tasks
    WHERE crisis_id=? AND status IN ('pending','failed','paused','sent')`, crisisId)
  const inflightByStatus = {}
  for (const t of inflight) inflightByStatus[t.status] = (inflightByStatus[t.status] || 0) + 1
  if (inflight.length) {
    actions.push({ key: 'notify', label: '通知回执', count: inflight.length, byStatus: inflightByStatus,
      text: `结案将收口 ${inflight.length} 个未闭环通知任务（在途/失败/暂停/待回执），避免结案后继续催办（回滚时恢复）` })
  }

  // ⑦ 非阻塞提示：编制中的复盘报告（可在结案后继续编制并发布回写，亦可在结案前先发布）
  if (report && report.status === 'draft') {
    notice.push({ key: 'report-draft', label: '复盘报告', reportId: report.id,
      text: `复盘报告「${report.title}」仍在编制中：结案后可继续编制，审核发布时自动回写结案档案` })
  }

  const dispatch = crisisDispatchSummary(crisisId)
  return {
    ready: blocks.length === 0,
    blocks, actions, notice,
    counts: {
      woOpen, stmtOpen,
      extOpen: extRows.length, extUrgent: extRows.filter((s) => s.is_urgent).length,
      openAlerts: openEvents.length,
      inflightNotify: inflight.length,
      inflightByStatus,
      reportStatus: report ? report.status : null,
      dispatch
    }
  }
}

// ===== 结案事务内联动收口（调用方负责事务边界） =====
// ① 级联解除全部未解除预警（resolve_kind=close，状态守卫幂等）
// ② 收口未闭环通知任务（在途/失败/暂停/待回执 → cancelled），逐任务留痕
// 返回 { resolved:number, resolvedIds:number[], ruleNames:string[], settledNotify:Array<归档记录> }
export function settleOnClose(crisisId, ts) {
  const opens = q("SELECT * FROM alert_events WHERE crisis_id=? AND status='open'", crisisId)
  const resolvedIds = []
  for (const ev of opens) {
    const r = run("UPDATE alert_events SET status='resolved', resolved=?, resolve_kind='close' WHERE id=? AND status='open'", ts, ev.id)
    if (Number(r.changes)) resolvedIds.push(ev.id)
  }
  const ruleNames = []
  for (const rid of [...new Set(opens.map((e) => e.alert_id))]) {
    const al = q1('SELECT title FROM alerts WHERE id=?', rid)
    ruleNames.push(al ? `「${al.title}」` : '已删除规则')
  }

  // 通知任务收口：逐条带状态守卫更新并留痕（notify_logs；work_order_id 任务经镜像进入工单日志）
  const tasks = q(`SELECT * FROM notify_tasks WHERE crisis_id=? AND status IN (${SETTLE_TASK_STATUSES.map(() => '?').join(',')})`,
    crisisId, ...SETTLE_TASK_STATUSES)
  const settledNotify = []
  for (const t of tasks) {
    const prevStatus = t.status
    const r = run(`UPDATE notify_tasks SET status='cancelled', updated=?
      WHERE id=? AND status IN (${SETTLE_TASK_STATUSES.map(() => '?').join(',')})`,
      ts, t.id, ...SETTLE_TASK_STATUSES)
    if (!Number(r.changes)) continue // 竞态：调度器/人工已先一步流转，跳过（幂等）
    run('INSERT INTO notify_logs (task_id,action,detail,operator,time) VALUES (?,?,?,?,?)',
      t.id, 'cancelled', '事件结案：在途/待回执通知随结案统一收口（回滚结案时可恢复）', '系统', ts)
    // 镜像到工单日志，复用既有「通知取消」动作口径，保持工单调度链路可追溯
    if (t.work_order_id) {
      run('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time,notify_task_id,wo_event) VALUES (?,?,?,?,?,?,?,?)',
        t.work_order_id, 'notify_cancelled', '事件结案：通知随结案统一收口（回滚时恢复）', '系统', '', ts, t.id, '')
    }
    settledNotify.push({ id: t.id, prev: prevStatus, work_order_id: t.work_order_id ?? null, title: t.title })
  }
  // 工单通知链路状态随收口重算（全部通知取消后 dispatch_state 归为 cancelled，与手动取消工单口径一致）
  for (const woId of [...new Set(settledNotify.map((t) => t.work_order_id).filter((x) => x != null))]) {
    recomputeWorkOrderState(woId)
  }
  return { resolved: resolvedIds.length, resolvedIds, ruleNames, settledNotify }
}

// ===== 回滚事务内恢复（调用方负责事务边界） =====
// ① 恢复结案联动解除的预警为未解除（仅恢复仍处解除态的记录，幂等）
// ② 恢复结案收口的通知任务：按档案记录恢复结案前状态（仅恢复当前仍为「结案收口取消」态的任务）
// ③ 撤销该轮结案通报（幂等键 crisis:<id>:closed，含已发送待回执），避免回滚后误送；
//    回滚后的监测/处置通报在事务提交后才生成，不在此处理。
// 返回 { restored:number, restoredNotify:number, staleClosed:number }
export function restoreOnReopen(crisisId, closure, ts) {
  let restored = 0
  let eventIds = []
  try { eventIds = JSON.parse(closure.resolved_events || '[]') } catch { eventIds = [] }
  for (const id of eventIds) {
    const r = run("UPDATE alert_events SET status='open', resolved=NULL, resolve_kind='' WHERE id=? AND status='resolved'", id)
    restored += Number(r.changes || 0)
  }

  let restoredNotify = 0
  let settled = []
  try { settled = JSON.parse(closure.settled_notify || '[]') } catch { settled = [] }
  for (const rec of settled) {
    if (!rec || !rec.id) continue
    let escAt = null
    if (rec.prev === 'sent') {
      // 已发送待回执任务恢复后重新计算回执超时（按订阅 ack_timeout_min；无订阅用默认 30 分钟）
      const sub = q1('SELECT ack_timeout_min FROM notify_subs WHERE id=(SELECT sub_id FROM notify_tasks WHERE id=?)', rec.id)
      const timeoutMin = Math.max(1, (sub && sub.ack_timeout_min) || 30)
      escAt = Date.now() + timeoutMin * 60000
    }
    // 状态守卫：仅恢复「仍是结案收口取消态」的任务（结案后被人工删除/流转过的不动，幂等）
    // failed/paused 恢复为 pending 并清空退避时间，重新进入发送队列（与手动重试口径一致）
    const r = run(`UPDATE notify_tasks SET status=?, escalate_at=?, next_retry_at=NULL, updated=?
      WHERE id=? AND status='cancelled'
        AND EXISTS (SELECT 1 FROM notify_logs WHERE task_id=notify_tasks.id AND action='cancelled'
          AND detail='事件结案：在途/待回执通知随结案统一收口（回滚结案时可恢复）')`,
      rec.prev === 'sent' ? 'sent' : 'pending', escAt, ts, rec.id)
    if (!Number(r.changes)) continue
    restoredNotify += 1
    run('INSERT INTO notify_logs (task_id,action,detail,operator,time) VALUES (?,?,?,?,?)',
      rec.id, 'resumed',
      rec.prev === 'sent'
        ? `结案回滚：恢复为结案前状态（已发送待回执，回执超时重新计时）`
        : `结案回滚：恢复为结案前状态（${prevText(rec.prev)}），重新进入发送队列`,
      '系统', ts)
    if (rec.work_order_id) {
      run('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time,notify_task_id,wo_event) VALUES (?,?,?,?,?,?,?,?)',
        rec.work_order_id, 'notify_resumed', '结案回滚：通知恢复为结案前状态', '系统', '', ts, rec.id, '')
    }
  }

  // 清理结案通报：回滚后上一轮结案通报不应再投递（幂等键 crisis:<id>:closed，含已发送待回执的通报）。
  // 已回执/已升级的通报作为留痕保留（终态，无需撤销）；监测/处置通报不在撤销范围。
  let staleClosed = 0
  const staleTasks = q(`SELECT nt.id, nt.work_order_id FROM notify_tasks nt
    WHERE nt.crisis_id=? AND nt.kind='crisis' AND nt.status IN ('pending','failed','paused','sent')
      AND nt.idem_key LIKE ?`, crisisId, `crisis:${crisisId}:closed:%`)
  const affectedWo = new Set()
  for (const t of staleTasks) {
    const r = run("UPDATE notify_tasks SET status='cancelled', escalate_at=NULL, updated=? WHERE id=? AND status IN ('pending','failed','paused','sent')", ts, t.id)
    if (Number(r.changes)) {
      run('INSERT INTO notify_logs (task_id,action,detail,operator,time) VALUES (?,?,?,?,?)',
        t.id, 'cancelled', '结案回滚：撤销上一轮结案通报', '系统', ts)
      staleClosed += 1
      if (t.work_order_id) affectedWo.add(t.work_order_id)
    }
  }
  // 通知恢复后重算受影响工单的链路状态
  for (const woId of [...new Set(settled.filter((x) => x && x.work_order_id).map((x) => x.work_order_id))]) {
    affectedWo.add(woId)
  }
  for (const woId of affectedWo) recomputeWorkOrderState(woId)
  return { restored, restoredNotify, staleClosed }
}

function prevText(p) {
  return { pending: '待发送', failed: '发送失败', paused: '已暂停', sent: '已发送待回执' }[p] || p
}

// 结案档案归档列表序列化（新列缺失时安全降级，兼容历史库）
export function serializeSettled(settledNotify) {
  return JSON.stringify(settledNotify || [])
}
