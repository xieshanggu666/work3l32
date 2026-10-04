import { db } from './db.js'
import { now, addTimeline } from './pipeline.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// ===== 影响阶段口径 =====
export const PROP_STAGE = { seed: '潜伏期', ferment: '发酵期', outbreak: '爆发期', decline: '回落期' }
export const NODE_KIND = { root: '首发来源', media: '媒体', kol: '头部账号', node: '传播节点' }

// 阶段阈值（演示口径，与热度 0-100 对齐）
const FERMENT_NODES = 3        // 节点（含来源）≥3
const FERMENT_HEAT = 45        // 或热度 ≥45
const OUTBREAK_NODES = 4       // 节点 ≥4 且热度 ≥60
export const OUTBREAK_HEAT = 60
export const KOL_FOLLOWERS = 1000000 // 粉丝 ≥100w 视为头部账号，KOL 转发直接跨入爆发期
export const SURGE_HEAT = 15    // 单跳热度较路径峰值激增 ≥15 → 异动通知
const KOL_MIN_EDGE_HEAT = 60   // KOL 转发且热度达到爆发阈值才直接升级（普通热度 KOL 转发先记 KOL 异动）

// 外部联动钩子（在 index.js 注入，避免模块循环依赖）
// notify: 传播事件 → 通知编排（outbreak/surge/kol）；createWorkOrder: 爆发期跨角色工单
// deleteNotify: 路径删除时级联清理通知任务及其升级链（来源已删，任务不可留为幽灵提醒）
let hooks = { notify: null, createWorkOrder: null, deleteNotify: null }
export function bindPropHooks(h) { hooks = { ...hooks, ...h } }

function addLog(pathId, action, detail, operator = '系统') {
  run('INSERT INTO prop_change_logs (path_id,action,detail,operator,time) VALUES (?,?,?,?,?)',
    pathId, action, detail || '', operator, now())
}

// ===== 路径聚合指标（由节点/转发关系实时聚合） =====
function pathMetrics(pathId) {
  const nodes = q('SELECT * FROM prop_nodes WHERE path_id=?', pathId)
  const edges = q('SELECT * FROM prop_edges WHERE path_id=?', pathId)
  // 有效热度：上报热度优先，缺省由互动量推算（转发/评论/点赞加权，封顶 100）
  const edgeHeat = edges.map((e) => Math.max(0, e.heat || Math.min(100, Math.round(Math.log10(1 + e.reposts + e.comments + e.likes) * 18))))
  const heat = edgeHeat.reduce((a, b) => Math.max(a, b), 0)
  const reach = edges.reduce((a, e) => a + (e.reach || 0), 0)
  const reposts = edges.reduce((a, e) => a + (e.reposts || 0), 0)
  const kolCount = nodes.filter((n) => n.kind === 'kol').length
  const maxDepth = graphDepth(nodes, edges)
  return { nodes, edges, nodeCount: nodes.length, kolCount, heat, reach, reposts, maxDepth }
}

// 传播层级（图深度）：从来源节点沿转发边 BFS 的最大跳数
function graphDepth(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out = new Map()
  for (const e of edges) {
    if (!e.from_node_id || !byId.has(e.from_node_id)) continue
    if (!out.has(e.from_node_id)) out.set(e.from_node_id, [])
    out.get(e.from_node_id).push(e.to_node_id)
  }
  const roots = nodes.filter((n) => n.kind === 'root').map((n) => n.id)
  if (!roots.length) return 0
  let depth = 0
  const seen = new Set()
  let frontier = roots
  while (frontier.length) {
    const next = []
    for (const id of frontier) {
      if (seen.has(id)) continue
      seen.add(id)
      for (const to of out.get(id) || []) if (!seen.has(to)) next.push(to)
    }
    if (next.length) depth++
    frontier = next
  }
  return depth
}

// 由指标推导「应处阶段」（指标单调不减：节点只增、热度取峰值；回落由人工标记，调用方另做排名守卫）
function deriveStage(metrics) {
  const kolJoined = metrics.kolCount > 0
  if (kolJoined && metrics.heat >= KOL_MIN_EDGE_HEAT) return 'outbreak'
  if (metrics.nodeCount >= OUTBREAK_NODES && metrics.heat >= OUTBREAK_HEAT) return 'outbreak'
  if (metrics.nodeCount >= FERMENT_NODES || metrics.heat >= FERMENT_HEAT) return 'ferment'
  return 'seed'
}

function decoratePath(p, detail = false) {
  const m = pathMetrics(p.id)
  const alerts = q(`SELECT pa.alert_id, pa.is_origin, al.title alert_title, al.level alert_level
    FROM prop_path_alerts pa LEFT JOIN alerts al ON al.id=pa.alert_id
    WHERE pa.path_id=? ORDER BY pa.is_origin DESC, pa.alert_id`, p.id)
  const crisis = p.crisis_id
    ? q1('SELECT id,title,status,level FROM crisis WHERE id=?', p.crisis_id) : null
  const woCount = q1('SELECT COUNT(*) c FROM work_orders WHERE prop_path_id=?', p.id).c
  const item = {
    ...p,
    stageText: PROP_STAGE[p.stage] || p.stage,
    nodeCount: m.nodeCount, kolCount: m.kolCount, heat: m.heat, reach: m.reach,
    reposts: m.reposts, maxDepth: m.maxDepth, alerts, crisis, woCount
  }
  if (detail) {
    item.nodes = m.nodes.map((n) => ({ ...n, kindText: NODE_KIND[n.kind] || n.kind }))
    item.edges = m.edges.map(decorateEdge)
    item.logs = q('SELECT * FROM prop_change_logs WHERE path_id=? ORDER BY id DESC LIMIT 100', p.id)
  }
  return item
}

function decorateEdge(e) {
  const from = e.from_node_id ? q1('SELECT id,name,kind,channel FROM prop_nodes WHERE id=?', e.from_node_id) : null
  const to = q1('SELECT id,name,kind,channel FROM prop_nodes WHERE id=?', e.to_node_id)
  const post = e.post_id ? q1('SELECT id,title,sentiment,topic FROM posts WHERE id=?', e.post_id) : null
  return {
    ...e,
    from: from ? { ...from, kindText: NODE_KIND[from.kind] || from.kind } : null,
    to: to ? { ...to, kindText: NODE_KIND[to.kind] || to.kind } : null,
    post,
    effHeat: Math.max(0, e.heat || Math.min(100, Math.round(Math.log10(1 + e.reposts + e.comments + e.likes) * 18)))
  }
}

// ===== 查询 =====
export function listProp({ stage = '', crisisId = null, topic = '' } = {}) {
  let sql = 'SELECT * FROM prop_paths WHERE 1=1'
  const args = []
  if (stage && stage !== 'all') { sql += ' AND stage=?'; args.push(stage) }
  if (crisisId) { sql += ' AND crisis_id=?'; args.push(+crisisId) }
  if (topic) { sql += ' AND topic LIKE ?'; args.push(`%${topic}%`) }
  sql += ' ORDER BY id DESC'
  return q(sql, ...args).map((p) => decoratePath(p))
}

export function getProp(id) {
  const p = q1('SELECT * FROM prop_paths WHERE id=?', id)
  return p ? decoratePath(p, true) : null
}

export function propSummary() {
  const rows = q('SELECT stage, COUNT(*) c FROM prop_paths GROUP BY stage')
  const counts = { seed: 0, ferment: 0, outbreak: 0, decline: 0 }
  for (const r of rows) counts[r.stage] = r.c
  return { counts, total: Object.values(counts).reduce((a, b) => a + b, 0), outbreak: counts.outbreak }
}

// ===== 建档（手动录入 / 预警触发） =====
export function createProp(body, actor = { user: '系统' }) {
  const b = body || {}
  const title = String(b.title || '').trim()
  if (!title) return { error: '路径标题必填' }
  const topic = String(b.topic || '').trim()
  const ts = now()
  let originPostId = b.origin_post_id ? +b.origin_post_id : null
  if (originPostId && !q1('SELECT 1 FROM posts WHERE id=?', originPostId)) originPostId = null
  let crisisId = b.crisis_id ? +b.crisis_id : null
  if (crisisId && !q1('SELECT 1 FROM crisis WHERE id=?', crisisId)) crisisId = null
  const alertId = b.alert_id && q1('SELECT 1 FROM alerts WHERE id=?', +b.alert_id) ? +b.alert_id : null
  // 未显式指定危机但给了话题：自动并入同话题未结案危机（与预警→危机归并同口径）
  if (!crisisId && topic) {
    const c = q1("SELECT id FROM crisis WHERE topic=? AND status!='closed' ORDER BY last_trigger_at DESC, id DESC LIMIT 1", topic)
    if (c) crisisId = c.id
  }
  const r = run(`INSERT INTO prop_paths (title,topic,status,stage,origin_post_id,crisis_id,alert_id,auto_wo,peak_heat,first_at,updated,created)
    VALUES (?,?, 'active','seed',?,?,?,?,0,?,?,?)`,
    title, topic, originPostId, crisisId, alertId, b.auto_wo === false ? 0 : 1, ts, ts, ts)
  const id = Number(r.lastInsertRowid)
  // 首发来源节点（与首条来源舆情一并沉淀；同名来源用来源名作键，避免多个 root）
  const rootName = String(b.root_name || '').trim() || String(b.source_name || '').trim()
  let rootId = null
  if (rootName) {
    rootId = upsertNode(id, { node_key: rootName, name: rootName, kind: 'root', channel: String(b.channel || '').trim(), followers: 0 }, ts).id
  }
  if (originPostId && rootId) {
    const p = q1('SELECT heat FROM posts WHERE id=?', originPostId)
    run(`INSERT OR IGNORE INTO prop_edges (path_id,from_node_id,to_node_id,post_id,reposts,comments,likes,reach,heat,note,idem_key,time)
      VALUES (?,NULL,?,?,0,0,0,0,?, '首条来源舆情', ?, ?)`,
      id, rootId, originPostId, p ? p.heat : 0, `create:${id}:${originPostId}`, ts)
  }
  addLog(id, '建档', `传播路径建档：话题「${topic || '未分类'}」` + (rootName ? `，来源「${rootName}」` : '') +
    (crisisId ? `，关联危机 #${crisisId}` : ''), actor.user)
  if (alertId) {
    run('INSERT OR IGNORE INTO prop_path_alerts (path_id,alert_id,is_origin,first_at) VALUES (?,?,1,?)', id, alertId, ts)
    const al = q1('SELECT title FROM alerts WHERE id=?', alertId)
    addLog(id, '关联预警', `关联${actor.user === '系统' ? '来源' : ''}预警规则「${al ? al.title : '#' + alertId}」`, actor.user)
  }
  if (crisisId) addTimeline(crisisId, '传播建档', `新增传播路径「${title}」（话题「${topic || '—'}」）`, ts)
  return { ok: true, id, path: getProp(id) }
}

function upsertNode(pathId, n, ts = now()) {
  const key = String(n.node_key || n.name || '').trim()
  if (!key) return { error: '节点名称必填' }
  const name = String(n.name || key).trim()
  const kind = NODE_KIND[n.kind] ? n.kind : 'node'
  const followers = Math.max(0, +n.followers || 0)
  const existing = q1('SELECT * FROM prop_nodes WHERE path_id=? AND node_key=?', pathId, key)
  if (existing) {
    run('UPDATE prop_nodes SET name=?,kind=?,channel=?,followers=? WHERE id=?',
      name, kind, String(n.channel || '').trim(), Math.max(existing.followers, followers), existing.id)
    return { id: existing.id, created: false }
  }
  const r = run('INSERT INTO prop_nodes (path_id,node_key,name,kind,channel,followers,first_seen) VALUES (?,?,?,?,?,?,?)',
    pathId, key, name, kind, String(n.channel || '').trim(), followers, ts)
  return { id: Number(r.lastInsertRowid), created: true, name, kind }
}

// 编辑（标题/话题/自动工单开关/停用启用）
export function updateProp(id, body, actor = { user: '系统' }) {
  const p = q1('SELECT * FROM prop_paths WHERE id=?', id)
  if (!p) return null
  const b = body || {}
  const next = {
    title: typeof b.title === 'string' && b.title.trim() ? b.title.trim() : p.title,
    topic: b.topic !== undefined ? String(b.topic).trim() : p.topic,
    status: ['active', 'archived'].includes(b.status) ? b.status : p.status,
    auto_wo: typeof b.auto_wo === 'boolean' ? (b.auto_wo ? 1 : 0) : p.auto_wo
  }
  run('UPDATE prop_paths SET title=?,topic=?,status=?,auto_wo=?,updated=? WHERE id=?',
    next.title, next.topic, next.status, next.auto_wo, now(), id)
  addLog(id, '编辑', `路径配置更新：${[
    next.title !== p.title ? `标题「${p.title}」→「${next.title}」` : '',
    next.topic !== p.topic ? `话题「${p.topic}」→「${next.topic}」` : '',
    next.status !== p.status ? `状态 → ${next.status === 'active' ? '启用' : '停用'}` : '',
    next.auto_wo !== p.auto_wo ? `爆发自动工单 → ${next.auto_wo ? '开' : '关'}` : ''
  ].filter(Boolean).join('；') || '无实质变更'}`, actor.user)
  return { ok: true, path: getProp(id) }
}

// 关联/解除关联危机事件
export function bindCrisis(id, crisisId, actor = { user: '系统' }) {
  const p = q1('SELECT * FROM prop_paths WHERE id=?', id)
  if (!p) return null
  const cid = crisisId ? +crisisId : null
  if (cid && !q1('SELECT 1 FROM crisis WHERE id=?', cid)) return { error: '危机事件不存在' }
  run('UPDATE prop_paths SET crisis_id=?,updated=? WHERE id=?', cid, now(), id)
  addLog(id, '关联危机', cid ? `关联危机事件 #${cid}` : '解除危机事件关联', actor.user)
  if (cid) {
    const c = q1('SELECT title FROM crisis WHERE id=?', cid)
    addTimeline(cid, '传播关联', `传播路径「${p.title}」已关联本事件${c ? `（${c.title}）` : ''}`)
  }
  return { ok: true, path: getProp(id) }
}

// 关联预警规则（幂等；可标记来源规则）
export function attachAlert(id, alertId, isOrigin = false, actor = { user: '系统' }) {
  const p = q1('SELECT * FROM prop_paths WHERE id=?', id)
  const al = alertId ? q1('SELECT * FROM alerts WHERE id=?', +alertId) : null
  if (!p || !al) return { error: '路径或预警规则不存在' }
  const ts = now()
  const existed = q1('SELECT 1 FROM prop_path_alerts WHERE path_id=? AND alert_id=?', id, al.id)
  run('INSERT OR IGNORE INTO prop_path_alerts (path_id,alert_id,is_origin,first_at) VALUES (?,?,?,?)',
    id, al.id, isOrigin ? 1 : 0, ts)
  if (isOrigin) run('UPDATE prop_path_alerts SET is_origin=1 WHERE path_id=? AND alert_id=?', id, al.id)
  if (!existed) addLog(id, '关联预警', `关联${isOrigin ? '来源' : ''}预警规则「${al.title}」`, actor.user)
  return { ok: true, already: !!existed }
}

export function detachAlert(id, alertId) {
  const p = q1('SELECT 1 FROM prop_paths WHERE id=?', id)
  if (!p) return null
  run('DELETE FROM prop_path_alerts WHERE path_id=? AND alert_id=?', id, +alertId)
  addLog(id, '关联预警', `解除预警规则 #${alertId} 关联`)
  return { ok: true }
}

// 预警触发钩子：命中已建档路径的话题/规则时挂接该触发记录并留痕（幂等）
export function onAlertEvent({ alertId, postId, crisisId, topic }) {
  const paths = listProp()
  for (const p0 of paths) {
    if (p0.status !== 'active') continue
    const hit = p0.alerts.some((a) => a.alert_id === +alertId) || (p0.topic && p0.topic === topic)
    if (!hit) continue
    const ts = now()
    const existed = q1('SELECT 1 FROM prop_path_alerts WHERE path_id=? AND alert_id=?', p0.id, alertId)
    run('INSERT OR IGNORE INTO prop_path_alerts (path_id,alert_id,is_origin,first_at) VALUES (?,?,0,?)', p0.id, alertId, ts)
    if (!existed) addLog(p0.id, '关联预警', `预警规则 #${alertId} 新触发，自动挂接关联`)
    if (crisisId && !p0.crisis_id) run('UPDATE prop_paths SET crisis_id=?,updated=? WHERE id=?', crisisId, ts, p0.id)
  }
}

// ===== 记录一条转发/引用关系（核心：沉淀节点与边，重算阶段，按传播变化触发通知/工单） =====
export function addEdge(id, body, actor = { user: '系统' }) {
  const p = q1('SELECT * FROM prop_paths WHERE id=?', id)
  if (!p) return null
  if (p.status !== 'active') return { error: '路径已停用，不再记录传播变化（可重新启用后再记录）' }
  const b = body || {}
  const ts = now()
  // 目标节点（转发者）必填：已有节点 id 或新节点信息
  let toId = +b.to_node_id || 0
  if (!toId) {
    if (!String(b.to_name || '').trim()) return { error: '请选择或填写转发节点' }
    const up = upsertNode(id, {
      node_key: b.node_key || b.to_name, name: b.to_name, kind: b.kind,
      channel: b.channel, followers: b.followers
    }, ts)
    if (up.error) return { error: up.error }
    toId = up.id
  } else {
    const exist = q1('SELECT 1 FROM prop_nodes WHERE path_id=? AND id=?', id, toId)
    if (!exist) return { error: '目标节点不属于该路径' }
    // 已有节点也允许补充 KOL/粉丝量信息
    if (b.kind && NODE_KIND[b.kind]) {
      const fol = Math.max(0, +b.followers || 0)
      run('UPDATE prop_nodes SET kind=?, followers=MAX(followers,?), channel=COALESCE(NULLIF(?,\'\'),channel) WHERE id=?',
        b.kind, fol, String(b.channel || ''), toId)
    }
  }
  // 来源节点（被转发者，可空=直接原创首发）
  let fromId = +b.from_node_id || null
  if (fromId && !q1('SELECT 1 FROM prop_nodes WHERE path_id=? AND id=?', id, fromId)) return { error: '来源节点不属于该路径' }
  if (!fromId && String(b.from_name || '').trim()) {
    const up = upsertNode(id, {
      node_key: b.from_key || b.from_name, name: b.from_name, kind: b.from_kind || 'node',
      channel: b.from_channel, followers: b.from_followers
    }, ts)
    if (!up.error) fromId = up.id
  }
  // 幂等键：调用方指定优先；否则按 路径+来源+目标+分钟桶 生成（同分钟重复上报自动去重）
  const idemKey = String(b.idem_key || '').trim() ||
    `edge:${id}:${fromId || 'orig'}:${toId}:${new Date().getFullYear()}-${new Date().getMonth()}-${new Date().getDate()}-${new Date().getHours()}-${new Date().getMinutes()}`
  const reposts = Math.max(0, +b.reposts || 0)
  const comments = Math.max(0, +b.comments || 0)
  const likes = Math.max(0, +b.likes || 0)
  const reach = Math.max(0, +b.reach || 0)
  const heat = Math.max(0, Math.min(100, +b.heat || 0))
  const postId = +b.post_id || null
  const er = run(`INSERT OR IGNORE INTO prop_edges
    (path_id,from_node_id,to_node_id,post_id,reposts,comments,likes,reach,heat,note,idem_key,time)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, fromId, toId, postId, reposts, comments, likes, reach, heat, String(b.note || '').trim(), idemKey, ts)
  if (!Number(er.changes)) return { ok: true, duplicate: true, path: getProp(id) }

  const toNode = q1('SELECT * FROM prop_nodes WHERE id=?', toId)
  addLog(id, '转发', `「${toNode.name}」${fromId ? '转发自「' + (q1('SELECT name FROM prop_nodes WHERE id=?', fromId)?.name || '?') + '」' : '发布原创内容'}` +
    `（转发 ${reposts} · 触达 ${reach}${heat ? ` · 热度 ${heat}` : ''}）${toNode.kind === 'kol' ? ' · KOL 节点加入' : ''}`, actor.user)

  return evaluateAfterChange(id, { heat, reposts, reach, toNode, actor, ts })
}

// 一次传播变化后的统一评估：峰值/阶段推进 → 变化留痕/危机时间线 → 通知 → 自动工单
function evaluateAfterChange(id, { heat: edgeHeat, reposts, reach, toNode, actor, ts }) {
  const p = q1('SELECT * FROM prop_paths WHERE id=?', id)
  const m = pathMetrics(id)
  const before = p.stage
  const prevPeak = p.peak_heat || 0
  const newPeak = Math.max(prevPeak, m.heat)
  const isKolEdge = toNode && toNode.kind === 'kol' && m.heat >= KOL_MIN_EDGE_HEAT
  // 阶段推导：回落期允许二次爆发（指标重新达到爆发阈值时再次升级、重新走一轮通知/工单）
  let target = deriveStage(m)
  const rank = { seed: 1, ferment: 2, outbreak: 3, decline: 2 }
  const advance = rank[target] > rank[before] || (before === 'decline' && target === 'outbreak')
  let enteredOutbreak = false
  let outbreakMs = null
  run('UPDATE prop_paths SET peak_heat=?, updated=? WHERE id=?', newPeak, ts, id)
  const events = [] // 触发的传播事件：outbreak / surge / kol（供通知编排）
  if (advance && target !== before) {
    run('UPDATE prop_paths SET stage=? WHERE id=?', target, id)
    addLog(id, '阶段推进', `影响阶段：${PROP_STAGE[before]} → ${PROP_STAGE[target]}（节点 ${m.nodeCount} 个 · KOL ${m.kolCount} 个 · 热度 ${m.heat}）`, '系统')
    if (p.crisis_id) {
      const c = q1('SELECT status FROM crisis WHERE id=?', p.crisis_id)
      if (c && c.status !== 'closed') {
        addTimeline(p.crisis_id, target === 'outbreak' ? '传播爆发' : '传播发酵',
          `传播路径「${p.title}」进入${PROP_STAGE[target]}：节点 ${m.nodeCount} 个 · KOL ${m.kolCount} 个 · 峰值热度 ${newPeak} · 触达 ${reachFmt(m.reach)}`, ts)
      }
    }
    if (target === 'outbreak') {
      enteredOutbreak = true
      outbreakMs = Date.now()
      run('UPDATE prop_paths SET outbreak_at=? WHERE id=?', outbreakMs, id)
      events.push('outbreak')
    }
  }
  // 非爆发推进场景下的传播异动：热度激增 / KOL 加入（各发一次该事件，通知侧按事件幂等）
  if (!enteredOutbreak && edgeHeat >= OUTBREAK_HEAT && edgeHeat - prevPeak >= SURGE_HEAT) events.push('surge')
  if (!enteredOutbreak && isKolEdge) events.push('kol')

  // 通知联动（钩子在 index.js 注入；通知失败不影响传播沉淀）
  for (const ev of [...new Set(events)]) {
    if (hooks.notify) {
      try { hooks.notify(id, ev, { heat: m.heat, reposts, reach, node: toNode }) } catch (e) { console.error('[PROP] 传播通知失败：', e.message) }
    }
  }
  // 爆发期自动生成跨角色处置工单（每轮爆发仅一张，幂等：上轮自动工单时间早于本轮爆发时间才允许生成）
  let workOrderId = null
  // 旧轮次的 last_outbreak_wo_at 早于本轮 outbreakMs，判定本轮尚未生成过自动工单
  const woThisRound = p.last_outbreak_wo_at && outbreakMs && p.last_outbreak_wo_at >= outbreakMs
  if (enteredOutbreak && p.auto_wo && p.crisis_id && hooks.createWorkOrder && !woThisRound) {
    const r = safeAutoWorkOrder(id, p, m)
    if (r && r.id) {
      workOrderId = r.id
      run('UPDATE prop_paths SET last_outbreak_wo_at=? WHERE id=?', Date.now(), id)
    }
  }
  return { ok: true, advanced: target !== before, stage: target, events, workOrderId, path: getProp(id) }
}

function safeAutoWorkOrder(pathId, p, m) {
  const wo = {
    crisis_id: p.crisis_id,
    title: `【传播处置】${p.title}`,
    detail: `传播路径进入爆发期：节点 ${m.nodeCount} 个 · KOL ${m.kolCount} 个 · 峰值热度 ${m.heat} · 触达 ${reachFmt(m.reach)} · 传播层级 ${m.maxDepth}。请立即开展传播溯源、口径统一与头部节点协调。`,
    category: 'pr', priority: 'urgent', assignee: '', assignee_role: '', sla_min: 60,
    prop_path_id: pathId
  }
  const r = hooks.createWorkOrder(wo, { user: '系统', role: 'admin' })
  if (r && r.id) addLog(pathId, '自动工单', `爆发期自动生成跨角色处置工单 #${r.id}（公关口径 · 紧急 · SLA 60 分钟，待分派）`, '系统')
  return r
}

// 手动从路径生成跨角色工单（ops+；未关联危机时先提示关联）
export function createPropWorkOrder(id, body, actor) {
  const p = q1('SELECT * FROM prop_paths WHERE id=?', id)
  if (!p) return null
  if (!p.crisis_id) return { error: '请先为该路径关联危机事件，再拆分跨角色工单' }
  const m = pathMetrics(id)
  const b = body || {}
  const wo = {
    crisis_id: p.crisis_id,
    title: String(b.title || '').trim() || `【传播处置】${p.title}`,
    detail: String(b.detail || '').trim() || `传播路径当前阶段「${PROP_STAGE[p.stage]}」：节点 ${m.nodeCount} 个 · KOL ${m.kolCount} 个 · 峰值热度 ${p.peak_heat} · 触达 ${reachFmt(m.reach)}。`,
    category: ['pr', 'legal', 'ops', 'support', 'other'].includes(b.category) ? b.category : 'pr',
    priority: ['urgent', 'high', 'normal'].includes(b.priority) ? b.priority : 'high',
    assignee: String(b.assignee || '').trim(),
    assignee_role: String(b.assignee_role || '').trim(),
    sla_min: Math.max(0, Math.min(10080, +b.sla_min || 60)),
    prop_path_id: id
  }
  const r = hooks.createWorkOrder(wo, actor)
  if (r && r.id) addLog(id, '工单拆分', `${actor.user} 手动拆分跨角色工单 #${r.id}（${wo.assignee ? '分派给 ' + wo.assignee : '待分派'}）`, actor.user)
  return r || { error: '工单创建失败' }
}

// 标记回落期（阶段进入回落；路径保留全部沉淀，支持后续二次爆发）
export function markDecline(id, note, actor = { user: '系统' }) {
  const p = q1('SELECT * FROM prop_paths WHERE id=?', id)
  if (!p) return null
  const ts = now()
  run("UPDATE prop_paths SET stage='decline', updated=? WHERE id=? AND stage!='decline'", ts, id)
  addLog(id, '回落', `人工标记影响阶段 → 回落期${note ? `：${note}` : ''}（峰值热度 ${p.peak_heat}，节点 ${pathMetrics(id).nodeCount} 个）`, actor.user)
  if (p.crisis_id) {
    const c = q1('SELECT status FROM crisis WHERE id=?', p.crisis_id)
    if (c && c.status !== 'closed') addTimeline(p.crisis_id, '传播回落', `传播路径「${p.title}」标记进入回落期${note ? `：${note}` : ''}`, ts)
  }
  return { ok: true, path: getProp(id) }
}

export function deleteProp(id) {
  const p = q1('SELECT * FROM prop_paths WHERE id=?', id)
  if (!p) return null
  // 通知任务以路径为来源对象：路径删除后来源任务与其回执升级链无追溯对象，级联清理（幂等）；
  // 须在路径落库删除前调用，删除结果随返回值带出
  const notifyDeleted = hooks.deleteNotify ? hooks.deleteNotify(id) : 0
  run('DELETE FROM prop_edges WHERE path_id=?', id)
  run('DELETE FROM prop_nodes WHERE path_id=?', id)
  run('DELETE FROM prop_path_alerts WHERE path_id=?', id)
  run('DELETE FROM prop_change_logs WHERE path_id=?', id)
  // 路径来源工单保留（处置留痕），仅解除路径引用
  run('UPDATE work_orders SET prop_path_id=NULL WHERE prop_path_id=?', id)
  run('DELETE FROM prop_paths WHERE id=?', id)
  return { ok: true, title: p.title, notifyDeleted }
}

export function reachFmt(n) {
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 1000000 ? 0 : 1)}w+`
  return String(n)
}
