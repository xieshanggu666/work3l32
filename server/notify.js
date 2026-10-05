import { db } from './db.js'
import { now, addTimeline, LV_TEXT } from './pipeline.js'
import { mirrorNotifyToWorkOrder, addDispatchTimeline, recomputeWorkOrderState } from './dispatch.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// ===== 权限模型（演示）：身份经请求头 x-user / x-role 携带，服务端强制校验 =====
// admin=管理员（配置+任务操作） ops=值班员（任务操作） viewer=观察员（只读）
export const ROLE_TEXT = { admin: '管理员', ops: '值班员', viewer: '观察员' }
const ROLE_RANK = { admin: 3, ops: 2, viewer: 1 }
export function actorOf(req) {
  // x-user 经 encodeURIComponent 编码（HTTP 头不能直接携带非 Latin-1 字符）
  let user = String(req.headers['x-user'] || '').trim()
  try { user = decodeURIComponent(user) } catch { /* 未编码原文直接使用 */ }
  const role = ROLE_RANK[req.headers['x-role']] ? req.headers['x-role'] : 'viewer'
  return { user: user || '匿名用户', role }
}
export function permit(req, need) { // need: 'admin' | 'ops' | 'viewer'
  const a = actorOf(req)
  return ROLE_RANK[a.role] >= ROLE_RANK[need] ? a : null
}

// ===== 调度参数（演示用小时间窗，便于观察自动重试与超时升级） =====
export const TICK_MS = 3000          // 调度扫描间隔
export const RETRY_BASE_MS = 15000   // 失败重试退避基数（第 n 次等待 n × 基数）
const DUE_BATCH = 20                 // 每轮扫描处理上限

export const CHANNEL_TYPES = { webhook: 'Webhook', email: '邮件', sms: '短信', inapp: '站内信' }
export const TASK_STATUS = {
  pending: '待发送', sent: '已发送', failed: '发送失败',
  acked: '已回执', escalated: '已升级', paused: '已暂停', cancelled: '已取消'
}
export const CRISIS_STATUS_TEXT = { monitoring: '监测中', disposal: '处置中', closed: '已结案' }

function safeParse(s, dft) { try { const v = JSON.parse(s || ''); return v ?? dft } catch { return dft } }
const subChannels = (s) => safeParse(s.channel_ids, []) || []
const subLevels = (s) => String(s.levels || '').split(',').map((x) => x.trim()).filter(Boolean)

// 历史追踪：任务全生命周期留痕（操作人缺省为系统/调度器）
// 同时按动作镜像到关联工单日志，使分派→发送→重试→回执/升级在工单链路中可追踪
function addLog(taskId, action, detail, operator = '系统') {
  run('INSERT INTO notify_logs (task_id,action,detail,operator,time) VALUES (?,?,?,?,?)',
    taskId, action, detail || '', operator, now())
  const t = q1('SELECT id, work_order_id, title FROM notify_tasks WHERE id=?', taskId)
  if (t) {
    mirrorNotifyToWorkOrder(t, action, detail, operator)
    if (t.work_order_id) recomputeWorkOrderState(t.work_order_id)
  }
}

// ===== 任务生成（订阅匹配 → 多渠道并行任务；幂等键去重，重复触发不产生重复任务） =====
// opts.kind: alert（预警）/ crisis（危机状态）/ workorder（协同工单事件）/ prop（传播路径事件）/ ext（外部协作门户事件）/ statement（危机声明渠道事件）
function createTasks(sub, { kind, alertEventId = null, crisisId = null, statusKey = '', woId = null, woEvent = '', propPathId = null, extSubmissionId = null, statementId = null, idemTag = '', corrId = '', corrSeq = 0, title, content }) {
  const created = []
  const ts = now()
  for (const chId of subChannels(sub)) {
    const ch = q1('SELECT * FROM notify_channels WHERE id=?', chId)
    if (!ch || !ch.enabled) continue // 停用/已删除渠道跳过
    const src = kind === 'alert' ? `alert:${alertEventId}`
      : kind === 'workorder' ? `wo:${woId}:${idemTag || woEvent}`
      : kind === 'prop' ? `prop:${propPathId}:${idemTag}`
      : kind === 'ext' ? `ext:${extSubmissionId}:${idemTag}`
      : kind === 'statement' ? `stmt:${statementId}:${idemTag}`
      : `crisis:${crisisId}:${statusKey}`
    const r = run(`INSERT OR IGNORE INTO notify_tasks
      (idem_key,sub_id,channel_id,alert_event_id,crisis_id,kind,title,content,status,attempts,max_attempts,require_ack,work_order_id,wo_event,prop_path_id,ext_submission_id,statement_id,corr_id,seq,created,updated)
      VALUES (?,?,?,?,?,?,?,?,'pending',0,?,?,?,?,?,?,?,?,?,?,?)`,
      `${src}:sub${sub.id}:ch${chId}`, sub.id, chId, alertEventId, crisisId,
      kind === 'workorder' ? 'workorder' : kind, title, content,
      Math.max(1, sub.max_retry || 3), sub.require_ack ? 1 : 0, woId,
      woEvent === '' || woEvent == null ? '' : String(woEvent), propPathId, extSubmissionId, statementId,
      corrId || '', corrSeq, ts, ts)
    if (Number(r.changes)) {
      const id = Number(r.lastInsertRowid)
      addLog(id, 'created', `订阅「${sub.name}」匹配，生成通知任务（渠道：${ch.name}）`)
      created.push(id)
    }
  }
  return created
}

// 预警触发 → 通知任务（按规则/话题/级别过滤；危机订阅不响应预警触发）
export function generateForAlertEvent(eventId) {
  const ev = q1(`SELECT ae.*, al.title alert_title, al.level, p.title ptitle, p.topic ptopic
    FROM alert_events ae LEFT JOIN alerts al ON al.id=ae.alert_id LEFT JOIN posts p ON p.id=ae.post_id
    WHERE ae.id=?`, eventId)
  if (!ev) return []
  const title = `【预警通知】${ev.alert_title || '已删除规则'}`
  const content = `${ev.detail} · 关联舆情《${ev.ptitle || '—'}》`
  const all = []
  for (const s of q('SELECT * FROM notify_subs WHERE active=1')) {
    if (s.crisis_status) continue
    if (s.alert_id && s.alert_id !== ev.alert_id) continue
    if (s.topic && s.topic !== (ev.ptopic || '')) continue
    const lv = subLevels(s)
    if (lv.length && !lv.includes(ev.level)) continue
    all.push(...createTasks(s, { kind: 'alert', alertEventId: ev.id, crisisId: ev.crisis_id, title, content }))
  }
  return all
}

// 危机状态流转 → 通知任务（订阅 crisis_status 匹配新状态，话题可再限定；同一状态只通知一次）
export function generateForCrisisStatus(crisisId, status) {
  const c = q1('SELECT * FROM crisis WHERE id=?', crisisId)
  if (!c) return []
  const title = `【危机${CRISIS_STATUS_TEXT[status] || status}】${c.title}`
  const content = `事件 #${c.id} 进入「${CRISIS_STATUS_TEXT[status] || status}」状态 · 话题「${c.topic || '—'}」 · 级别 ${LV_TEXT[c.level] || c.level}`
  const all = []
  for (const s of q('SELECT * FROM notify_subs WHERE active=1 AND crisis_status=?', status)) {
    if (s.topic && s.topic !== c.topic) continue
    all.push(...createTasks(s, { kind: 'crisis', crisisId, statusKey: status, title, content }))
  }
  return all
}

// 启动时为存量未解除预警触发补生成通知任务（幂等：重复启动/重复调用不产生重复任务）
export function seedNotifyTasks() {
  let n = 0
  for (const ev of q("SELECT id FROM alert_events WHERE status='open'")) n += generateForAlertEvent(ev.id).length
  return n
}

// ===== 协同工单事件 → 通知任务（wo_event='created'：拆分分派/认领/改派；'escalated'：超时升级） =====
// 复用通知渠道、失败退避重试、回执与升级调度；幂等键按 工单×事件×订阅×渠道 去重。
export function generateForWorkOrder(woId, woEvent, opts = {}) {
  const w = q1(`SELECT w.*, c.title crisis_title FROM work_orders w LEFT JOIN crisis c ON c.id=w.crisis_id WHERE w.id=?`, woId)
  if (!w) return []
  const all = []
  // 订阅按事件名匹配（created/escalated），升级级别仅体现在文案与幂等标签
  const subEvent = woEvent === 'created' ? 'created' : 'escalated'
  const subs = q(`SELECT * FROM notify_subs WHERE active=1 AND wo_event=?`, subEvent)
  if (!subs.length) return []
  let title, content, idemTag, corrId, corrSeq = 0
  const ev = opts.event || ''
  if (subEvent === 'created') {
    const isReassign = ev === 'reassign'
    const isAssign = ev === 'assign'
    const isClaim = ev === 'claim'
    const kindText = isReassign ? '工单改派' : isClaim ? '工单认领' : isAssign ? '工单分派' : '协同工单'
    title = `【${kindText}】${w.title}`
    const verb = isReassign ? '工单改派' : isClaim ? '工单已认领' : isAssign ? '工单分派' : '拆分工单'
    content = `危机「${w.crisis_title || '#' + w.crisis_id}」${verb} #${w.id} · ${w.assignee ? '处理人：' + w.assignee : '待分派，可认领'} · SLA ${w.due_at ? new Date(w.due_at).toLocaleString('zh-CN') : '无时限'}`
    // 分派/改派/认领按「调度轮次 + 处理人」幂等：同一轮重复触发不重发，新一轮流转可再次触达
    corrSeq = Math.max(0, +opts.seq || 0)
    idemTag = isReassign ? `reassign:${corrSeq}:${opts.to || w.assignee || ''}`
      : isClaim ? `claim:${corrSeq}:${opts.to || w.assignee || ''}`
      : isAssign ? `assign:${corrSeq}:${opts.to || w.assignee || ''}`
      : 'created'
    // 分派/改派/认领共享同一关联根 + 轮次序号，通知看板可按链路聚合多次分派
    corrId = `wo${woId}:dispatch`
  } else {
    // escalated（woEvent=1/2 为升级级别）
    const level = Number(woEvent) || 1
    title = `【工单${level === 2 ? '二级升级督办' : '超时升级'}】${w.title}`
    content = `协同工单 #${w.id} SLA 已到期${level === 2 ? '（一级升级后仍未完成，升级督办至管理员）' : ''} · 处理人：${w.assignee || '待分派'} · 危机「${w.crisis_title || '#' + w.crisis_id}」`
    idemTag = `escalate:${level}`
    corrId = `wo${woId}:escalate`
    corrSeq = level
  }
  for (const s of subs) {
    all.push(...createTasks(s, { kind: 'workorder', woId, woEvent, idemTag, corrId, corrSeq, crisisId: w.crisis_id, title, content }))
  }
  return all
}

// 工单超时升级通知：升级类任务写危机时间线（与回执超时升级一致），由工单调度器驱动
export function notifyWorkOrderEscalation(woId, level) {
  return generateForWorkOrder(woId, level)
}

// ===== 传播路径事件 → 通知任务（prop_event：outbreak 爆发升级 / surge 热度激增 / kol KOL 加入） =====
// 复用通知渠道、失败退避重试、回执与升级调度；幂等键按 路径×事件×订阅×渠道 去重。
const PROP_EVENT_TEXT = { outbreak: '进入爆发期', surge: '热度激增', kol: 'KOL 加入转发' }
export function generateForPropEvent(pathId, propEvent, extra = {}) {
  const p = q1('SELECT * FROM prop_paths WHERE id=?', pathId)
  if (!p || p.status !== 'active') return []
  const all = []
  const subs = q(`SELECT * FROM notify_subs WHERE active=1 AND prop_event=?`, propEvent)
  if (!subs.length) return []
  const titlePrefix = propEvent === 'outbreak' ? '【传播爆发升级】' : '【传播异动】'
  const title = `${titlePrefix}${p.title}`
  const bits = [`话题「${p.topic || '—'}」`, `事件：${PROP_EVENT_TEXT[propEvent] || propEvent}`]
  if (extra.heat) bits.push(`当前热度 ${extra.heat}`)
  if (extra.reach) bits.push(`本跳触达 ${extra.reach}`)
  if (extra.node && extra.node.name) bits.push(`节点「${extra.node.name}」`)
  const content = bits.join(' · ')
  for (const s of subs) {
    if (s.topic && s.topic !== p.topic) continue
    all.push(...createTasks(s, { kind: 'prop', propPathId: pathId, crisisId: p.crisis_id, idemTag: propEvent, title, content }))
  }
  return all
}

// 启动时为存量爆发期路径补生成通知任务（幂等：重复启动不产生重复任务）
export function seedPropNotifyTasks() {
  let n = 0
  for (const p of q("SELECT id FROM prop_paths WHERE status='active' AND stage='outbreak'")) {
    n += generateForPropEvent(p.id, 'outbreak').length
  }
  return n
}

// ===== 外部协作门户事件 → 通知任务（ext_event：submitted 提交到达 / escalated 紧急升级） =====
// 复用通知渠道、失败退避重试、回执与升级调度；幂等键按 提交×事件×订阅×渠道 去重。
export function generateForExtSubmission(subId, isUrgent = false) {
  const s = q1(`SELECT s.*, p.name partner_name, c.title crisis_title
    FROM ext_submissions s LEFT JOIN ext_partners p ON p.id=s.partner_id
    LEFT JOIN crisis c ON c.id=s.crisis_id WHERE s.id=?`, subId)
  if (!s) return []
  // 紧急提交同时触发「升级督办」与「提交提醒」；普通提交仅触发「提交提醒」
  const events = isUrgent ? ['escalated', 'submitted'] : ['submitted']
  const all = []
  for (const ev of events) {
    const subs = q(`SELECT * FROM notify_subs WHERE active=1 AND ext_event=?`, ev)
    if (!subs.length) continue
    const title = ev === 'escalated'
      ? `【外部协作·紧急升级】${s.title}`
      : `【外部协作提交】${s.title}`
    const kindLabel = { brand: '品牌方', regulator: '监管方', media: '媒体' }[s.kind] || '外部协作方'
    const docLabel = { evidence: '证据材料', rectify: '整改进度', clue: '线索反映' }[s.doc_type] || '材料'
    const bits = [`${kindLabel}（${s.partner_name || '—'}）提交${docLabel}`]
    if (s.crisis_title) bits.push(`危机「${s.crisis_title}」`)
    if (ev === 'escalated') bits.push('提交方标记紧急，请立即核查处置')
    const content = bits.join(' · ') + ` · 编号 ${s.code}`
    for (const sub of subs) {
      all.push(...createTasks(sub, {
        kind: 'ext', extSubmissionId: s.id, crisisId: s.crisis_id,
        idemTag: ev, title, content
      }))
    }
  }
  return all
}

// 启动时为存量待审核紧急提交补生成升级通知（幂等：重复启动不产生重复任务）
export function seedExtNotifyTasks() {
  let n = 0
  for (const s of q("SELECT id,is_urgent FROM ext_submissions WHERE status IN ('pending','reviewing') AND is_urgent=1")) {
    n += generateForExtSubmission(s.id, true).length
  }
  return n
}

// ===== 危机声明渠道事件 → 通知任务（stmt_event：chfail 单渠道发布失败 / partial 全渠道登记完但存在失败） =====
// 复用通知渠道、失败退避重试、回执与升级调度；幂等键按 声明×事件（×渠道行）×订阅×渠道 去重。
// chfail：每次渠道登记失败即时通知（同一渠道行重复登记失败按行幂等，重试后再失败可再次通知）；
// partial：全部渠道到达终态但仍有失败渠道（声明进入「部分失败」、阻塞结案）时的督办通知，按声明幂等。
export const STMT_EVENT_TEXT = { chfail: '渠道发布失败', partial: '部分渠道失败·发布未完成' }
export function generateForStatement(stmtId, stmtEvent, extra = {}) {
  const s = q1(`SELECT s.*, c.title crisis_title, c.topic crisis_topic
    FROM crisis_statements s LEFT JOIN crisis c ON c.id=s.crisis_id WHERE s.id=?`, stmtId)
  if (!s) return []
  const all = []
  const subs = q(`SELECT * FROM notify_subs WHERE active=1 AND stmt_event=?`, stmtEvent)
  if (!subs.length) return []
  const topic = s.crisis_topic || ''
  const title = stmtEvent === 'partial'
    ? `【声明发布未完成·部分渠道失败】${s.title}`
    : `【声明渠道发布失败】${s.title}`
  let idemTag
  if (stmtEvent === 'chfail') {
    const chRow = extra.channelRow ? q1('SELECT * FROM crisis_statement_channels WHERE id=?', extra.channelRow) : null
    const chName = chRow ? (chRow.channel_name || chRow.channel) : (extra.channelName || '')
    const failReason = chRow ? chRow.fail_reason : (extra.failReason || '')
    const ok = extra.ok ?? 0
    const total = extra.total ?? 0
    const failed = extra.failed ?? 1
    // 幂等粒度：渠道行 + 第几次执行尝试——重复登记失败不重发，重试后再失败可再次通知
    idemTag = `chfail:${extra.channelRow || chName}:a${extra.attempt ?? 1}`
    for (const sub of subs) {
      if (sub.topic && sub.topic !== topic) continue
      const content = `危机「${s.crisis_title || '#' + s.crisis_id}」声明「${s.title}」渠道【${chName || '未知渠道'}】发布失败` +
        (failReason ? `：${failReason}` : '') + ` · 当前 ${ok}/${total} 个渠道已发布、${failed} 个失败，可重试或放弃该渠道`
      all.push(...createTasks(sub, {
        kind: 'statement', statementId: s.id, crisisId: s.crisis_id,
        idemTag, corrId: `stmt${s.id}:channels`, title, content
      }))
    }
  } else {
    // partial：声明级督办（同一声明仅生成一次；重试恢复后再次失败以新事件轮次区分）
    const round = Math.max(1, +extra.partialRound || 1)
    idemTag = `partial:${round}`
    for (const sub of subs) {
      if (sub.topic && sub.topic !== topic) continue
      const content = `危机「${s.crisis_title || '#' + s.crisis_id}」声明「${s.title}」分渠道登记全部结束但存在失败渠道：` +
        `${extra.ok ?? 0}/${extra.total ?? 0} 个渠道已发布、${extra.failed ?? 0} 个失败` +
        (extra.cancelled ? `、${extra.cancelled} 个取消` : '') +
        '；发布未完成，危机暂不能结案，请重试失败渠道或放弃该渠道（取消）'
      all.push(...createTasks(sub, {
        kind: 'statement', statementId: s.id, crisisId: s.crisis_id,
        idemTag, corrId: `stmt${s.id}:partial`, corrSeq: round, title, content
      }))
    }
  }
  return all
}

// 启动时为存量「部分失败」声明补生成督办通知（幂等：重复启动不产生重复任务）
export function seedStatementNotifyTasks() {
  let n = 0
  for (const s of q("SELECT id FROM crisis_statements WHERE status='partial'")) {
    n += generateForStatement(s.id, 'partial', { partialRound: 1 }).length
  }
  return n
}

// ===== 模拟发送（演示）：渠道地址含 always-fail 持续失败、含 flaky 首次失败（验证自动重试） =====
function mockSend(ch, attempts) {
  const target = ch.target || ''
  if (target.includes('always-fail')) throw new Error(`渠道「${ch.name}」持续不可用（模拟故障）`)
  if (target.includes('flaky') && attempts === 0) throw new Error(`渠道「${ch.name}」瞬时故障（模拟，重试可恢复）`)
}

// 发送一次：成功置 sent（需回执的启动超时升级倒计时）；失败按退避重试，达上限置 failed
function attemptSend(t) {
  const ch = q1('SELECT * FROM notify_channels WHERE id=?', t.channel_id)
  const ts = now()
  const attempt = t.attempts + 1
  try {
    if (!ch) throw new Error('通知渠道不存在（可能已删除）')
    if (!ch.enabled) throw new Error(`渠道「${ch.name}」已停用`)
    mockSend(ch, t.attempts)
    const sub = t.sub_id ? q1('SELECT ack_timeout_min FROM notify_subs WHERE id=?', t.sub_id) : null
    const timeoutMin = Math.max(1, (sub && sub.ack_timeout_min) || 30)
    const escAt = t.require_ack ? Date.now() + timeoutMin * 60000 : null
    // 状态守卫：仅 pending 可发送（暂停/取消竞态下不发出）
    const r = run(`UPDATE notify_tasks SET status='sent', attempts=attempts+1, sent_at=?, last_error='',
      next_retry_at=NULL, escalate_at=?, updated=? WHERE id=? AND status='pending'`, ts, escAt, ts, t.id)
    if (Number(r.changes)) {
      addLog(t.id, 'sent', `经渠道「${ch.name}」发送成功（第 ${attempt} 次尝试）` +
        (t.require_ack ? `，等待回执（${timeoutMin} 分钟未确认将自动升级）` : ''))
    }
  } catch (e) {
    const msg = String(e.message || e)
    const giveUp = attempt >= t.max_attempts
    const r = run(`UPDATE notify_tasks SET status=?, attempts=attempts+1, last_error=?, next_retry_at=?, updated=?
      WHERE id=? AND status='pending'`,
      giveUp ? 'failed' : 'pending', msg, giveUp ? null : Date.now() + RETRY_BASE_MS * attempt, ts, t.id)
    if (Number(r.changes)) {
      addLog(t.id, giveUp ? 'failed' : 'retry', giveUp
        ? `第 ${attempt} 次发送失败，已达重试上限（${t.max_attempts} 次）：${msg}，可手动重试`
        : `第 ${attempt} 次发送失败：${msg}，${(RETRY_BASE_MS * attempt) / 1000} 秒后自动重试`)
    }
  }
}

// 回执超时升级：原任务标记已升级，向升级渠道生成【升级】任务（升级任务不再二次升级），并写危机时间线
function escalateTask(t) {
  const ts = now()
  // 结案安全守卫：危机结案时在途通知已统一中止；此处兜底处理遗漏/竞态（如结案事务与调度并发）的待回执任务——
  // 已结案事件不再催办、不生成升级任务，直接按结案口径中止，保证结案档案稳定。
  const crisisRef = resolveTaskSources(t).crisisId
  if (crisisRef) {
    const cc = q1('SELECT status FROM crisis WHERE id=?', crisisRef)
    if (cc && cc.status === 'closed') {
      const r = run(`UPDATE notify_tasks SET status='cancelled', updated=? WHERE id=? AND status='sent'`, ts, t.id)
      if (Number(r.changes)) addLog(t.id, 'cancelled', '关联危机已结案，待回执通知按结案口径中止，不再超时升级', '系统')
      return
    }
  }
  db.exec('BEGIN')
  try {
    const r = run(`UPDATE notify_tasks SET escalated=1, status='escalated', updated=? WHERE id=? AND escalated=0 AND status='sent'`, ts, t.id)
    if (!Number(r.changes)) { db.exec('ROLLBACK'); return }
    const sub = t.sub_id ? q1('SELECT * FROM notify_subs WHERE id=?', t.sub_id) : null
    const chId = (sub && sub.escalate_channel_id) || t.channel_id
    const ch = q1('SELECT * FROM notify_channels WHERE id=?', chId)
    addLog(t.id, 'escalated', `回执超时未确认，通知升级至渠道「${ch ? ch.name : '已删除'}」`)
    // 升级子任务继承来源链路的全部关联键：
    //   corr_id/seq 与来源任务同根；alert_event_id/work_order_id/wo_event 随工单链路追踪；
    //   prop_path_id/ext_submission_id 必须一并继承——否则传播路径、外部协作来源在升级后丢失，
    //   会导致危机删除级联误判（来源保留任务无法按来源识别）、复盘统计与门户追踪口径不一致。
    // 危机引用按「来源对象当前归属」重新解析：父任务创建后危机可能已被删除（引用悬空），
    // 而传播路径/外部提交保留且挂有现存危机时，升级链仍应归属该危机（时间线/统计同源）。
    const { crisisId: resolvedCrisisId, propPathId, extSubmissionId, statementId } = resolveTaskSources(t)
    const childCorr = t.corr_id
      ? (/:(escalate|ackEsc)/.test(t.corr_id) ? t.corr_id : `${t.corr_id}:ackEsc`)
      : (t.work_order_id ? `wo${t.work_order_id}:ackEsc:${t.id}` : `task${t.id}:ackEsc`)
    const cr = run(`INSERT OR IGNORE INTO notify_tasks
      (idem_key,sub_id,channel_id,alert_event_id,crisis_id,kind,title,content,status,attempts,max_attempts,next_retry_at,require_ack,escalated_from,work_order_id,wo_event,prop_path_id,ext_submission_id,statement_id,corr_id,seq,created,updated)
      VALUES (?,?,?,?,?,?,?,?, 'pending',0,?,NULL,?, ?,?,?,?,?,?,?,?,?,?)`,
      `esc:${t.id}:ch${chId}`, t.sub_id, chId, t.alert_event_id, resolvedCrisisId, t.kind,
      `【升级】${t.title}`, t.content,
      Math.max(1, t.max_attempts), t.require_ack, t.id,
      t.work_order_id, t.wo_event, propPathId, extSubmissionId, statementId, childCorr, (t.seq || 0) + 1, ts, ts)
    if (Number(cr.changes)) {
      const childId = Number(cr.lastInsertRowid)
      addLog(childId, 'created', `任务 #${t.id} 回执超时升级生成`)
    }
    if (resolvedCrisisId) {
      const c = q1('SELECT status FROM crisis WHERE id=?', resolvedCrisisId)
      if (c && c.status !== 'closed') {
        const refType = t.work_order_id ? 'workorder' : statementId ? 'statement' : 'notify'
        const refId = t.work_order_id || statementId || t.id
        addDispatchTimeline(resolvedCrisisId, '通知升级',
          `通知「${t.title}」回执超时未确认，已升级至渠道「${ch ? ch.name : '—'}」`,
          { woId: t.work_order_id, refType, refId, time: ts })
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
}

// 解析任务的全部来源关联（含来源对象当前的危机归属）。
// 升级链上的任务以父任务为准；父任务来源缺失（历史升级任务）时回查来源对象补齐：
//   · prop：传播路径（删除危机时路径保留，crisis_id 可能已被解除后重新挂接）
//   · ext ：外部协作提交（跨主体留痕，删除危机时仅解除引用）
//   · alert：预警触发记录（删除危机时仅解除引用，crisis_id 恒为现存危机或 NULL）
//   · workorder：工单随危机删除，不存在悬空引用
function resolveTaskSources(t) {
  let crisisId = t.crisis_id
  let propPathId = t.prop_path_id ?? null
  let extSubmissionId = t.ext_submission_id ?? null
  let statementId = t.statement_id ?? null
  if (t.kind === 'prop' || propPathId) {
    if (!propPathId && t.escalated_from) {
      const p = q1('SELECT prop_path_id FROM notify_tasks WHERE id=?', t.escalated_from)
      propPathId = p ? p.prop_path_id ?? null : null
    }
    if (propPathId) {
      const p = q1('SELECT crisis_id FROM prop_paths WHERE id=?', propPathId)
      if (p) crisisId = p.crisis_id ?? null
      else { propPathId = null; crisisId = null } // 来源路径已删除（不应发生：路径删除需级联清理）
    }
  } else if (t.kind === 'ext' || extSubmissionId) {
    if (!extSubmissionId && t.escalated_from) {
      const p = q1('SELECT ext_submission_id FROM notify_tasks WHERE id=?', t.escalated_from)
      extSubmissionId = p ? p.ext_submission_id ?? null : null
    }
    if (extSubmissionId) {
      const s = q1('SELECT crisis_id FROM ext_submissions WHERE id=?', extSubmissionId)
      if (s) crisisId = s.crisis_id ?? null
      else { extSubmissionId = null; crisisId = null }
    }
  } else if (t.kind === 'statement' || statementId) {
    if (!statementId && t.escalated_from) {
      const p = q1('SELECT statement_id FROM notify_tasks WHERE id=?', t.escalated_from)
      statementId = p ? p.statement_id ?? null : null
    }
    if (statementId) {
      const st = q1('SELECT crisis_id FROM crisis_statements WHERE id=?', statementId)
      if (st) crisisId = st.crisis_id ?? null
      else { statementId = null; crisisId = null }
    }
  } else if (t.alert_event_id && !crisisId) {
    const ev = q1('SELECT crisis_id FROM alert_events WHERE id=?', t.alert_event_id)
    if (ev) crisisId = ev.crisis_id ?? null
  }
  // 悬空的危机引用（危机已删除）一律解除，避免幽灵任务与脏统计
  if (crisisId && !q1('SELECT 1 FROM crisis WHERE id=?', crisisId)) crisisId = null
  return { crisisId: crisisId ?? null, propPathId: propPathId ?? null, extSubmissionId: extSubmissionId ?? null, statementId: statementId ?? null }
}

// 调度一轮：到期发送/重试 + 回执超时升级（导出供测试与手动触发）
export function runNotifyTick() {
  const nowMs = Date.now()
  const due = q(`SELECT * FROM notify_tasks WHERE status='pending' AND (next_retry_at IS NULL OR next_retry_at<=?)
    ORDER BY id LIMIT ?`, nowMs, DUE_BATCH)
  for (const t of due) attemptSend(t)
  const esc = q(`SELECT * FROM notify_tasks WHERE require_ack=1 AND escalated=0 AND escalated_from IS NULL
    AND status='sent' AND escalate_at IS NOT NULL AND escalate_at<=? LIMIT ?`, nowMs, DUE_BATCH)
  for (const t of esc) escalateTask(t)
}

let timer = null
export function startScheduler() {
  if (timer) return
  timer = setInterval(() => {
    try { runNotifyTick() } catch (e) { console.error('[NOTIFY] 调度异常：', e.message) }
  }, TICK_MS)
  if (timer.unref) timer.unref()
  console.log(`[NOTIFY] 通知调度器已启动（每 ${TICK_MS / 1000} 秒扫描：发送 / 失败重试 / 回执超时升级）`)
}
export function stopScheduler() { if (timer) clearInterval(timer); timer = null }

// ===== 任务操作（可暂停/恢复/手动重试/取消/确认回执；均带状态守卫，并发幂等） =====
export function getTask(id) {
  const t = q1(`SELECT nt.*, nc.name channel_name, nc.type channel_type, ns.name sub_name
    FROM notify_tasks nt LEFT JOIN notify_channels nc ON nc.id=nt.channel_id
    LEFT JOIN notify_subs ns ON ns.id=nt.sub_id WHERE nt.id=?`, id)
  return t ? { ...t, statusText: TASK_STATUS[t.status] || t.status } : null
}

export function listTasks({ status = '', limit = 100 } = {}) {
  let sql = `SELECT nt.*, nc.name channel_name, nc.type channel_type, ns.name sub_name
    FROM notify_tasks nt LEFT JOIN notify_channels nc ON nc.id=nt.channel_id
    LEFT JOIN notify_subs ns ON ns.id=nt.sub_id`
  const args = []
  if (status) { sql += ' WHERE nt.status=?'; args.push(status) }
  sql += ' ORDER BY nt.id DESC LIMIT ?'
  args.push(limit)
  const tasks = q(sql, ...args).map((t) => ({ ...t, statusText: TASK_STATUS[t.status] || t.status }))
  const counts = {}
  for (const r of q('SELECT status, COUNT(*) c FROM notify_tasks GROUP BY status')) counts[r.status] = r.c
  return { tasks, counts }
}

export function pauseTask(id, actor) {
  const t = q1('SELECT * FROM notify_tasks WHERE id=?', id)
  if (!t) return null
  if (!['pending', 'failed'].includes(t.status)) return { error: `当前状态（${TASK_STATUS[t.status] || t.status}）不可暂停`, task: getTask(id) }
  const r = run(`UPDATE notify_tasks SET status='paused', pause_prev=?, updated=? WHERE id=? AND status IN ('pending','failed')`,
    t.status, now(), id)
  if (Number(r.changes)) addLog(id, 'paused', `任务暂停（暂停前：${TASK_STATUS[t.status]}）`, actor.user)
  return { ok: true, task: getTask(id) }
}

export function resumeTask(id, actor) {
  const t = q1('SELECT * FROM notify_tasks WHERE id=?', id)
  if (!t) return null
  if (t.status !== 'paused') return { error: '任务未处于暂停状态', task: getTask(id) }
  const r = run(`UPDATE notify_tasks SET status='pending', next_retry_at=NULL, pause_prev='', updated=? WHERE id=? AND status='paused'`, now(), id)
  if (Number(r.changes)) addLog(id, 'resumed', '任务恢复，重新进入发送队列', actor.user)
  return { ok: true, task: getTask(id) }
}

export function retryTask(id, actor) {
  const t = q1('SELECT * FROM notify_tasks WHERE id=?', id)
  if (!t) return null
  if (t.status !== 'failed') return { error: '仅发送失败的任务可手动重试', task: getTask(id) }
  const r = run(`UPDATE notify_tasks SET status='pending', attempts=0, next_retry_at=NULL, last_error='', updated=? WHERE id=? AND status='failed'`, now(), id)
  if (Number(r.changes)) addLog(id, 'retry', '手动重试：重置发送计数，重新进入发送队列', actor.user)
  return { ok: true, task: getTask(id) }
}

export function cancelTask(id, actor) {
  const t = q1('SELECT * FROM notify_tasks WHERE id=?', id)
  if (!t) return null
  if (!['pending', 'failed', 'paused'].includes(t.status)) return { error: `当前状态（${TASK_STATUS[t.status] || t.status}）不可取消`, task: getTask(id) }
  const r = run(`UPDATE notify_tasks SET status='cancelled', updated=? WHERE id=? AND status IN ('pending','failed','paused')`, now(), id)
  if (Number(r.changes)) addLog(id, 'cancelled', '任务已取消', actor.user)
  return { ok: true, task: getTask(id) }
}

// 确认回执：幂等；同步解除关联预警（resolve_kind=notify）并写入危机时间线，完成「通知→处置」闭环
export function ackTask(id, actor, note = '') {
  const t = q1('SELECT * FROM notify_tasks WHERE id=?', id)
  if (!t) return null
  if (t.status === 'acked') return { already: true, task: getTask(id) }
  if (!t.require_ack) return { error: '该任务无需确认回执', task: getTask(id) }
  if (!['sent', 'escalated'].includes(t.status)) {
    return { error: `当前状态（${TASK_STATUS[t.status] || t.status}）不能确认回执`, task: getTask(id) }
  }
  const ts = now()
  let resolved = 0
  // 升级子任务可能携带与父任务一致的来源（prop_path_id/ext_submission_id）；危机归属按来源对象
  // 当前归属解析，避免对已删除危机写时间线、并保证回执统计与门户/路径追踪同口径。
  const src = resolveTaskSources(t)
  let crisisId = src.crisisId
  const statementId = src.statementId
  db.exec('BEGIN')
  try {
    const r = run(`UPDATE notify_tasks SET status='acked', ack_by=?, ack_at=?, ack_note=?, updated=?
      WHERE id=? AND status IN ('sent','escalated')`, actor.user, ts, note, ts, id)
    if (!Number(r.changes)) { db.exec('ROLLBACK'); return { already: true, task: getTask(id) } }
    addLog(id, 'acked', note ? `确认回执：${note}` : '确认回执', actor.user)
    // 回执同步①：关联预警触发记录解除（状态守卫，重复回执/并发不重复解除）
    let alertEventId = t.alert_event_id
    if (!alertEventId && t.escalated_from) {
      const p = q1('SELECT alert_event_id FROM notify_tasks WHERE id=?', t.escalated_from)
      alertEventId = p ? p.alert_event_id ?? null : null
    }
    if (alertEventId) {
      const rr = run(`UPDATE alert_events SET status='resolved', resolved=?, resolve_kind='notify' WHERE id=? AND status='open'`, ts, alertEventId)
      resolved = Number(rr.changes || 0)
      if (!crisisId) {
        const ev = q1('SELECT crisis_id FROM alert_events WHERE id=?', alertEventId)
        crisisId = ev ? ev.crisis_id : null
      }
    }
    // 回执同步②：危机时间线（已结案事件不再回写，保持结案档案稳定）；带工单锚点便于看板跳转
    if (crisisId) {
      const c = q1('SELECT status FROM crisis WHERE id=?', crisisId)
      if (c && c.status !== 'closed') {
        addDispatchTimeline(crisisId, '通知回执',
          `通知「${t.title}」已由 ${actor.user} 确认回执${note ? `：${note}` : ''}${resolved ? '，同步解除关联预警' : ''}`,
          { woId: t.work_order_id, refType: t.work_order_id ? 'workorder' : statementId ? 'statement' : 'notify', refId: t.work_order_id || statementId || t.id, time: ts })
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  return { ok: true, resolved, crisisId, task: getTask(id) }
}

// ===== 升级链来源修复（幂等，启动时与危机删除前调用） =====
// 早期版本的回执超时升级只继承 work_order_id/corr_id，未继承 prop_path_id/ext_submission_id，
// 也不重新解析来源对象当前的危机归属。后果：
//   · 传播/外部协作任务一旦超时升级，升级子任务来源丢失，门户/路径追踪断链；
//   · 删除危机时升级子任务无法按「来源保留」识别，被解除危机引用后成为无来源幽灵任务；
//   · 复盘快照按 crisis_id 聚合通知，升级子任务口径缺失。
// 逐任务按来源对象（父升级链 / 路径 / 外部提交 / 预警触发）补齐来源键并悬空已删危机引用；
// 来源对象已不存在的任务（升级链父任务丢失等）连同留痕删除。返回 { healed, orphanDeleted }。
export function healNotifySourceLinks() {
  let healed = 0
  // 候选：升级子任务（可能缺来源键）或危机引用悬空的任务；逐行幂等修复，可反复执行
  const candidates = q(`SELECT * FROM notify_tasks
    WHERE escalated_from IS NOT NULL
       OR (crisis_id IS NOT NULL AND crisis_id NOT IN (SELECT id FROM crisis))`)
  const deleteIds = new Set()
  for (const t of candidates) {
    const parent = t.escalated_from ? q1('SELECT * FROM notify_tasks WHERE id=?', t.escalated_from) : null

    let propPathId = t.prop_path_id ?? null
    let extSubmissionId = t.ext_submission_id ?? null
    let alertEventId = t.alert_event_id ?? null
    let workOrderId = t.work_order_id ?? null
    let statementId = t.statement_id ?? null
    // ① 沿升级链（一层）从父任务继承缺失的来源键；work_order_id/wo_event/kind 同样兜底
    if (parent) {
      if (!propPathId) propPathId = parent.prop_path_id ?? null
      if (!extSubmissionId) extSubmissionId = parent.ext_submission_id ?? null
      if (!alertEventId) alertEventId = parent.alert_event_id ?? null
      if (!workOrderId) workOrderId = parent.work_order_id ?? null
      if (!statementId) statementId = parent.statement_id ?? null
    }
    const kind = parent && parent.kind !== 'alert' && t.kind === 'alert' ? parent.kind : t.kind
    const woEvent = t.wo_event || (parent ? parent.wo_event || '' : '')

    // ② 按来源对象解析当前危机归属；来源对象已删除 → 标记为孤儿
    let sourceCrisis = null
    let isOrphan = false
    if (kind === 'prop' || propPathId) {
      const p = propPathId ? q1('SELECT crisis_id FROM prop_paths WHERE id=?', propPathId) : null
      if (propPathId && !p) isOrphan = true
      else sourceCrisis = p ? p.crisis_id ?? null : null
    } else if (kind === 'ext' || extSubmissionId) {
      const s = extSubmissionId ? q1('SELECT crisis_id FROM ext_submissions WHERE id=?', extSubmissionId) : null
      if (extSubmissionId && !s) isOrphan = true
      else sourceCrisis = s ? s.crisis_id ?? null : null
    } else if (kind === 'statement' || statementId) {
      // 声明随危机物理删除：声明类任务（含升级链）无来源可追溯 → 孤儿删除
      const st = statementId ? q1('SELECT crisis_id FROM crisis_statements WHERE id=?', statementId) : null
      if (statementId && !st) isOrphan = true
      else sourceCrisis = st ? st.crisis_id ?? null : null
    } else if (alertEventId) {
      const ev = q1('SELECT crisis_id FROM alert_events WHERE id=?', alertEventId)
      if (ev) sourceCrisis = ev.crisis_id ?? null
    } else if (workOrderId) {
      const w = q1('SELECT crisis_id FROM work_orders WHERE id=?', workOrderId)
      if (w) sourceCrisis = w.crisis_id ?? null
      else isOrphan = true
    }
    // 父任务已不存在的升级子任务：无任何来源可追溯 → 孤儿删除
    if (!parent && t.escalated_from) isOrphan = true

    if (isOrphan) { deleteIds.add(t.id); continue }

    // ③ 危机引用：悬空（危机已删除）时按来源当前归属回填或置空；有效引用保持不动
    let crisisId = t.crisis_id ?? null
    if (crisisId && !q1('SELECT 1 FROM crisis WHERE id=?', crisisId)) {
      crisisId = sourceCrisis
    }

    const changed = crisisId !== (t.crisis_id ?? null)
      || propPathId !== (t.prop_path_id ?? null)
      || extSubmissionId !== (t.ext_submission_id ?? null)
      || alertEventId !== (t.alert_event_id ?? null)
      || workOrderId !== (t.work_order_id ?? null)
      || statementId !== (t.statement_id ?? null)
      || kind !== t.kind || woEvent !== (t.wo_event || '')
    if (changed) {
      run(`UPDATE notify_tasks SET crisis_id=?, prop_path_id=?, ext_submission_id=?, alert_event_id=?,
        work_order_id=?, statement_id=?, kind=?, wo_event=? WHERE id=?`,
        crisisId ?? null, propPathId ?? null, extSubmissionId ?? null, alertEventId ?? null,
        workOrderId ?? null, statementId ?? null, kind, woEvent, t.id)
      healed += 1
    }
  }
  // 级联删除孤儿的升级链后代（循环兜底链深 >1 的历史异常数据）
  for (;;) {
    const ids = [...deleteIds]
    if (!ids.length) break
    const ph = ids.map(() => '?').join(',')
    const fresh = q(`SELECT id FROM notify_tasks WHERE escalated_from IN (${ph})`, ...ids).filter((r) => !deleteIds.has(r.id))
    if (!fresh.length) break
    for (const r of fresh) deleteIds.add(r.id)
  }
  let orphanDeleted = 0
  if (deleteIds.size) {
    const ids = [...deleteIds]
    const ph = ids.map(() => '?').join(',')
    run(`DELETE FROM notify_logs WHERE task_id IN (${ph})`, ...ids)
    orphanDeleted = Number(run(`DELETE FROM notify_tasks WHERE id IN (${ph})`, ...ids).changes || 0)
  }
  return { healed, orphanDeleted }
}

// ===== 危机删除级联（由 index.js 危机删除链路调用，与删除同事务） =====
// 口径与危机删除的整体哲学一致——来源对象随事件删除的任务一并删除，来源对象保留的任务仅解除危机引用：
// ① 工单链路任务（work_order_id 命中该危机工单）：工单随事件删除，任务留存即成幽灵提醒并被调度器继续发送；
// ② 危机状态类任务（kind='crisis'）：来源即危机本身；
// ③ 升级链孤儿（escalated_from 指向被删任务）：父任务不存，子任务一并删除；
// ④ 预警/传播/外部协作类任务：触发记录/路径/外部提交均保留（仅解除危机引用），任务同步解除危机引用——
//    既不残留已删危机的幽灵引用，也避免重启补生成（seed*）把任务再次复活；
// 前提：先经 healNotifySourceLinks 修复升级链来源，传播/外部协作升级子任务才能按来源正确分类。
// 任务留痕（notify_logs）随任务删除。返回 { deleted, detached }。
export function deleteNotifyOfCrisis(crisisId) {
  const delIds = new Set()
  for (const r of q("SELECT id FROM notify_tasks WHERE crisis_id=? AND kind='crisis'", crisisId)) delIds.add(r.id)
  const woIds = q('SELECT id FROM work_orders WHERE crisis_id=?', crisisId).map((r) => r.id)
  if (woIds.length) {
    const ph = woIds.map(() => '?').join(',')
    for (const r of q(`SELECT id FROM notify_tasks WHERE work_order_id IN (${ph})`, ...woIds)) delIds.add(r.id)
  }
  // 危机声明随事件物理删除：声明渠道类任务（含其回执超时升级链）一并删除
  const stmtIds = q('SELECT id FROM crisis_statements WHERE crisis_id=?', crisisId).map((r) => r.id)
  if (stmtIds.length) {
    const ph = stmtIds.map(() => '?').join(',')
    for (const r of q(`SELECT id FROM notify_tasks WHERE statement_id IN (${ph})`, ...stmtIds)) delIds.add(r.id)
  }
  // 升级链：被删任务的升级子任务中，来源随事件删除（工单/声明/危机/无来源继承）的一并删除；
  // 来源保留（传播路径/外部提交/预警触发）的升级子任务保留，仅在最后随父任务解除危机引用。
  for (;;) {
    const ids = [...delIds]
    if (!ids.length) break
    const ph = ids.map(() => '?').join(',')
    const fresh = q(`SELECT id, kind, prop_path_id, ext_submission_id, alert_event_id, statement_id
      FROM notify_tasks WHERE escalated_from IN (${ph})`, ...ids).filter((r) => !delIds.has(r.id))
    if (!fresh.length) break
    for (const r of fresh) {
      const sourceKept = (r.kind === 'prop' && r.prop_path_id && q1('SELECT 1 FROM prop_paths WHERE id=?', r.prop_path_id))
        || (r.kind === 'ext' && r.ext_submission_id && q1('SELECT 1 FROM ext_submissions WHERE id=?', r.ext_submission_id))
        || (r.alert_event_id && q1('SELECT 1 FROM alert_events WHERE id=?', r.alert_event_id))
      if (!sourceKept) delIds.add(r.id)
    }
    if (fresh.every((r) => !delIds.has(r.id))) break
  }
  let deleted = 0
  if (delIds.size) {
    const ids = [...delIds]
    const ph = ids.map(() => '?').join(',')
    run(`DELETE FROM notify_logs WHERE task_id IN (${ph})`, ...ids)
    deleted = Number(run(`DELETE FROM notify_tasks WHERE id IN (${ph})`, ...ids).changes || 0)
  }
  // 来源对象保留的任务（含传播/外部协作/预警的升级子任务）：解除危机引用
  // （与 alert_events/prop_paths/ext_submissions 的 detach 口径一致）
  const detached = Number(run('UPDATE notify_tasks SET crisis_id=NULL WHERE crisis_id=?', crisisId).changes || 0)
  return { deleted, detached }
}

// ===== 危机声明删除级联（由 statements.deleteStatementsOfCrisis 调用） =====
// 声明随危机物理删除：声明渠道类任务及其回执超时升级链已无追溯对象，连同留痕删除（幂等清理）。
// 返回删除条数。
export function deleteNotifyOfStatement(stmtId) {
  const delIds = new Set()
  for (const r of q('SELECT id FROM notify_tasks WHERE statement_id=?', stmtId)) delIds.add(r.id)
  for (;;) {
    const ids = [...delIds]
    if (!ids.length) break
    const ph = ids.map(() => '?').join(',')
    const fresh = q(`SELECT id FROM notify_tasks WHERE escalated_from IN (${ph})`, ...ids).filter((r) => !delIds.has(r.id))
    if (!fresh.length) break
    for (const r of fresh) delIds.add(r.id)
  }
  if (!delIds.size) return 0
  const ids = [...delIds]
  const ph = ids.map(() => '?').join(',')
  run(`DELETE FROM notify_logs WHERE task_id IN (${ph})`, ...ids)
  return Number(run(`DELETE FROM notify_tasks WHERE id IN (${ph})`, ...ids).changes || 0)
}

// ===== 传播路径删除级联（由 propagate.deleteProp 调用） =====
// 传播路径是通知任务的来源对象：路径删除后，来源任务及其升级链（含传播来源继承的子任务）
// 已无追溯对象，须连同留痕删除，调度器不再发送、门户追踪与复盘统计同步扣减（幂等清理）。
// 返回删除条数。
export function deleteNotifyOfPropPath(pathId) {
  const delIds = new Set()
  for (const r of q('SELECT id FROM notify_tasks WHERE prop_path_id=?', pathId)) delIds.add(r.id)
  for (;;) {
    const ids = [...delIds]
    if (!ids.length) break
    const ph = ids.map(() => '?').join(',')
    const fresh = q(`SELECT id FROM notify_tasks WHERE escalated_from IN (${ph})`, ...ids).filter((r) => !delIds.has(r.id))
    if (!fresh.length) break
    for (const r of fresh) delIds.add(r.id)
  }
  if (!delIds.size) return 0
  const ids = [...delIds]
  const ph = ids.map(() => '?').join(',')
  run(`DELETE FROM notify_logs WHERE task_id IN (${ph})`, ...ids)
  return Number(run(`DELETE FROM notify_tasks WHERE id IN (${ph})`, ...ids).changes || 0)
}

// ===== 配置（渠道 + 订阅） =====
export function listConfig() {
  const channels = q('SELECT * FROM notify_channels ORDER BY id')
  const subs = q('SELECT * FROM notify_subs ORDER BY id DESC').map((s) => ({
    ...s,
    channel_list: subChannels(s).map((id) => q1('SELECT id,name,type,enabled FROM notify_channels WHERE id=?', id)).filter(Boolean),
    level_list: subLevels(s)
  }))
  return { channels, subs }
}

export function validateChannel(b) {
  if (!b || typeof b.name !== 'string' || !b.name.trim()) return '渠道名称必填'
  if (!CHANNEL_TYPES[b.type]) return '渠道类型无效'
  if (typeof b.target !== 'string' || !b.target.trim()) return '推送地址必填'
  return null
}

export function validateSub(b) {
  if (!b || typeof b.name !== 'string' || !b.name.trim()) return '订阅名称必填'
  const cs = String(b.crisis_status || '')
  if (cs && !CRISIS_STATUS_TEXT[cs]) return '危机状态无效'
  const we = String(b.wo_event || '')
  if (we && !['created', 'escalated'].includes(we)) return '工单事件无效（created/escalated）'
  const pe = String(b.prop_event || '')
  if (pe && !['outbreak', 'surge'].includes(pe)) return '传播事件无效（outbreak/surge）'
  const ee = String(b.ext_event || '')
  if (ee && !['submitted', 'escalated'].includes(ee)) return '外部协作事件无效（submitted/escalated）'
  const se = String(b.stmt_event || '')
  if (se && !['chfail', 'partial'].includes(se)) return '危机声明事件无效（chfail/partial）'
  if ([we, pe, ee, se, cs].filter(Boolean).length > 1) return '预警/危机/工单/传播/外部协作/声明事件订阅互斥，请只选一种匹配方式'
  const chs = Array.isArray(b.channel_ids) ? b.channel_ids.map(Number).filter(Number.isInteger) : []
  if (!chs.length) return '至少选择一个通知渠道'
  for (const id of chs) if (!q1('SELECT 1 FROM notify_channels WHERE id=?', id)) return `渠道 #${id} 不存在`
  if (b.alert_id && !q1('SELECT 1 FROM alerts WHERE id=?', +b.alert_id)) return '指定的预警规则不存在'
  if (b.require_ack && !(+b.ack_timeout_min >= 1)) return '回执超时至少 1 分钟'
  if (b.escalate_channel_id && !q1('SELECT 1 FROM notify_channels WHERE id=?', +b.escalate_channel_id)) return '升级渠道不存在'
  return null
}

export function listLogs({ taskId = null, limit = 100 } = {}) {
  if (taskId) return q('SELECT * FROM notify_logs WHERE task_id=? ORDER BY id DESC LIMIT ?', taskId, limit)
  return q(`SELECT nl.*, nt.title task_title FROM notify_logs nl
    LEFT JOIN notify_tasks nt ON nt.id=nl.task_id ORDER BY nl.id DESC LIMIT ?`, limit)
}
