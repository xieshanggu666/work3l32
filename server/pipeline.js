import { db, parseTimeMs } from './db.js'
// 通知编排钩子（循环引用仅在运行期函数内使用，ESM 活体绑定可安全解析）
import { generateForAlertEvent, generateForCrisisStatus } from './notify.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)
export const now = () => new Date().toLocaleString('zh-CN')

// 传播路径联动钩子（index.js 注入 propagate.onAlertEvent；预警触发时挂接同话题/同规则路径）
let propHooks = { onAlertEvent: null }
export function bindPipelineProp(h) { propHooks = { ...propHooks, ...h } }

// 高等级预警（红/橙）触发时自动建档危机事件
export const AUTO_LEVELS = ['red', 'orange']
export const LV_TEXT = { red: '红色', orange: '橙色', yellow: '黄色' }
export const LV_RANK = { red: 3, orange: 2, yellow: 1 }

// 统一时间线：建档/归并/解除/结案/回滚/规则变更等所有危机动作经此写入，并刷新事件更新时间
export function addTimeline(crisisId, action, note, timeStr = now()) {
  run('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)', crisisId, action, note || '', timeStr)
  run('UPDATE crisis SET updated=? WHERE id=?', timeStr, crisisId)
}

// 承接某事件的规则关联（无则插入），刷新最近触发时间
export function attachRule(crisisId, alertId, isOrigin, timeStr) {
  const exists = q1('SELECT 1 FROM crisis_alerts WHERE crisis_id=? AND alert_id=?', crisisId, alertId)
  if (exists) run('UPDATE crisis_alerts SET last_at=?, is_origin=MAX(is_origin,?) WHERE crisis_id=? AND alert_id=?', timeStr, isOrigin ? 1 : 0, crisisId, alertId)
  else run('INSERT INTO crisis_alerts (crisis_id,alert_id,is_origin,first_at,last_at) VALUES (?,?,?,?,?)', crisisId, alertId, isOrigin ? 1 : 0, timeStr, timeStr)
}

// 简易情感打分（演示用，规则匹配）
export const NEG = ['慢', '卫生', '投诉', '延期', '质疑', '故障', '涨价', '维权', '不满', '告', '退款', '坑', '吐槽', '回应迟']
export const POS = ['好评', '回升', '利好', '积极', '满意', '点赞', '惠民', '提升', '突破', '肯定', '有效']
export function analyze(text) {
  let score = 0
  NEG.forEach((w) => { if (text.includes(w)) score -= 0.5 })
  POS.forEach((w) => { if (text.includes(w)) score += 0.5 })
  score = Math.max(-1, Math.min(1, score))
  return { sentiment: score < -0.2 ? 'negative' : score > 0.2 ? 'positive' : 'neutral', score }
}

// 总览统计（单条/批量录入后统一刷新）
export function statsSummary(posts = q('SELECT * FROM posts')) {
  const total = posts.length
  const pos = posts.filter((p) => p.sentiment === 'positive').length
  const neg = posts.filter((p) => p.sentiment === 'negative').length
  return {
    total, pos, neg, neu: total - pos - neg,
    negRate: total ? Math.round((neg / total) * 100) : 0,
    hot: posts.filter((p) => p.hot).length,
    topHeat: Math.max(...posts.map((p) => p.heat), 0)
  }
}

// 录入校验：标题/正文必填（批量导入时按条定位错误）
export function validateItem(it, idx) {
  const errs = []
  if (!it || typeof it !== 'object') errs.push('格式错误')
  else {
    if (typeof it.title !== 'string' || !it.title.trim()) errs.push('缺少标题')
    if (typeof it.content !== 'string' || !it.content.trim()) errs.push('缺少正文')
  }
  return errs.length ? `第${idx + 1}条：${errs.join('、')}` : null
}

// 统一录入管线：情感分析 → 落库 → 预警检查（红/橙级自动建档危机或去重并入）。
// idemKey：条目幂等键。键已存在时直接返回既有舆情，绝不重复触发预警/建档危机。
// simFail：演练用瞬时故障注入（命中即抛错，由调用方消费一次后清除）。
export function ingestPost(item, { idemKey = null, simFail = false } = {}) {
  if (simFail) throw new Error('模拟瞬时故障（演练注入，重试即可恢复）')
  if (idemKey) {
    const dup = q1('SELECT id FROM posts WHERE idem_key=?', idemKey)
    if (dup) return { id: dup.id, duplicate: true, triggered: [] }
  }
  const title = (item.title || '').trim()
  const content = (item.content || '').trim()
  const text = title + ' ' + content
  const a = analyze(text)
  // 热度与负面关键词命中数挂钩，便于稳定演示预警触发
  const negHits = NEG.filter((w) => text.includes(w)).length
  const heat = Math.min(100, 35 + negHits * 12 + Math.round(Math.random() * 12) + (a.sentiment === 'negative' ? 8 : 0))
  const r = run('INSERT INTO posts (title,content,source_id,sentiment,sentiment_score,heat,hot,topic,media,published,created,idem_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    title, content, item.source_id || 1, a.sentiment, a.score, heat,
    a.sentiment === 'negative' ? 1 : 0, (item.topic || '').trim() || '新增', (item.media || '').trim(), now(), now(), idemKey)
  const id = Number(r.lastInsertRowid)
  const triggered = checkAlerts(id)
  return { id, title, sentiment: a.sentiment, score: a.score, heat, triggered, duplicate: false }
}

// 已落库舆情的轻量结果（跨任务命中同一幂等键时回写用）
export function postLite(id) {
  const p = q1('SELECT id,title,sentiment,sentiment_score score,heat FROM posts WHERE id=?', id)
  return p ? { ...p, triggered: [], duplicate: true } : null
}

export function checkAlerts(postId) {
  const p = q1('SELECT * FROM posts WHERE id=?', postId)
  const alerts = q('SELECT * FROM alerts WHERE active=1')
  const fired = []
  for (const al of alerts) {
    const kwHit = !al.keyword || (p.title + p.content).includes(al.keyword)
    const sentHit = !al.sentiment || p.sentiment === al.sentiment
    const heatHit = p.heat >= al.heat_min
    if (!(kwHit && sentHit && heatHit)) continue
    run('UPDATE alerts SET trigger_count=trigger_count+1 WHERE id=?', al.id)
    const detail = `命中关键词「${al.keyword || '全部'}」· ${al.sentiment ? '情感：' + al.sentiment : '不限情感'} · 热度${p.heat}`
    const ts = now()
    const tsMs = Date.now()
    // 归并话题：规则指定则以规则为准，否则以命中舆情的话题为准
    const topic = (al.merge_topic || p.topic || '').trim()
    // 闭环：高等级预警 → 危机事件。按「同话题 + 时间窗口内 + 未结案」归并；
    // 同一规则下不同话题/超出窗口分别建档；新规则并入既有同话题事件（承接多规则）。
    let crisisId = null, deduped = false
    if (AUTO_LEVELS.includes(al.level) && topic) {
      const winMs = (al.merge_window > 0 ? al.merge_window : 0) * 60000
      let open = null
      const cands = q("SELECT * FROM crisis WHERE topic=? AND status!='closed' ORDER BY last_trigger_at DESC, id DESC", topic)
      for (const c of cands) {
        const lastMs = c.last_trigger_at == null ? parseTimeMs(c.updated) : c.last_trigger_at
        if (!winMs || (lastMs != null && tsMs - lastMs <= winMs)) { open = c; break }
      }
      if (open) {
        crisisId = open.id
        deduped = true
        run('UPDATE crisis SET last_trigger_at=? WHERE id=?', tsMs, open.id)
        // 多规则并发/后续触发并入：更高级别规则上调事件级别（只升不降）
        const escalate = (LV_RANK[al.level] || 0) > (LV_RANK[open.level] || 0)
        if (escalate) run('UPDATE crisis SET level=? WHERE id=?', al.level, open.id)
        // 该规则是否已承接此事件：决定时间线语义
        const linked = q1('SELECT 1 FROM crisis_alerts WHERE crisis_id=? AND alert_id=?', open.id, al.id)
        attachRule(open.id, al.id, false, ts)
        addTimeline(open.id, linked ? '预警再次触发' : '规则归并',
          (linked
            ? `${detail} · 关联舆情《${p.title}》`
            : `承接规则「${al.title}」（${LV_TEXT[al.level]}）：${detail} · 关联舆情《${p.title}》`) +
          (escalate ? ` · 事件级别上调：${LV_TEXT[open.level]}→${LV_TEXT[al.level]}` : ''), ts)
      } else {
        const r = run('INSERT INTO crisis (title,level,status,plan,analysis,created,updated,linked_email,keyword,alert_id,origin,topic,last_trigger_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
          al.title, al.level, 'monitoring', '',
          `由${LV_TEXT[al.level]}预警「${al.title}」自动建档：话题「${topic}」，命中关键词「${al.keyword || '全部'}」，首条关联舆情《${p.title}》（热度${p.heat}）。`,
          ts, ts, '', al.keyword, al.id, 'auto', topic, tsMs)
        crisisId = Number(r.lastInsertRowid)
        attachRule(crisisId, al.id, true, ts)
        addTimeline(crisisId, '自动建档', `高等级预警触发：${detail}`, ts)
        generateForCrisisStatus(crisisId, 'monitoring') // 通知编排：危机建档（监测中）状态流转
      }
    }
    const ev = run('INSERT INTO alert_events (alert_id,post_id,crisis_id,detail,time,status,resolved) VALUES (?,?,?,?,?,?,?)',
      al.id, postId, crisisId, detail, ts, 'open', null)
    const eventId = Number(ev.lastInsertRowid)
    const notified = generateForAlertEvent(eventId).length // 通知编排：按订阅生成通知任务
    // 传播路径联动：命中路径的关联预警规则/话题时自动挂接（失败不影响主链路）
    if (propHooks.onAlertEvent) {
      try { propHooks.onAlertEvent({ alertId: al.id, postId, crisisId, topic }) } catch (e) { console.error('[PROP] 预警挂接失败：', e.message) }
    }
    fired.push({ alert: al.title, level: al.level, eventId, crisisId, deduped, topic, notified })
  }
  return fired
}
