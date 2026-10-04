import crypto from 'node:crypto'
import { db } from './db.js'
import { ingestPost, postLite, now } from './pipeline.js'

// 单任务最多条目数（大批量导入）；每块提交大小；条目自动重试上限；块间让出间隔（ms）
export const JOB_MAX = 5000
export const CHUNK_SIZE = 25
export const ITEM_MAX_ATTEMPTS = 3
const CHUNK_DELAY_MS = 8

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// 运行态（不落库）：是否在跑、暂停标记、演练用故障注入条目序号集合
const runners = new Map() // jobId -> { paused:boolean }
const simFails = new Map() // jobId -> Set<seq>（注入一次瞬时故障，失败一次后清除）
const simFailsAlways = new Map() // jobId -> Set<seq>（每轮都失败，用于演练 failed → 手动重试恢复）

const FINAL_STATUSES = ['done', 'failed']

// 条目幂等键：优先用客户端自带 idem_key（跨批次内容去重），否则 taskKey:seq（任务内稳定）
export function itemKey(jobKey, seq, item) {
  const k = item && typeof item.idem_key === 'string' ? item.idem_key.trim() : ''
  return k || `${jobKey}:${seq + 1}`
}

export function jobStatusText(s) {
  return ({
    pending: '待执行', running: '进行中', paused: '已暂停', done: '已完成', failed: '部分失败'
  })[s] || s
}

// 重算任务汇总（进度记录与最终结果回写同一份数据，避免中途/最终口径不一致）
function refreshJobCounters(jobId) {
  const agg = q1(`SELECT
      COUNT(*) total,
      COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END),0) ok,
      COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) failed,
      COALESCE(SUM(CASE WHEN status='duplicate' THEN 1 ELSE 0 END),0) dup
    FROM import_job_items WHERE job_id=?`, jobId)
  const rows = q("SELECT status, result FROM import_job_items WHERE job_id=? AND status IN ('success','duplicate')", jobId)
  let alerts = 0, created = 0, merged = 0
  for (const r of rows) {
    let res
    try { res = JSON.parse(r.result || 'null') } catch { res = null }
    if (!res || !Array.isArray(res.triggered)) continue
    alerts += res.triggered.length
    for (const t of res.triggered) {
      if (t.crisisId && !t.deduped) created++
      if (t.deduped) merged++
    }
  }
  const pending = agg.total - agg.ok - agg.failed - agg.dup
  run(`UPDATE import_jobs SET total=?, total_ok=?, total_failed=?, total_duplicate=?,
       alerts_fired=?, crises_created=?, crises_merged=?, updated=? WHERE id=?`,
    agg.total, agg.ok, agg.failed, agg.dup, alerts, created, merged, now(), jobId)
  return { ...agg, pending, alerts, created, merged }
}

// 创建任务：任务幂等键命中时直接返回既有任务（含 createdNow 标记，供调用方决定响应码）
export function createJob({ idemKey, items, failSeqs = [], alwaysFailSeqs = [] }) {
  const key = idemKey || `job-${crypto.randomUUID()}`
  const existing = q1('SELECT * FROM import_jobs WHERE idem_key=?', key)
  if (existing) return { job: existing, createdNow: false }

  const ts = now()
  let jobId
  db.exec('BEGIN')
  try {
    const jr = run('INSERT INTO import_jobs (idem_key,total,status,created,updated) VALUES (?,?,?,?,?)',
      key, items.length, 'pending', ts, ts)
    jobId = Number(jr.lastInsertRowid)
    const stmt = db.prepare('INSERT INTO import_job_items (job_id,seq,idem_key,payload) VALUES (?,?,?,?)')
    items.forEach((it, seq) => {
      stmt.run(jobId, seq, itemKey(key, seq, it), JSON.stringify(it))
    })
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  if (Array.isArray(failSeqs) && failSeqs.length) {
    simFails.set(jobId, new Set(failSeqs.map(Number).filter((n) => n >= 0 && n < items.length)))
  }
  if (Array.isArray(alwaysFailSeqs) && alwaysFailSeqs.length) {
    simFailsAlways.set(jobId, new Set(alwaysFailSeqs.map(Number).filter((n) => n >= 0 && n < items.length)))
  }
  return { job: q1('SELECT * FROM import_jobs WHERE id=?', jobId), createdNow: true }
}

// 取出任务完整结果（含逐条记录，结果 JSON 已解析）
export function getJob(jobId) {
  const job = q1('SELECT * FROM import_jobs WHERE id=?', jobId)
  if (!job) return null
  const items = q('SELECT * FROM import_job_items WHERE job_id=? ORDER BY seq', jobId).map((it) => ({
    ...it,
    payload: safeParse(it.payload),
    result: safeParse(it.result)
  }))
  const counts = {
    pending: items.filter((i) => i.status === 'pending').length,
    processed: items.filter((i) => i.status === 'success' || i.status === 'duplicate').length
  }
  return { job, items, counts, statusText: jobStatusText(job.status) }
}

export function listJobs(limit = 20) {
  return q('SELECT * FROM import_jobs ORDER BY id DESC LIMIT ?', limit)
    .map((j) => ({ ...j, statusText: jobStatusText(j.status) }))
}

function safeParse(s) { try { return JSON.parse(s || 'null') } catch { return null } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 执行一轮：只处理 pending 条目，分块事务提交；块边界检查暂停；失败条目自动重试到上限。
async function runOnce(jobId) {
  const state = runners.get(jobId)
  if (!state) return
  if (state.paused) {
    run("UPDATE import_jobs SET status='paused', updated=? WHERE id=? AND status NOT IN ('done','failed')", now(), jobId)
    return
  }
  run("UPDATE import_jobs SET status='running', attempts=attempts+1, last_error='', updated=? WHERE id=?", now(), jobId)

  const pendingSeqs = () => q("SELECT seq FROM import_job_items WHERE job_id=? AND status='pending' ORDER BY seq", jobId).map((r) => r.seq)

  let seqs = pendingSeqs()
  while (seqs.length) {
    if (state.paused) {
      run("UPDATE import_jobs SET status='paused', updated=? WHERE id=?", now(), jobId)
      return
    }
    const chunk = seqs.slice(0, CHUNK_SIZE)
    db.exec('BEGIN')
    try {
      for (const seq of chunk) {
        const it = q1('SELECT * FROM import_job_items WHERE job_id=? AND seq=?', jobId, seq)
        if (!it || it.status !== 'pending') continue
        // 条目级独立事务：单条失败仅回滚该条，已成功条目不丢
        db.exec(`SAVEPOINT item_${seq}`)
        try {
          const payload = safeParse(it.payload) || {}
          const inject = simFails.get(jobId)
          const injectAlways = simFailsAlways.get(jobId)
          const simFail = !!(inject && inject.has(seq)) || !!(injectAlways && injectAlways.has(seq))
          if (inject && inject.has(seq)) inject.delete(seq)
          const r = ingestPost(payload, { idemKey: it.idem_key, simFail })
          let result, status, postId
          if (r.duplicate) {
            // 条目幂等命中：跨任务重试/重复提交，复用既有结果，不重复触发预警与危机
            status = 'duplicate'
            result = postLite(r.id) || { id: r.id, title: payload.title, triggered: [], duplicate: true }
            postId = r.id
          } else {
            status = 'success'
            result = { id: r.id, title: r.title, sentiment: r.sentiment, score: r.score, heat: r.heat, triggered: r.triggered }
            postId = r.id
          }
          run("UPDATE import_job_items SET status=?, attempts=attempts+1, result=?, error='', post_id=? WHERE id=?",
            status, JSON.stringify(result), postId, it.id)
          db.exec(`RELEASE SAVEPOINT item_${seq}`)
        } catch (e) {
          db.exec(`ROLLBACK TO SAVEPOINT item_${seq}`)
          db.exec(`RELEASE SAVEPOINT item_${seq}`)
          const attempts = it.attempts + 1
          const giveUp = attempts >= ITEM_MAX_ATTEMPTS
          run("UPDATE import_job_items SET status=?, attempts=attempts+1, error=?, post_id=NULL WHERE id=?",
            giveUp ? 'failed' : 'pending', String(e.message || e), it.id)
        }
      }
      db.exec('COMMIT')
    } catch (e) {
      // 块级异常（如提交失败）：本轮直接结束并把任务置 failed（条目仍 pending），由用户续跑重试；
      // 不在事务异常后立即自动重开事务，避免雪崩。已提交块的进度不丢。
      try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
      run("UPDATE import_jobs SET status='failed', last_error=?, updated=? WHERE id=?",
        `块执行异常，已暂停自动执行，请续跑重试：${e.message || e}`, now(), jobId)
      return
    }
    refreshJobCounters(jobId) // 进度记录落库：前端轮询可见
    await sleep(CHUNK_DELAY_MS) // 让出事件循环，保证大批量导入时 API 可响应
    seqs = pendingSeqs()
  }

  // 收尾：有 failed 条目 → failed（可重试续跑），否则 done
  const c = refreshJobCounters(jobId)
  const ts = now()
  if (c.failed > 0) {
    run("UPDATE import_jobs SET status='failed', last_error=?, finished=?, updated=? WHERE id=?",
      `${c.failed} 条条目达到重试上限（${ITEM_MAX_ATTEMPTS} 次）仍失败，可重试续跑`, ts, ts, jobId)
  } else {
    run("UPDATE import_jobs SET status='done', last_error='', finished=?, updated=? WHERE id=?", ts, ts, jobId)
  }
}

function startRunner(jobId) {
  // 同任务单 runner 保证（不同任务可并行排队，由事件循环分块调度）
  if (runners.has(jobId)) return
  const state = { paused: false, failedChunk: false }
  runners.set(jobId, state)
  Promise.resolve(runOnce(jobId)).catch((e) => {
    try { run("UPDATE import_jobs SET status='failed', last_error=?, updated=? WHERE id=?", `任务执行异常：${e.message || e}`, now(), jobId) } catch { /* 库不可用 */ }
  }).finally(() => {
    runners.delete(jobId)
    // 竞态兜底：runner 退出瞬间若已有续跑请求（状态被置回 running），立即重启，避免任务卡住
    const j = q1('SELECT status FROM import_jobs WHERE id=?', jobId)
    if (j && j.status === 'running') startRunner(jobId)
  })
}

// 启动/续跑任务（全部条目的终态任务直接返回，不重复执行；幂等键保证即使误调也不产生重复数据）
export function resumeJob(jobId, { clearInjection = false } = {}) {
  const job = q1('SELECT * FROM import_jobs WHERE id=?', jobId)
  if (!job) return null
  if (clearInjection) { simFails.delete(jobId); simFailsAlways.delete(jobId) }
  if (FINAL_STATUSES.includes(job.status)) {
    // 已结束但仍有未完成条目 → 继续：failed 条目（达到单条重试上限）重置为 pending 续跑；
    // pending 条目来自块级异常整块回滚（任务 failed 但无 failed 条目），同样需要续跑，不能漏判。
    const left = q1(`SELECT COALESCE(SUM(CASE WHEN status IN ('failed','pending') THEN 1 ELSE 0 END),0) c
      FROM import_job_items WHERE job_id=?`, jobId).c
    if (!left) return job // 全部成功：原样返回，不重复执行
    run("UPDATE import_job_items SET status='pending', error='' WHERE job_id=? AND status='failed'", jobId)
  }
  const state = runners.get(jobId)
  if (state) state.paused = false // 暂停中显式续跑
  // 显式置 running：既让前端立即感知，也作为旧 runner 退出时的重启信号（竞态兜底）
  run("UPDATE import_jobs SET status='running', last_error='', updated=? WHERE id=? AND status!='done'", now(), jobId)
  startRunner(jobId)
  return q1('SELECT * FROM import_jobs WHERE id=?', jobId)
}

export function pauseJob(jobId) {
  const job = q1('SELECT * FROM import_jobs WHERE id=?', jobId)
  if (!job) return null
  if (FINAL_STATUSES.includes(job.status)) return job // 已结束不可暂停
  const state = runners.get(jobId)
  if (state) state.paused = true // 块边界停止派发
  // 状态立即落库（正在执行的当前块跑完后生效，前端轮询立即看到「已暂停」语义）
  run("UPDATE import_jobs SET status='paused', updated=? WHERE id=? AND status NOT IN ('done','failed')", now(), jobId)
  return q1('SELECT * FROM import_jobs WHERE id=?', jobId)
}

// 进程启动恢复：上次运行中被打断（崩溃/重启）的任务转 paused 并保留 pending 进度，
// 由用户显式续跑，避免重启瞬间大批量任务抢占；checkpoint 之后已提交的条目不丢。
export function recoverInterrupted() {
  const rows = q("SELECT id FROM import_jobs WHERE status IN ('running','pending')")
  for (const j of rows) {
    run("UPDATE import_jobs SET status='paused', last_error=?, updated=? WHERE id=?",
      '服务曾中断，任务已暂停，可一键续跑（断点恢复）', now(), j.id)
    refreshJobCounters(j.id)
  }
  return rows.length
}
