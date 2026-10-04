// ===== 外部协作反馈门户（External Collaboration Portal） =====
// 品牌方 / 监管方 / 媒体通过门户提交证据材料与整改进度；内部值班员受理、管理员审核，
// 审核采纳后回写协同工单、联动解除预警并写入危机统一时间线，同时复用通知编排完成提交提醒/紧急升级联动。
import { db } from './db.js'
import { now, addTimeline } from './pipeline.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// ===== 常量与口径 =====
export const PARTNER_KIND = { brand: '品牌方', regulator: '监管方', media: '媒体' }
export const DOC_TYPE = { evidence: '证据材料', rectify: '整改进度', clue: '线索反映' }
export const SUB_STATUS = {
  pending: '待审核', reviewing: '受理中', accepted: '已采纳', rejected: '已驳回', withdrawn: '已撤回'
}
export const DOC_ACTION_TEXT = { evidence: '证据', rectify: '整改进度', clue: '线索' }

function safeParse(s, dft) { try { return JSON.parse(s || '') ?? dft } catch { return dft } }

function addLog(subId, action, detail, operator = '系统', side = 'system') {
  run('INSERT INTO ext_submission_logs (submission_id,action,detail,operator,operator_side,time) VALUES (?,?,?,?,?,?)',
    subId, action, detail || '', operator || '系统', side, now())
}

// 门户编号：EXT + 4 位顺序号（按当前最大值递增，演示稳定可读）
function nextCode() {
  const row = q1("SELECT code FROM ext_submissions WHERE code LIKE 'EXT-%' ORDER BY CAST(SUBSTR(code,5) AS INTEGER) DESC LIMIT 1")
  let n = 1000
  if (row) {
    const m = String(row.code).match(/EXT-(\d+)/)
    if (m) n = Math.max(n, parseInt(m[1], 10))
  }
  return `EXT-${n + 1}`
}

// ===== 外部身份（演示：门户请求头携带口令 access_code，服务端校验协作方有效性） =====
export function partnerOf(req) {
  const code = String(req.headers['x-access-code'] || req.query?.access_code || '').trim()
  if (!code) return null
  const p = q1('SELECT * FROM ext_partners WHERE access_code=? AND enabled=1', code)
  return p || null
}

// ===== 协作方管理（admin） =====
export function listPartners() {
  const rows = q(`SELECT p.*,
      (SELECT COUNT(*) FROM ext_submissions s WHERE s.partner_id=p.id) sub_total,
      (SELECT COUNT(*) FROM ext_submissions s WHERE s.partner_id=p.id AND s.status IN ('pending','reviewing')) sub_open
    FROM ext_partners p ORDER BY p.id`)
  return rows.map((p) => ({ ...p, kindText: PARTNER_KIND[p.kind] || p.kind }))
}

export function validatePartner(b) {
  if (!b || typeof b.name !== 'string' || !b.name.trim()) return '机构/账号名称必填'
  if (!PARTNER_KIND[b.kind]) return '协作方类型无效（品牌方/监管方/媒体）'
  const code = String(b.access_code || '').trim()
  if (!code) return '门户提交口令必填'
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(code)) return '口令仅支持 4-32 位字母、数字、- 与 _'
  if (q1('SELECT 1 FROM ext_partners WHERE access_code=?', code)) return '该提交口令已被使用'
  return null
}

export function createPartner(body, actor) {
  const err = validatePartner(body)
  if (err) return { error: err }
  const ts = now()
  const r = run(`INSERT INTO ext_partners (name,kind,contact,phone,email,access_code,enabled,created,created_by)
    VALUES (?,?,?,?,?,?,1,?,?)`,
    body.name.trim(), body.kind, String(body.contact || '').trim(), String(body.phone || '').trim(),
    String(body.email || '').trim(), String(body.access_code).trim(), ts, actor.user)
  return { ok: true, id: Number(r.lastInsertRowid) }
}

export function updatePartner(id, body) {
  const p = q1('SELECT * FROM ext_partners WHERE id=?', id)
  if (!p) return null
  const b = body || {}
  const err = (() => {
    if (b.name !== undefined && (!b.name || !String(b.name).trim())) return '机构/账号名称必填'
    if (b.kind !== undefined && !PARTNER_KIND[b.kind]) return '协作方类型无效'
    if (b.access_code !== undefined) {
      const code = String(b.access_code || '').trim()
      if (!code) return '门户提交口令必填'
      if (!/^[A-Za-z0-9_-]{4,32}$/.test(code)) return '口令仅支持 4-32 位字母、数字、- 与 _'
      if (q1('SELECT 1 FROM ext_partners WHERE access_code=? AND id!=?', code, id)) return '该提交口令已被使用'
    }
    return null
  })()
  if (err) return { error: err }
  run(`UPDATE ext_partners SET name=?,kind=?,contact=?,phone=?,email=?,access_code=? WHERE id=?`,
    b.name !== undefined ? String(b.name).trim() : p.name,
    b.kind || p.kind,
    b.contact !== undefined ? String(b.contact).trim() : p.contact,
    b.phone !== undefined ? String(b.phone).trim() : p.phone,
    b.email !== undefined ? String(b.email).trim() : p.email,
    b.access_code !== undefined ? String(b.access_code).trim() : p.access_code,
    id)
  return { ok: true }
}

export function togglePartner(id) {
  const p = q1('SELECT * FROM ext_partners WHERE id=?', id)
  if (!p) return null
  run('UPDATE ext_partners SET enabled=? WHERE id=?', p.enabled ? 0 : 1, id)
  return { ok: true, enabled: p.enabled ? 0 : 1 }
}

// ===== 提交查询 =====
function decorate(s) {
  return {
    ...s,
    attachments: safeParse(s.attachments, []) || [],
    statusText: SUB_STATUS[s.status] || s.status,
    kindText: PARTNER_KIND[s.kind] || s.kind,
    docTypeText: DOC_TYPE[s.doc_type] || s.doc_type,
    crisis_title: '', partner_name: '', partner_code: '', wo_title: ''
  }
}

const JOIN_FROM = `FROM ext_submissions s
  LEFT JOIN ext_partners p ON p.id=s.partner_id
  LEFT JOIN crisis c ON c.id=s.crisis_id
  LEFT JOIN work_orders wo ON wo.id=s.work_order_id`

function listQuery(where, args = []) {
  return q(`SELECT s.*, p.name partner_name, p.access_code partner_code, p.contact partner_contact,
      c.title crisis_title, c.status crisis_status, c.level crisis_level,
      wo.title wo_title
    ${JOIN_FROM} ${where} ORDER BY s.is_urgent DESC, s.id DESC LIMIT 300`, ...args).map((r) => {
      const d = decorate(r)
      return d
    })
}

// 内部看板：状态/危机/协作方类型过滤
export function listSubmissions({ status = '', crisisId = null, kind = '', partnerId = null } = {}) {
  let where = 'WHERE 1=1'
  const args = []
  if (status) { where += ' AND s.status=?'; args.push(status) }
  if (crisisId) { where += ' AND s.crisis_id=?'; args.push(crisisId) }
  if (kind) { where += ' AND s.kind=?'; args.push(kind) }
  if (partnerId) { where += ' AND s.partner_id=?'; args.push(partnerId) }
  return listQuery(where, args)
}

// 门户：某协作方自己的提交（不泄露其他方内容）
export function listPartnerSubmissions(partnerId) {
  return listQuery('WHERE s.partner_id=?', [partnerId])
}

export function getSubmission(id) {
  const r = q1(`SELECT s.*, p.name partner_name, p.kind partner_kind_raw, p.access_code partner_code,
      p.contact partner_contact, p.phone partner_phone, p.email partner_email, p.enabled partner_enabled,
      c.title crisis_title, c.status crisis_status, c.level crisis_level, c.topic crisis_topic,
      wo.title wo_title, wo.status wo_status
    ${JOIN_FROM} WHERE s.id=?`, id)
  if (!r) return null
  const d = decorate(r)
  d.logs = q('SELECT * FROM ext_submission_logs WHERE submission_id=? ORDER BY id ASC', id)
  return d
}

// 门户查看：口令必须属于提交方本人
export function getSubmissionForPartner(id, partnerId) {
  const s = q1('SELECT * FROM ext_submissions WHERE id=? AND partner_id=?', id, partnerId)
  return s ? getSubmission(id) : null
}

// 看板汇总（内部角标 / 总览统计）
export function submissionSummary() {
  const rows = q('SELECT status, COUNT(*) c FROM ext_submissions GROUP BY status')
  const counts = { pending: 0, reviewing: 0, accepted: 0, rejected: 0, withdrawn: 0 }
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + r.c
  const urgentOpen = q1("SELECT COUNT(*) c FROM ext_submissions WHERE is_urgent=1 AND status IN ('pending','reviewing')").c
  return {
    counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    pending: counts.pending, reviewing: counts.reviewing,
    open: counts.pending + counts.reviewing, urgentOpen
  }
}

// 危机卡片角标：该事件待审核的外部提交数（含紧急数）
export function crisisSubmissionBrief(crisisId) {
  const row = q1(`SELECT
      (SELECT COUNT(*) FROM ext_submissions WHERE crisis_id=? AND status IN ('pending','reviewing')) open,
      (SELECT COUNT(*) FROM ext_submissions WHERE crisis_id=? AND is_urgent=1 AND status IN ('pending','reviewing')) urgent,
      (SELECT COUNT(*) FROM ext_submissions WHERE crisis_id=? AND status='accepted') accepted`, crisisId, crisisId, crisisId)
  return row && (row.open || row.accepted)
    ? { open: row.open, urgent: row.urgent, accepted: row.accepted }
    : null
}

// 门户首页：协作方信息 + 可关联的未结案危机（只读标题/级别/状态）
export function portalBootstrap(partner) {
  const crises = q("SELECT id,title,level,status,topic FROM crisis WHERE status!='closed' ORDER BY id DESC")
    .map((c) => ({ ...c, levelText: { red: '红色', orange: '橙色', yellow: '黄色' }[c.level] || c.level }))
  const mine = listPartnerSubmissions(partner.id)
  return {
    partner: { id: partner.id, name: partner.name, kind: partner.kind, kindText: PARTNER_KIND[partner.kind], contact: partner.contact },
    crises, mine,
    dict: { docType: DOC_TYPE, status: SUB_STATUS }
  }
}

// 通知联动在 index.js 注入（避免 notify ↔ portal 循环依赖）
// notifyOnSubmit(subId, isUrgent)：按「外部协作提交/紧急升级」订阅生成通知任务
let notifyHooks = { notifyOnSubmit: null }
export function bindPortalNotify(h) { notifyHooks = { ...notifyHooks, ...h } }
function fireNotify(subId, isUrgent) {
  if (!notifyHooks.notifyOnSubmit) return
  try { notifyHooks.notifyOnSubmit(subId, isUrgent) } catch (e) { console.error('[PORTAL] 通知生成失败：', e.message) }
}

// ===== 外部提交（协作方通过门户提交证据/整改进度） =====
export function createSubmission(body, partner) {
  const b = body || {}
  const title = String(b.title || '').trim()
  if (!title) return { error: '标题必填' }
  const content = String(b.content || '').trim()
  if (!content) return { error: '请填写提交内容（证据描述/整改进度说明）' }
  const docType = DOC_TYPE[b.doc_type] ? b.doc_type : 'evidence'
  let crisisId = null
  if (b.crisis_id) {
    const c = q1('SELECT id,status FROM crisis WHERE id=?', +b.crisis_id)
    if (!c) return { error: '关联危机事件不存在' }
    if (c.status === 'closed') return { error: '该事件已结案，不能再提交关联材料（请选择未结案事件或作为通用线索提交）' }
    crisisId = c.id
  }
  // 附件清单（演示仅记录元数据，不落文件）
  let attachments = []
  if (Array.isArray(b.attachments)) {
    attachments = b.attachments.slice(0, 10).map((a) => ({
      name: String(a?.name || '附件').slice(0, 120),
      size: Math.max(0, Math.min(50 * 1024 * 1024, +a?.size || 0)),
      type: String(a?.type || '').slice(0, 80)
    })).filter((a) => a.name)
  }
  const isUrgent = b.is_urgent ? 1 : 0
  const ts = now()
  const code = nextCode()
  const r = run(`INSERT INTO ext_submissions
    (code,partner_id,kind,crisis_id,work_order_id,doc_type,title,content,attachments,source_url,contact_info,is_urgent,status,created,updated)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`,
    code, partner.id, partner.kind, crisisId, null, docType, title, content,
    JSON.stringify(attachments), String(b.source_url || '').trim().slice(0, 500),
    String(b.contact_info || '').trim().slice(0, 200), isUrgent, ts, ts)
  const id = Number(r.lastInsertRowid)
  const kindLabel = PARTNER_KIND[partner.kind]
  const docLabel = DOC_ACTION_TEXT[docType]
  addLog(id, 'create', `${kindLabel}（${partner.name}）通过外部协作门户提交${docLabel}「${title}」` +
    (attachments.length ? `（${attachments.length} 个附件）` : ''), partner.contact || partner.name, 'external')

  let timelineWritten = false
  if (crisisId) {
    const c = q1('SELECT status,title FROM crisis WHERE id=?', crisisId)
    if (c && c.status !== 'closed') {
      if (isUrgent) {
        // 紧急提交（如监管督办）：提交即写入危机时间线「外部反馈升级」并联动通知升级
        addDispatchLikeTimeline(crisisId, '外部反馈升级',
          `${kindLabel}（${partner.name}）紧急提交${docLabel}「${title}」（${code}），请立即内部核查处置`, id, ts)
        addLog(id, 'urgent', '紧急提交：已联动内部升级通知', '系统', 'system')
      } else {
        addDispatchLikeTimeline(crisisId, '外部反馈提交',
          `${kindLabel}（${partner.name}）提交${docLabel}「${title}」（${code}），等待内部审核`, id, ts)
      }
      timelineWritten = true
    }
  }
  fireNotify(id, !!isUrgent)
  return { ok: true, id, code, timelineWritten }
}

// 外部补充说明（仅待审核/受理中/已驳回可补充；采纳后材料归档不可改）
export function supplementSubmission(id, body, partner) {
  const s = q1('SELECT * FROM ext_submissions WHERE id=? AND partner_id=?', id, partner.id)
  if (!s) return null
  if (!['pending', 'reviewing', 'rejected'].includes(s.status)) {
    return { error: `当前状态（${SUB_STATUS[s.status] || s.status}）不能补充材料` }
  }
  const note = String(body?.note || '').trim()
  if (!note) return { error: '请填写补充说明' }
  const ts = now()
  run('UPDATE ext_submissions SET content=?, updated=? WHERE id=?',
    s.content + `\n\n【补充 ${ts}】${note}`, ts, id)
  addLog(id, 'supplement', `提交方补充材料：${note}`, partner.contact || partner.name, 'external')
  if (s.crisis_id) {
    const c = q1('SELECT status FROM crisis WHERE id=?', s.crisis_id)
    if (c && c.status !== 'closed') {
      addDispatchLikeTimeline(s.crisis_id, '外部反馈补充',
        `${PARTNER_KIND[s.kind]}（${partner.name}）补充「${s.title}」（${s.code}）：${note.slice(0, 120)}`, id, ts)
    }
  }
  return { ok: true }
}

// 外部撤回（未采纳前可撤回；已采纳为处置档案不可撤）
export function withdrawSubmission(id, body, partner) {
  const s = q1('SELECT * FROM ext_submissions WHERE id=? AND partner_id=?', id, partner.id)
  if (!s) return null
  if (['accepted', 'withdrawn'].includes(s.status)) {
    return { error: `当前状态（${SUB_STATUS[s.status] || s.status}）不能撤回` }
  }
  const reason = String(body?.reason || '').trim()
  const ts = now()
  run("UPDATE ext_submissions SET status='withdrawn', withdrawn_at=?, updated=? WHERE id=?", ts, ts, id)
  addLog(id, 'withdraw', (reason ? `提交方撤回：${reason}` : '提交方主动撤回'), partner.contact || partner.name, 'external')
  return { ok: true }
}

// ===== 内部受理（ops+：待审核 → 受理中，仅状态守卫与留痕） =====
export function receiveSubmission(id, actor) {
  const s = q1('SELECT * FROM ext_submissions WHERE id=?', id)
  if (!s) return null
  if (!['pending', 'rejected'].includes(s.status)) return { error: `仅待审核/已驳回（补充后重提）的提交可受理（当前：${SUB_STATUS[s.status] || s.status}）` }
  const ts = now()
  const r = run("UPDATE ext_submissions SET status='reviewing', reviewed_by=?, reviewed_at=?, reject_reason='', rejected_by='', rejected_at=NULL, updated=? WHERE id=? AND status IN ('pending','rejected')",
    actor.user, ts, ts, id)
  if (!Number(r.changes)) return { error: '提交状态已变化，请刷新' }
  addLog(id, 'receive', s.status === 'rejected' ? `${actor.user} 重新受理（提交方已补充材料）` : `${actor.user} 受理，转入内部审核`, actor.user, 'internal')
  return { ok: true }
}

// ===== 内部审核采纳（admin：回写工单 + 联动解除预警 + 危机时间线） =====
export function acceptSubmission(id, body, actor) {
  const s = q1('SELECT * FROM ext_submissions WHERE id=?', id)
  if (!s) return null
  if (!['pending', 'reviewing', 'rejected'].includes(s.status)) {
    return { error: `仅待审核/受理中/已驳回（补充后）的提交可采纳（当前：${SUB_STATUS[s.status] || s.status}）` }
  }
  const b = body || {}
  const note = String(b.note || '').trim()
  const workOrderId = b.work_order_id ? +b.work_order_id : null
  if (workOrderId) {
    const wo = q1('SELECT id,crisis_id FROM work_orders WHERE id=?', workOrderId)
    if (!wo) return { error: '关联工单不存在' }
    if (s.crisis_id && wo.crisis_id !== s.crisis_id) return { error: '关联工单不属于该提交的危机事件' }
    if (['done', 'cancelled'].includes(q1('SELECT status FROM work_orders WHERE id=?', workOrderId).status)) {
      return { error: '关联工单已完结/取消，不能回写（可先在工单页回退重做）' }
    }
  }
  const resolveAlerts = b.resolve_alerts ? 1 : 0
  const ts = now()
  let resolved = 0
  let crisisId = s.crisis_id
  const ruleNames = []
  db.exec('BEGIN')
  try {
    // 无关联危机但选择了同危机工单：以工单危机为准补挂
    if (!crisisId && workOrderId) {
      const wo = q1('SELECT crisis_id FROM work_orders WHERE id=?', workOrderId)
      crisisId = wo ? wo.crisis_id : null
    }
    const r = run(`UPDATE ext_submissions SET status='accepted', accepted_by=?, accepted_at=?, accepted_note=?,
      work_order_id=?, resolve_alerts=?, resolved_alert_count=?, reviewed_by=COALESCE(NULLIF(reviewed_by,''),?),
      rejected_by='', rejected_at=NULL, reject_reason='', updated=?
      WHERE id=? AND status IN ('pending','reviewing','rejected')`,
      actor.user, ts, note, workOrderId, resolveAlerts, 0, actor.user, ts, id)
    if (!Number(r.changes)) { db.exec('ROLLBACK'); return { error: '提交状态已变化，请刷新' } }

    if (crisisId && !s.crisis_id) run('UPDATE ext_submissions SET crisis_id=? WHERE id=?', crisisId, id)
    const partner = q1('SELECT name FROM ext_partners WHERE id=?', s.partner_id)
    const who = `${PARTNER_KIND[s.kind]}（${partner ? partner.name : '已停用协作方'}）`

    // ① 回写协同工单日志（不改工单状态；外部材料作为处置依据挂接工单）
    if (workOrderId) {
      run('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)',
        workOrderId, 'ext', `外部协作门户：${who}提交的${DOC_ACTION_TEXT[s.doc_type]}「${s.title}」审核采纳后回写（${s.code}）` +
          (note ? `；采纳说明：${note}` : ''), partner ? partner.name : '外部协作方', '', ts)
    }
    // ② 联动解除该危机全部未解除预警（resolve_kind=portal，状态守卫幂等）
    if (resolveAlerts && crisisId) {
      const opens = q("SELECT * FROM alert_events WHERE crisis_id=? AND status='open'", crisisId)
      for (const ev of opens) {
        run("UPDATE alert_events SET status='resolved', resolved=?, resolve_kind='portal' WHERE id=? AND status='open'", ts, ev.id)
      }
      resolved = opens.length
      run('UPDATE ext_submissions SET resolved_alert_count=? WHERE id=?', resolved, id)
      for (const rid of [...new Set(opens.map((e) => e.alert_id))]) {
        const al = q1('SELECT title FROM alerts WHERE id=?', rid)
        ruleNames.push(al ? `「${al.title}」` : '已删除规则')
      }
    }
    // ③ 回写危机统一时间线（带门户锚点，看板可跳转）
    if (crisisId) {
      const c = q1('SELECT status FROM crisis WHERE id=?', crisisId)
      if (c && c.status !== 'closed') {
        const bits = [`采纳${who}提交的${DOC_ACTION_TEXT[s.doc_type]}「${s.title}」（${s.code}）`]
        if (workOrderId) bits.push(`已回写工单 #${workOrderId}`)
        if (resolved) bits.push(`同步解除 ${resolved} 条未解除预警${ruleNames.length ? '：' + ruleNames.join('、') : ''}`)
        if (note) bits.push(`采纳说明：${note}`)
        addDispatchLikeTimeline(crisisId, '外部反馈采纳', bits.join('；'), id, ts)
      }
    }
    addLog(id, 'accept', `管理员 ${actor.user} 审核采纳` +
      (workOrderId ? `，回写工单 #${workOrderId}` : '') +
      (resolved ? `，联动解除 ${resolved} 条未解除预警` : '') +
      (note ? `；说明：${note}` : ''), actor.user, 'internal')
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  return { ok: true, resolved, crisisId, workOrderId }
}

// ===== 内部审核驳回（admin：退回提交方，外部门户可见驳回原因并可修改重提/撤回） =====
export function rejectSubmission(id, body, actor) {
  const s = q1('SELECT * FROM ext_submissions WHERE id=?', id)
  if (!s) return null
  if (!['pending', 'reviewing', 'rejected'].includes(s.status)) {
    return { error: `仅待审核/受理中/已驳回（补充后）的提交可驳回（当前：${SUB_STATUS[s.status] || s.status}）` }
  }
  const reason = String(body?.reason || '').trim()
  if (!reason) return { error: '请填写驳回原因（提交方将在门户看到）' }
  const ts = now()
  const r = run(`UPDATE ext_submissions SET status='rejected', rejected_by=?, rejected_at=?, reject_reason=?,
    reviewed_by=COALESCE(NULLIF(reviewed_by,''),?), updated=? WHERE id=? AND status IN ('pending','reviewing','rejected')`,
    actor.user, ts, reason, actor.user, ts, id)
  if (!Number(r.changes)) return { error: '提交状态已变化，请刷新' }
  addLog(id, 'reject', `驳回：${reason}`, actor.user, 'internal')
  return { ok: true }
}

// 内部为提交补挂/改挂危机（通用线索核实归属后挂接；ops+）
export function bindSubmissionCrisis(id, body, actor) {
  const s = q1('SELECT * FROM ext_submissions WHERE id=?', id)
  if (!s) return null
  const crisisId = body?.crisis_id ? +body.crisis_id : null
  if (crisisId) {
    const c = q1('SELECT id,status,title FROM crisis WHERE id=?', crisisId)
    if (!c) return { error: '危机事件不存在' }
    if (c.status === 'closed') return { error: '已结案事件不能挂接外部提交（如需请先回滚结案）' }
  }
  const ts = now()
  run('UPDATE ext_submissions SET crisis_id=?, updated=? WHERE id=?', crisisId, ts, id)
  addLog(id, 'bind', crisisId ? `内部补挂危机事件 #${crisisId}` : '解除危机事件挂接', actor.user, 'internal')
  if (crisisId) {
    const partner = q1('SELECT name FROM ext_partners WHERE id=?', s.partner_id)
    addDispatchLikeTimeline(crisisId, s.is_urgent ? '外部反馈升级' : '外部反馈提交',
      `${PARTNER_KIND[s.kind]}（${partner ? partner.name : '已停用协作方'}）${s.is_urgent ? '紧急' : ''}提交${DOC_ACTION_TEXT[s.doc_type]}「${s.title}」（${s.code}，内部核实后补挂）`,
      id, ts)
  }
  return { ok: true, crisisId }
}

// 带门户锚点的危机时间线写入（ref_type='ext'，看板时间线可点击直达门户详情）
function addDispatchLikeTimeline(crisisId, action, note, subId, timeStr) {
  addTimeline(crisisId, action, note, timeStr)
  run('UPDATE crisis_timeline SET ref_type=?, ref_id=? WHERE id=(SELECT MAX(id) FROM crisis_timeline WHERE crisis_id=?)',
    'ext', subId, crisisId)
}

// 删除危机时：保留外部提交（外部协作留痕不删除），仅解除危机引用与工单引用
export function detachSubmissionsOfCrisis(crisisId) {
  run('UPDATE ext_submissions SET crisis_id=NULL, work_order_id=NULL WHERE crisis_id=?', crisisId)
}
