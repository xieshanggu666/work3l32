<template>
  <div class="posts">
    <div class="toolbar">
      <form class="filters" @submit.prevent="load">
        <select v-model="f.sentiment"><option value="all">全部情感</option><option value="positive">正面</option><option value="neutral">中性</option><option value="negative">负面</option></select>
        <select v-model="f.source"><option value="all">全部渠道</option><option v-for="s in store.sources" :key="s.id" :value="s.id">{{ s.name }}</option></select>
        <input v-model="f.q" placeholder="搜索关键词…" />
        <button class="btn" type="submit">查询</button>
      </form>
      <button class="add" @click="showAdd=!showAdd">＋ 录入舆情</button>
      <button class="batch" @click="toggleBatch">📥 批量导入</button>
    </div>

    <form v-if="showAdd" class="add-form" @submit.prevent="submit">
      <input v-model="form.title" placeholder="标题" required />
      <textarea v-model="form.content" placeholder="舆情正文（将自动进行情感分析）" required></textarea>
      <div class="row">
        <select v-model="form.source_id"><option v-for="s in store.sources" :key="s.id" :value="s.id">{{ s.name }}</option></select>
        <input v-model="form.topic" placeholder="话题分类" />
        <input v-model="form.media" placeholder="来源媒体，如 澎湃新闻" />
      </div>
      <div class="row">
        <button class="save" type="submit">收录并分析</button>
        <button type="button" class="ghost" @click="showAdd=false">取消</button>
      </div>
    </form>

    <div v-if="showBatch" class="batch-panel">
      <div class="hint">
        每行一条，格式 <code>标题|正文|话题|来源媒体</code>（话题、媒体可省）。统一渠道：
        <select v-model="batchSource"><option v-for="s in store.sources" :key="s.id" :value="s.id">{{ s.name }}</option></select>
        <span class="cnt">共 {{ batchCount }} 条 · 单任务上限 {{ JOB_MAX }} 条 · 失败自动重试、可断点续跑</span>
      </div>
      <textarea v-model="batchText" :disabled="!!job && (job.job.status==='running')" rows="6" placeholder="某品牌售后拖延引投诉|多位用户反映客服响应慢，投诉量上升。|产品体验|澎湃新闻"></textarea>
      <div class="row">
        <button class="save" :disabled="starting || (job && job.job.status==='running')" @click="submitBatch">
          {{ starting ? '提交中…' : (job && ['paused','failed'].includes(job.job.status) ? '提交新任务' : '创建导入任务') }}
        </button>
        <button v-if="job && job.job.status==='running'" class="ghost" @click="pauseJob">⏸ 暂停</button>
        <button v-if="job && job.job.status==='paused'" class="save" @click="resumeJob">▶ 续跑</button>
        <button v-if="job && job.job.status==='failed'" class="save" @click="retryJob">↻ 重试失败条目（{{ job.job.total_failed }}）</button>
        <button class="ghost" @click="resetPanel">重置面板</button>
      </div>

      <!-- 进度记录 -->
      <div v-if="job" class="progress-box">
        <div class="phead">
          <span class="tag" :class="job.job.status">#{{ job.job.id }} {{ job.statusText }}</span>
          <span class="pct">{{ pct }}%</span>
          <span class="pc">成功 {{ job.job.total_ok }}<template v-if="job.job.total_duplicate"> · 重复 {{ job.job.total_duplicate }}</template> · 失败 {{ job.job.total_failed }} · 待处理 {{ pendingCount }}</span>
        </div>
        <div class="bar"><i :style="{ width: pct + '%' }" :class="job.job.status"></i></div>
        <div v-if="job.job.last_error" class="perr">⚠️ {{ job.job.last_error }}</div>
        <div v-if="done" class="sum">
          ✅ 任务结束：导入 {{ job.job.total_ok }} 条<template v-if="job.job.total_duplicate">（幂等去重 {{ job.job.total_duplicate }} 条）</template>
          <template v-if="job.job.alerts_fired">
            · 触发预警 {{ job.job.alerts_fired }} 次（自动建档 {{ job.job.crises_created }} · 并入危机 {{ job.job.crises_merged }}）
          </template>
        </div>
      </div>

      <div v-if="batchError" class="err">
        ❌ {{ batchError }}
        <ul v-if="batchErrDetails.length"><li v-for="d in batchErrDetails" :key="d">{{ d }}</li></ul>
      </div>

      <!-- 结果回写：逐条 -->
      <div v-if="job && done" class="result">
        <div class="result-title">逐条结果</div>
        <div v-for="it in job.items" :key="it.id" class="ritem">
          <span class="no">#{{ it.seq + 1 }}</span>
          <span v-if="it.status==='success'" class="chip sent" :class="it.result?.sentiment">{{ sentText(it.result?.sentiment) }}</span>
          <span v-else-if="it.status==='duplicate'" class="chip dup">重复跳过</span>
          <span v-else class="chip fail">失败（{{ it.attempts }} 次）</span>
          <span v-if="it.result?.heat != null" class="heat">热度 {{ it.result.heat }}</span>
          <span class="rt">{{ it.result?.title || it.payload?.title }}</span>
          <span v-if="it.result?.triggered?.length" class="trig">⚠️ {{ trigText(it.result.triggered) }}</span>
          <span v-if="it.error" class="rerr">{{ it.error }}</span>
        </div>
      </div>

      <!-- 历史可恢复任务 -->
      <div class="jobs">
        <div class="jobs-head"><span>最近导入任务（可恢复 / 可回看结果）</span><button class="link" @click="loadJobs">刷新</button></div>
        <div v-if="!jobs.length" class="jobs-empty">暂无导入任务</div>
        <div v-for="j in jobs" :key="j.id" class="jitem" :class="{ active: job && job.job.id === j.id }">
          <button class="jmain" @click="openJob(j.id)">
            <span class="tag" :class="j.status">#{{ j.id }} {{ j.statusText }}</span>
            <span class="jcounts">{{ j.total_ok }}/{{ j.total }} 成功<template v-if="j.total_failed"> · {{ j.total_failed }} 失败</template><template v-if="j.total_duplicate"> · {{ j.total_duplicate }} 重复</template></span>
            <span class="jtime">{{ j.finished || j.updated }}</span>
          </button>
        </div>
      </div>
    </div>

    <div class="list">
      <div v-for="p in posts" :key="p.id" class="post" :class="p.sentiment">
        <div class="head">
          <span class="chip sent" :class="p.sentiment">{{ sentText(p.sentiment) }}</span>
          <span class="score"><i :style="scoreBar(p.sentiment_score)"></i>{{ (p.sentiment_score>=0?'+':'')+p.sentiment_score.toFixed(2) }}</span>
          <span v-if="p.hot" class="hot">🔥 热点</span>
          <span class="heat">热度 {{ p.heat }}</span>
          <span class="time">{{ p.published }}</span>
        </div>
        <b class="title">{{ p.title }}</b>
        <p class="content">{{ p.content }}</p>
        <div class="meta">
          <span class="src">{{ srcName(p.source_id) }}</span>
          <span class="topic">#{{ p.topic }}</span>
          <span class="media">{{ p.media }}</span>
        </div>
      </div>
      <div v-if="!posts.length" class="none">没有匹配的舆情</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { usePubStore } from '@/store/pub'
const store = usePubStore()
const posts = ref([])
const f = ref({ sentiment: 'all', source: 'all', q: '' })
const showAdd = ref(false)
const form = ref({ title: '', content: '', source_id: null, topic: '', media: '' })
const showBatch = ref(false)
const batchText = ref('')
const batchSource = ref(1)
const starting = ref(false)
const batchError = ref('')
const batchErrDetails = ref([])

// 可恢复任务
const JOB_MAX = 5000
const POLL_INTERVAL_MS = 400
const POLL_MAX_FAILURES = 5 // 连续失败上限：熔断并提示，避免服务不可用时前端静默空转
const job = ref(null) // { job, items, counts, statusText }
const jobs = ref([])
let pollTimer = null
let polling = false // 单次轮询在途标记：防止 tick 叠加、回写乱序
let pollFailures = 0

const batchCount = computed(() => batchText.value.split('\n').filter((l) => l.trim()).length)
const done = computed(() => job.value && ['done', 'failed'].includes(job.value.job.status))
const pct = computed(() => {
  if (!job.value) return 0
  const j = job.value.job
  if (!j.total) return 0
  return Math.round(((j.total_ok + j.total_failed + j.total_duplicate) / j.total) * 100)
})
const pendingCount = computed(() => job.value ? job.value.counts.pending : 0)

async function load() {
  const qs = {}
  if (f.value.sentiment !== 'all') qs.sentiment = f.value.sentiment
  if (f.value.source !== 'all') qs.source = f.value.source
  if (f.value.q) qs.q = f.value.q
  posts.value = await store.fetchPosts(qs)
}
async function submit() {
  try {
    await store.addPost({ ...form.value, source_id: Number(form.value.source_id || 1) })
    form.value = { title: '', content: '', source_id: null, topic: '', media: '' }
    showAdd.value = false
    load()
  } catch (e) { store.msg(e.message, 'warn') }
}
// 解析批量文本：每行 标题|正文|话题|来源媒体，行级校验
function parseBatch() {
  const items = [], errs = []
  batchText.value.split('\n').forEach((line, i) => {
    const t = line.trim()
    if (!t) return
    const [title, content, topic, media] = t.split('|').map((s) => (s || '').trim())
    if (!title || !content) { errs.push(`第 ${i + 1} 行：标题与正文不能为空`); return }
    items.push({ title, content, topic, media, source_id: Number(batchSource.value) || 1 })
  })
  return { items, errs }
}
// 任务幂等键：同一提交重复点（网络抖动/刷新）返回同一任务
function uuid() {
  return (crypto?.randomUUID && crypto.randomUUID()) || 'job-' + Date.now() + '-' + Math.random().toString(16).slice(2)
}
async function submitBatch() {
  batchError.value = ''; batchErrDetails.value = []
  const { items, errs } = parseBatch()
  if (errs.length) { batchError.value = '格式校验未通过，未创建任务'; batchErrDetails.value = errs; return }
  if (!items.length) { batchError.value = '没有可导入的数据'; return }
  if (items.length > JOB_MAX) { batchError.value = `单任务最多 ${JOB_MAX} 条`; return }
  stopPolling()
  starting.value = true
  try {
    const r = await store.createImport(items, `ui-${uuid()}`)
    await refreshJob(r.jobId) // 立即同步一次（复用既有的终态/暂停任务时也能正确展示与触发全局刷新）
    if (job.value && ['pending', 'running'].includes(job.value.job.status)) startPolling()
    if (!r.reused) batchText.value = ''
  } catch (e) {
    batchError.value = e.message
    batchErrDetails.value = e.details || []
  } finally { starting.value = false }
}
async function refreshJob(id) {
  job.value = await store.fetchJob(id)
  pollFailures = 0 // 成功响应即重置连续失败计数
  if (done.value) {
    stopPolling()
    await store.load() // 统计/预警/危机闭环刷新
    load(); loadJobs()
    const j = job.value.job
    if (j.total_failed) store.msg(`任务 #${j.id} 结束：${j.total_failed} 条失败，可重试续跑`, 'warn')
    else if (j.alerts_fired) store.msg(`导入完成 ${j.total_ok} 条，触发预警 ${j.alerts_fired} 次`, 'warn')
    else store.msg(`导入完成 ${j.total_ok} 条`, 'success')
  }
}
async function openJob(id) {
  stopPolling()
  await refreshJob(id)
  if (job.value.job.status === 'running') startPolling() // 仅进行中任务持续跟踪
}
async function pauseJob() {
  try {
    await store.pauseImport(job.value.job.id)
    stopPolling()
    await refreshJob(job.value.job.id)
  } catch (e) {
    store.msg(`暂停失败：${e.message}。可重试或稍后刷新任务状态`, 'warn')
    ensurePolling() // 操作未生效时恢复跟踪，避免界面停在旧状态
  }
}
async function resumeJob() {
  try {
    await store.resumeImport(job.value.job.id)
    await refreshJob(job.value.job.id)
    startPolling()
  } catch (e) {
    store.msg(`续跑失败：${e.message}。可重试，任务进度不丢`, 'warn')
  }
}
async function retryJob() {
  batchError.value = ''
  try {
    await store.resumeImport(job.value.job.id) // failed 条目由后端重置后续跑
    await refreshJob(job.value.job.id)
    startPolling()
  } catch (e) {
    batchError.value = `重试失败：${e.message}`
  }
}
function startPolling() {
  stopPolling()
  polling = false
  pollFailures = 0
  pollTimer = setInterval(pollTick, POLL_INTERVAL_MS)
}
// 恢复跟踪（若已有轮询则保持）：供操作失败后兜底，确保任务仍被持续刷新
function ensurePolling() {
  if (!job.value || pollTimer) return
  const st = job.value.job.status
  if (!['done', 'failed', 'paused'].includes(st)) startPolling()
}
async function pollTick() {
  if (!job.value) return stopPolling()
  const st = job.value.job.status
  if (['done', 'failed', 'paused'].includes(st)) return stopPolling() // 暂停/终态无需再轮询
  if (polling) return // 上一轮请求未返回：跳过本轮，防止叠加与乱序回写
  polling = true
  try {
    await refreshJob(job.value.job.id)
  } catch (e) {
    pollFailures += 1
    if (pollFailures >= POLL_MAX_FAILURES) {
      // 熔断：停止空转并明确提示，前端不再静默卡住；恢复操作或刷新任务可重新跟踪
      stopPolling()
      store.msg(`任务 #${job.value.job.id} 状态刷新连续失败（${pollFailures} 次）：${e.message}。请检查服务后重试`, 'warn')
    }
  } finally {
    polling = false
  }
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null } polling = false }
async function loadJobs() { jobs.value = await store.fetchImports() }
async function toggleBatch() {
  showBatch.value = !showBatch.value
  if (showBatch.value) loadJobs()
}
function resetPanel() {
  stopPolling()
  job.value = null; batchError.value = ''; batchErrDetails.value = []; batchText.value = ''
}
function trigText(triggered) {
  return triggered.map((t) =>
    t.deduped ? `${t.alert}（并入危机 #${t.crisisId}）`
      : t.crisisId ? `${t.alert}（自动建档 #${t.crisisId}）` : t.alert).join('、')
}
function sentText(x) { return x === 'positive' ? '😊 正面' : x === 'negative' ? '😟 负面' : '😐 中性' }
function scoreBar(score) { const w = Math.min(100, Math.abs(score) * 100); return { width: w + '%', background: score >= 0 ? '#66bb6a' : '#ef5350' } }
function srcName(id) { return store.sources.find((s) => s.id === id)?.name || '未知' }
onMounted(load)
onBeforeUnmount(stopPolling)
</script>

<style scoped>
.posts{display:flex;flex-direction:column;gap:12px;}
.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
.filters{display:flex;gap:8px;flex-wrap:wrap;}
select,input,textarea,button{font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:8px 10px;font-size:12px;}
textarea:disabled{opacity:.6;}
textarea{resize:vertical;min-height:56px;}
.btn{background:#2962ff;border:none;color:#fff;cursor:pointer;font-weight:600;}
.add{background:linear-gradient(135deg,#43a047,#2e7d32);border:none;color:#fff;font-weight:600;cursor:pointer;}
.batch{background:linear-gradient(135deg,#00897b,#00695c);border:none;color:#fff;font-weight:600;cursor:pointer;}
.batch-panel{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px;}
.batch-panel .hint{font-size:12px;color:#8ba2c8;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.batch-panel .hint code{background:#0c1730;padding:2px 6px;border-radius:4px;color:#90caf9;}
.batch-panel .cnt{margin-left:auto;color:#5b6f94;font-size:11px;}
.batch-panel textarea{width:100%;box-sizing:border-box;}
.err{background:#3a1215;border:1px solid #b71c1c;color:#ef9a9a;border-radius:8px;padding:10px 12px;font-size:12px;}
.err ul{margin:6px 0 0;padding-left:18px;}
.progress-box{background:#0c1730;border:1px solid rgba(120,160,220,0.16);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;}
.phead{display:flex;align-items:center;gap:10px;font-size:12px;flex-wrap:wrap;}
.phead .pct{font-weight:700;color:#fff;font-size:13px;}
.phead .pc{color:#8ba2c8;font-size:11px;margin-left:auto;}
.bar{height:8px;border-radius:5px;background:#0a1224;overflow:hidden;}
.bar i{display:block;height:100%;border-radius:5px;background:#2962ff;transition:width .25s;}
.bar i.done{background:#43a047;}
.bar i.failed{background:#e65100;}
.bar i.paused{background:#f9a825;}
.perr{color:#ffab91;font-size:11px;}
.sum{color:#a5d6a7;font-size:12px;font-weight:600;}
.tag{font-size:10px;padding:2px 8px;border-radius:10px;font-weight:700;white-space:nowrap;}
.tag.running{background:#0d47a1;color:#bbdefb;}
.tag.done{background:#1b5e20;color:#a5d6a7;}
.tag.failed{background:#e65100;color:#ffe0b2;}
.tag.paused{background:#f57f17;color:#fff8e1;}
.tag.pending{background:#37474f;color:#b0bec5;}
.result{background:#0c1730;border:1px solid rgba(120,160,220,0.16);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;}
.result-title{color:#8ba2c8;font-size:11px;font-weight:600;}
.ritem{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:#aebadd;border-top:1px dashed rgba(120,160,220,0.12);padding-top:6px;}
.ritem .no{color:#5b6f94;font-size:11px;}
.ritem .rt{color:#dbe4f3;}
.ritem .trig{color:#ffb300;font-size:11px;}
.ritem .rerr{color:#ef9a9a;font-size:11px;}
.chip.dup{background:#37474f;color:#b0bec5;}
.chip.fail{background:#b71c1c;color:#ffcdd2;}
.jobs{border-top:1px dashed rgba(120,160,220,0.16);padding-top:8px;display:flex;flex-direction:column;gap:4px;}
.jobs-head{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#5b6f94;}
.link{background:none;border:none;color:#90caf9;cursor:pointer;padding:2px 6px;}
.jobs-empty{font-size:11px;color:#5b6f94;padding:4px 0;}
.jitem .jmain{display:flex;align-items:center;gap:10px;width:100%;background:transparent;border:1px solid transparent;text-align:left;cursor:pointer;padding:5px 8px;border-radius:6px;}
.jitem .jmain:hover{background:#0c1730;}
.jitem.active .jmain{background:#0c1730;border-color:rgba(120,160,220,0.3);}
.jcounts{font-size:11px;color:#aebadd;}
.jtime{margin-left:auto;font-size:10px;color:#5b6f94;}
.add-form{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px;}
.row{display:flex;gap:8px;flex-wrap:wrap;}
.add-form .row:last-child{margin-top:4px;}
.save{background:#2962ff;border:none;color:#fff;font-weight:600;cursor:pointer;}
.save:disabled{opacity:.55;cursor:not-allowed;}
.ghost{background:#16263f;color:#8ba2c8;cursor:pointer;}
.list{display:flex;flex-direction:column;gap:12px;}
.post{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px;border-left:4px solid #90a4ae;}
.post.negative{border-left-color:#ef5350;}.post.positive{border-left-color:#66bb6a;}.post.neutral{border-left-color:#90a4ae;}
.head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;}
.chip{font-size:11px;padding:2px 8px;border-radius:6px;}
.chip.positive{background:#1b5e20;color:#a5d6a7;}.chip.negative{background:#b71c1c;color:#ffcdd2;}.chip.neutral{background:#37474f;color:#b0bec5;}
.score{display:flex;align-items:center;gap:5px;color:#8ba2c8;font-size:11px;}
.score i{height:5px;border-radius:3px;width:40px;background:#0c1730;}
.hot{font-size:10px;color:#ffd54f;}
.heat{font-size:11px;color:#ffb300;}
.time{margin-left:auto;color:#5b6f94;font-size:11px;}
.title{color:#fff;font-size:15px;display:block;margin-bottom:4px;}
.content{color:#aebadd;font-size:13px;line-height:1.5;margin:0 0 8px;}
.meta{display:flex;gap:12px;font-size:11px;color:#8ba2c8;}
.src{font-weight:600;}
.topic{color:#90caf9;}
.media{color:#5b6f94;}
.none{color:#5b6f94;text-align:center;padding:30px;}
</style>
