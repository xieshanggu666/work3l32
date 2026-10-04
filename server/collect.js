import { db } from './db.js'
import { now, ingestPost } from './pipeline.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// ===== 调度参数（演示用小时间窗，便于观察退避重试与故障自动停止） =====
export const COLLECT_TICK_MS = 3000  // 调度扫描间隔
export const RETRY_BASE_MS = 15000   // 失败退避基数（第 n 次连续失败等待 n × 基数）
const DUE_BATCH = 10                 // 每轮扫描处理的数据源上限
const RUN_KEEP = 100                 // 每个数据源保留的最近采集记录条数

export const SOURCE_TYPES = { api: 'API 接口', rss: 'RSS 订阅', crawler: '网页爬虫' }
export const COLLECT_STATUS = {
  running: '运行中', retrying: '重试中', stopped: '已停止', failed: '故障停止', disabled: '已停用'
}

// ===== 模拟上游数据源（演示）：endpoint 演练约定与通知渠道一致——
// 含 always-fail 持续失败（验证退避重试与故障自动停止）、含 flaky 首次失败（验证自动重试恢复） =====
const FEED = [
  { t: '某连锁餐饮门店后厨卫生问题曝光', c: '暗访视频显示后厨操作不规范、卫生状况堪忧，多名消费者投诉要求品牌方回应。', topic: '食品安全', media: '澎湃新闻' },
  { t: '用户集中投诉某平台售后响应迟缓', c: '多位用户反映客服回应迟缓、退款迟迟未到账，投诉量持续上升，部分用户表示不满。', topic: '服务投诉', media: '消费质量报' },
  { t: '某楼盘再度延期交付业主聚集维权', c: '业主称项目多次延期且补偿方案未落地，工程进度缓慢，现场聚集维权。', topic: '房地产', media: '财经观察' },
  { t: '新能源车主吐槽充电桩故障频发', c: '多地车主反映充电桩故障率偏高、维修响应慢，呼吁厂商完善售后保障。', topic: '新能源', media: '汽车之家' },
  { t: '某品牌售后服务升级获用户好评', c: '服务响应提速、保障范围扩大，用户满意度持续提升，舆论反馈积极。', topic: '企业动态', media: '行业观察' },
  { t: '惠民补贴政策落地市民点赞', c: '多地同步发放惠民补贴，办理流程简化，市民普遍表示满意。', topic: '民生', media: '人民日报' },
  { t: '新款旗舰手机发布预约量攀升', c: '新品影像与续航提升明显，网友讨论热情高涨，市场反应积极。', topic: '消费电子', media: '微博热搜' },
  { t: '某平台会员权益调整引热议', c: '权益调整公告发布后，网友围绕性价比展开讨论，情绪中性偏负。', topic: '平台运营', media: '排行榜' },
  { t: '景区预约限流运行平稳有序', c: '假期景区实行预约限流，整体秩序良好，仅有零星排队抱怨。', topic: '文旅', media: '本地资讯' },
  { t: '科研机构发布前沿技术白皮书', c: '白皮书披露多项技术突破，业内关注商业化前景，评价积极。', topic: '前沿科技', media: '科普中国' }
]
const flakyOnce = new Set() // 演练用：flaky 端点首次采集注入一次瞬时故障（进程级，重启后重置）
function mockFetch(src) {
  const ep = src.endpoint || ''
  if (ep.includes('always-fail')) throw new Error('数据源连接超时（模拟持续故障：always-fail）')
  if (ep.includes('flaky') && !flakyOnce.has(src.id)) {
    flakyOnce.add(src.id)
    throw new Error('数据源瞬时故障（模拟：flaky，自动重试可恢复）')
  }
  const limit = Math.min(50, Math.max(1, src.batch_size || 5))
  const cursor = Math.max(0, parseInt(src.cursor, 10) || 0)
  // 从游标处（含）开始抓取：重叠 1 条模拟上游分页重叠，验证幂等去重
  const from = cursor > 0 ? cursor : 1
  const items = []
  for (let ext = from; ext < from + limit; ext++) {
    const tpl = FEED[(ext + src.id) % FEED.length]
    items.push({
      extId: String(ext),
      title: tpl.t,
      content: tpl.c,
      topic: (src.topic || '').trim() || tpl.topic,
      media: (src.media || '').trim() || tpl.media
    })
  }
  return items
}

// 采集运行记录（抓取/入库/去重/闭环结果与游标推进留痕），按源保留最近 RUN_KEEP 条
function recordRun(sourceId, { status, fetched = 0, inserted = 0, duplicated = 0, alerts = 0, crises = 0, cursorFrom = '', cursorTo = '', error = '', operator, started, finished }) {
  run(`INSERT INTO collect_runs (source_id,status,fetched,inserted,duplicated,alerts,crises,cursor_from,cursor_to,error,operator,started,finished)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    sourceId, status, fetched, inserted, duplicated, alerts, crises, cursorFrom, cursorTo, error, operator || '调度器', started, finished)
  run(`DELETE FROM collect_runs WHERE source_id=? AND id NOT IN
    (SELECT id FROM collect_runs WHERE source_id=? ORDER BY id DESC LIMIT ?)`, sourceId, sourceId, RUN_KEEP)
}

const inFlight = new Set() // 运行态（不落库）：同一数据源并发采集互斥

// 采集一轮：抓取 → 逐条走统一管线（情感分析→预警→危机→通知）→ 游标推进，全程事务化。
// 失败：连续失败计数 + 退避重试，达上限自动停止任务（修复后可重新启动）。
export function runCollectOnce(sourceId, operator = '调度器') {
  const src = q1('SELECT * FROM collect_sources WHERE id=?', sourceId)
  if (!src || !src.enabled) return null
  if (inFlight.has(sourceId)) return { skipped: true }
  inFlight.add(sourceId)
  const started = now()
  const cursorFrom = src.cursor
  try {
    let items
    try {
      items = mockFetch(src)
    } catch (e) {
      const fails = (src.fail_count || 0) + 1
      const giveUp = fails >= Math.max(1, src.max_retry || 5)
      const msg = String(e.message || e)
      const ts = now()
      db.exec('BEGIN')
      try {
        run(`UPDATE collect_sources SET fail_count=?, last_run_at=?, last_status='failed', last_error=?,
          next_run_at=?, running=?, total_runs=total_runs+1 WHERE id=?`,
          fails, ts, msg, giveUp ? null : Date.now() + RETRY_BASE_MS * fails, giveUp ? 0 : src.running, sourceId)
        recordRun(sourceId, {
          status: 'failed', cursorFrom, cursorTo: src.cursor, operator, started, finished: ts,
          error: giveUp ? `${msg}（连续失败 ${fails} 次已达上限，任务自动停止）` : msg
        })
        db.exec('COMMIT')
      } catch (e2) {
        try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
        throw e2
      }
      return { ok: false, error: msg, giveUp }
    }
    // 成功：幂等键 collect:{源}:{外部ID} 去重——重采/游标回退/分页重叠命中既有舆情时跳过，
    // 绝不重复触发预警、重复建档/归并危机（与批量导入同一套去重语义）
    let inserted = 0, duplicated = 0, alerts = 0, crises = 0
    let maxExt = parseInt(src.cursor, 10) || 0
    const ts = now()
    db.exec('BEGIN')
    try {
      for (const it of items) {
        const r = ingestPost(
          { title: it.title, content: it.content, source_id: src.source_id, topic: it.topic, media: it.media },
          { idemKey: `collect:${sourceId}:${it.extId}` }
        )
        if (r.duplicate) duplicated++
        else {
          inserted++
          alerts += r.triggered.length
          crises += r.triggered.filter((t) => t.crisisId && !t.deduped).length
        }
        const n = parseInt(it.extId, 10)
        if (Number.isInteger(n) && n > maxExt) maxExt = n
      }
      const cursorTo = String(maxExt)
      run(`UPDATE collect_sources SET cursor=?, fail_count=0, last_run_at=?, last_status='success', last_error='',
        next_run_at=?, total_runs=total_runs+1, total_fetched=total_fetched+?,
        total_inserted=total_inserted+?, total_duplicated=total_duplicated+? WHERE id=?`,
        cursorTo, ts, src.running ? Date.now() + Math.max(5, src.interval_sec || 15) * 1000 : null,
        items.length, inserted, duplicated, sourceId)
      recordRun(sourceId, {
        status: 'success', fetched: items.length, inserted, duplicated, alerts, crises,
        cursorFrom, cursorTo, operator, started, finished: now()
      })
      db.exec('COMMIT')
      return { ok: true, fetched: items.length, inserted, duplicated, alerts, crises }
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
      throw e
    }
  } finally {
    inFlight.delete(sourceId)
  }
}

// 调度一轮：到期且运行中的数据源各采一轮（导出供测试与手动触发）
export function runCollectTick() {
  const due = q(`SELECT id FROM collect_sources WHERE enabled=1 AND running=1
    AND (next_run_at IS NULL OR next_run_at<=?) ORDER BY id LIMIT ?`, Date.now(), DUE_BATCH)
  for (const s of due) runCollectOnce(s.id)
}

let timer = null
export function startCollectScheduler() {
  if (timer) return
  timer = setInterval(() => {
    try { runCollectTick() } catch (e) { console.error('[COLLECT] 调度异常：', e.message) }
  }, COLLECT_TICK_MS)
  if (timer.unref) timer.unref()
  console.log(`[COLLECT] 采集调度器已启动（每 ${COLLECT_TICK_MS / 1000} 秒扫描到期数据源：采集 / 失败退避重试）`)
}
export function stopCollectScheduler() { if (timer) clearInterval(timer); timer = null }

// 启动恢复：运行态落库（running=1），重启后调度器按游标自动接续采集，不丢不重
export function resumeCollectTasks() {
  return q1('SELECT COUNT(*) c FROM collect_sources WHERE running=1 AND enabled=1').c
}

// ===== 任务操作（值班员启停/手动采集；状态守卫幂等） =====
export function startTask(id) {
  const src = q1('SELECT * FROM collect_sources WHERE id=?', id)
  if (!src) return null
  if (!src.enabled) return { error: '数据源连接已停用，请先由管理员启用连接' }
  if (src.running) return { already: true }
  // 启动即到期（next_run_at=NULL），下一轮调度立即采集；连续失败计数清零重新出发
  run('UPDATE collect_sources SET running=1, fail_count=0, last_error=\'\', next_run_at=NULL WHERE id=? AND enabled=1', id)
  return { ok: true }
}

export function stopTask(id) {
  const src = q1('SELECT * FROM collect_sources WHERE id=?', id)
  if (!src) return null
  if (!src.running) return { already: true }
  run('UPDATE collect_sources SET running=0 WHERE id=?', id)
  return { ok: true }
}

// 手动立即采集一轮（不要求任务处于运行中；结果含成功/失败明细，供前端回写）
export function runNowTask(id, operator) {
  const src = q1('SELECT * FROM collect_sources WHERE id=?', id)
  if (!src) return null
  if (!src.enabled) return { error: '数据源连接已停用，无法采集' }
  const r = runCollectOnce(id, operator)
  if (!r || r.skipped) return { error: '该数据源正在采集中，请稍候' }
  return { ok: true, result: r }
}

// 游标归零（管理员）：重新采集历史条目，已入库舆情按幂等键自动去重（演示去重闭环）
export function resetCursor(id) {
  const src = q1('SELECT * FROM collect_sources WHERE id=?', id)
  if (!src) return null
  run("UPDATE collect_sources SET cursor='0', fail_count=0, last_error='' WHERE id=?", id)
  return { ok: true }
}

// ===== 查询 =====
function taskStatus(s) {
  if (!s.enabled) return 'disabled'
  if (s.running && s.fail_count > 0) return 'retrying'
  if (s.running) return 'running'
  if (s.last_status === 'failed' && s.fail_count >= Math.max(1, s.max_retry || 5)) return 'failed'
  return 'stopped'
}

export function listSources() {
  return q(`SELECT cs.*, s.name channel_name FROM collect_sources cs
    LEFT JOIN sources s ON s.id=cs.source_id ORDER BY cs.id`)
    .map((s) => ({ ...s, task_status: taskStatus(s) }))
}

export function listRuns({ sourceId = null, limit = 50 } = {}) {
  const base = `SELECT cr.*, cs.name source_name FROM collect_runs cr
    LEFT JOIN collect_sources cs ON cs.id=cr.source_id`
  return sourceId
    ? q(`${base} WHERE cr.source_id=? ORDER BY cr.id DESC LIMIT ?`, sourceId, limit)
    : q(`${base} ORDER BY cr.id DESC LIMIT ?`, limit)
}

export function validateSource(b) {
  if (!b || typeof b.name !== 'string' || !b.name.trim()) return '数据源名称必填'
  if (!SOURCE_TYPES[b.type]) return '数据源类型无效'
  if (typeof b.endpoint !== 'string' || !b.endpoint.trim()) return '连接地址必填'
  if (!q1('SELECT 1 FROM sources WHERE id=?', +b.source_id)) return '入库渠道不存在'
  if (!(+b.interval_sec >= 5)) return '采集间隔至少 5 秒'
  if (!(+b.batch_size >= 1) || +b.batch_size > 50) return '单次抓取条数需为 1-50'
  if (!(+b.max_retry >= 1) || +b.max_retry > 10) return '连续失败上限需为 1-10'
  return null
}
