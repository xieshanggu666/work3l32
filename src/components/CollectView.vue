<template>
  <div class="collect">
    <div class="ctoolbar">
      <div class="subtabs">
        <button v-for="t in subtabs" :key="t.key" :class="{active:sub===t.key}" @click="sub=t.key">
          {{ t.icon }} {{ t.label }}
          <span v-if="t.key==='tasks' && counts.running" class="bd">{{ counts.running }}</span>
        </button>
      </div>
      <span class="me">👤 {{ store.user.name }} · {{ roleText(store.user.role) }}</span>
    </div>

    <!-- ============ 采集任务 ============ -->
    <template v-if="sub==='tasks'">
      <div class="sum">
        <div class="scard"><b>{{ counts.running || 0 }}</b><span>运行中</span></div>
        <div class="scard"><b>{{ counts.retrying || 0 }}</b><span>重试中</span></div>
        <div class="scard"><b>{{ counts.failed || 0 }}</b><span>故障停止</span></div>
        <div class="scard"><b>{{ totals.inserted || 0 }}</b><span>累计入库</span></div>
        <div class="scard"><b>{{ totals.duplicated || 0 }}</b><span>幂等去重</span></div>
      </div>
      <div v-if="!sources.length" class="none">暂无数据源连接，请先在「数据源连接」中配置（需管理员权限）</div>
      <div class="srclist">
        <div v-for="s in sources" :key="s.id" class="src" :class="s.task_status">
          <div class="s-top">
            <span class="st" :class="s.task_status">{{ collectStatus[s.task_status] || s.task_status }}</span>
            <b class="s-name">{{ s.name }}</b>
            <span class="typ">{{ sourceTypes[s.type] || s.type }}</span>
            <span v-if="s.running" class="pulse" title="调度器按间隔自动采集">● 采集中</span>
          </div>
          <div class="s-meta">
            <span>地址 <i>{{ s.endpoint }}</i></span>
            <span>入库渠道 <i>{{ s.channel_name || '#'+s.source_id }}</i></span>
            <span>游标 <i>#{{ s.cursor }}</i></span>
            <span>间隔 <i>{{ s.interval_sec }}s</i></span>
            <span>单次 <i>{{ s.batch_size }} 条</i></span>
          </div>
          <div class="s-meta">
            <span>累计运行 <i>{{ s.total_runs }}</i> 轮</span>
            <span>入库 <i>{{ s.total_inserted }}</i></span>
            <span>去重 <i>{{ s.total_duplicated }}</i></span>
            <span v-if="s.fail_count">连续失败 <i class="bad">{{ s.fail_count }}/{{ s.max_retry }}</i></span>
            <span v-if="s.last_run_at">最近采集 <i>{{ s.last_run_at }}</i></span>
          </div>
          <div v-if="s.last_error" class="s-err">⚠ {{ s.last_error }}</div>
          <div class="s-acts" v-if="canOps">
            <button v-if="!s.running" class="op start" :disabled="!s.enabled" @click="start(s)">▶ 启动</button>
            <button v-else class="op stop" @click="stop(s)">⏸ 停止</button>
            <button class="op run" :disabled="!s.enabled" @click="runNow(s)">⚡ 立即采集</button>
          </div>
        </div>
      </div>
      <p class="hint">💡 采集到的舆情经统一管线进入闭环：情感分析 → 预警触发 → 红/橙级危机建档/归并 → 通知编排。游标落库，重启续采不丢不重；重复条目按幂等键去重，绝不重复触发预警。地址含 <code>flaky</code> 首次采集模拟瞬时故障（验证自动重试），含 <code>always-fail</code> 持续失败（验证达上限自动停止）。</p>
    </template>

    <!-- ============ 数据源连接 ============ -->
    <template v-else-if="sub==='config'">
      <div class="card">
        <h4>🛰️ 数据源连接 <span class="ro" v-if="!isAdmin">（只读，需管理员权限）</span></h4>
        <form v-if="isAdmin" class="cfg-form" @submit.prevent="save">
          <div class="row">
            <input v-model="form.name" placeholder="数据源名称，如 微博热搜 API" required />
            <select v-model="form.type">
              <option v-for="(txt,k) in sourceTypes" :key="k" :value="k">{{ txt }}</option>
            </select>
          </div>
          <input v-model="form.endpoint" placeholder="连接地址（mock:// 模拟源；含 flaky 首发失败、always-fail 持续失败，用于演练）" required />
          <div class="row">
            <select v-model="form.source_id">
              <option v-for="c in channels" :key="c.id" :value="c.id">入库渠道：{{ c.name }}</option>
            </select>
            <input v-model="form.topic" placeholder="默认话题（留空=取条目话题）" />
            <input v-model="form.media" placeholder="默认来源媒体" />
          </div>
          <div class="row nums">
            <label>间隔(秒)<input v-model.number="form.interval_sec" type="number" min="5" required /></label>
            <label>单次抓取<input v-model.number="form.batch_size" type="number" min="1" max="50" required /></label>
            <label>失败上限<input v-model.number="form.max_retry" type="number" min="1" max="10" required /></label>
          </div>
          <div class="row">
            <button class="save" type="submit">{{ editingId ? '保存修改' : '保存连接' }}</button>
            <button v-if="editingId" type="button" class="ghost" @click="cancelEdit">取消编辑</button>
          </div>
          <p class="hint">💡 连接保存后默认「已停止」，需值班员在「采集任务」中启动；停用连接会同时停止其采集任务；「游标归零」可重新采集历史条目（已入库舆情按幂等键自动去重）。</p>
        </form>
        <div class="cfglist">
          <div v-for="s in sources" :key="s.id" class="cfg" :class="{off:!s.enabled}">
            <div class="c-body">
              <b>{{ s.name }}</b>
              <small>{{ sourceTypes[s.type] || s.type }} · {{ s.endpoint }} · 入库「{{ s.channel_name || '#'+s.source_id }}」 · 游标 #{{ s.cursor }} · {{ s.interval_sec }}s×{{ s.batch_size }}条</small>
            </div>
            <template v-if="isAdmin">
              <button class="edit" @click="startEdit(s)">{{ editingId===s.id ? '收起' : '编辑' }}</button>
              <button class="edit" title="游标归零重新采集（已入库条目按幂等键去重）" @click="resetCur(s)">游标归零</button>
              <label class="switch">
                <input type="checkbox" :checked="!!s.enabled" @change="run(()=>store.toggleCollectSource(s.id))" />
                <span></span>
              </label>
              <button class="del" @click="del(s)">删除</button>
            </template>
            <span v-else class="ro-tag">{{ s.enabled ? '启用' : '停用' }}</span>
          </div>
        </div>
      </div>
    </template>

    <!-- ============ 采集记录 ============ -->
    <template v-else>
      <div class="card">
        <h4>📜 采集记录 <button class="link" @click="loadRuns">刷新</button></h4>
        <div v-if="!runs.length" class="none">暂无采集记录（启动采集任务或手动「立即采集」后产生）</div>
        <div v-for="r in runs" :key="r.id" class="run" :class="r.status">
          <span class="rst" :class="r.status">{{ r.status==='success' ? '成功' : '失败' }}</span>
          <div class="r-body">
            <b>{{ r.source_name || '#'+r.source_id }}</b>
            <span v-if="r.status==='success'">
              抓取 {{ r.fetched }} 条 · 入库 {{ r.inserted }} · 去重 {{ r.duplicated }}
              <template v-if="r.alerts"> · <em class="hl">触发预警 {{ r.alerts }} 次</em></template>
              <template v-if="r.crises"> · <em class="hl">建档危机 {{ r.crises }}</em></template>
              · 游标 #{{ r.cursor_from || '0' }} → #{{ r.cursor_to }}
            </span>
            <span v-else class="errtext">⚠ {{ r.error }}</span>
          </div>
          <em class="r-time">{{ r.operator }}<br />{{ r.finished }}</em>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { usePubStore } from '@/store/pub'

const store = usePubStore()
const sub = ref('tasks')
const subtabs = [
  { key: 'tasks', icon: '📡', label: '采集任务' },
  { key: 'config', icon: '⚙️', label: '数据源连接' },
  { key: 'runs', icon: '📜', label: '采集记录' }
]

const sources = ref([])
const runs = ref([])
const counts = ref({})
const totals = ref({})
const sourceTypes = ref({})
const collectStatus = ref({})
const channels = ref([])
const editingId = ref(null)
const blank = () => ({ name: '', type: 'api', endpoint: '', source_id: channels.value[0]?.id || 1, topic: '', media: '', interval_sec: 15, batch_size: 5, max_retry: 5 })
const form = ref(blank())

const isAdmin = computed(() => store.user.role === 'admin')
const canOps = computed(() => ['admin', 'ops'].includes(store.user.role))
function roleText(r) { return { admin: '管理员', ops: '值班员', viewer: '观察员' }[r] || r }

async function loadOverview() {
  const d = await store.fetchCollectOverview()
  sources.value = d.sources
  counts.value = d.counts
  totals.value = d.totals
  sourceTypes.value = d.sourceTypes
  collectStatus.value = d.collectStatus
  channels.value = d.channels
  runs.value = d.runs
}
async function loadRuns() { runs.value = await store.fetchCollectRuns() }
async function run(fn) {
  try { await fn(); await loadOverview() }
  catch (e) { store.msg(e.message, 'warn') }
}

async function save() {
  const payload = { ...form.value }
  if (editingId.value) await run(() => store.updateCollectSource(editingId.value, payload))
  else await run(() => store.saveCollectSource(payload))
  cancelEdit()
}
function startEdit(s) {
  if (editingId.value === s.id) return cancelEdit()
  editingId.value = s.id
  form.value = {
    name: s.name, type: s.type, endpoint: s.endpoint, source_id: s.source_id,
    topic: s.topic, media: s.media, interval_sec: s.interval_sec,
    batch_size: s.batch_size, max_retry: s.max_retry
  }
}
function cancelEdit() { editingId.value = null; form.value = blank() }
async function del(s) {
  if (!confirm(`删除数据源「${s.name}」？其采集记录将保留。`)) return
  await run(() => store.delCollectSource(s.id))
}
async function resetCur(s) {
  if (!confirm(`将「${s.name}」的采集游标归零？\n重新采集历史条目时，已入库舆情按幂等键自动去重，不会重复触发预警。`)) return
  try {
    await store.collectTaskOp(s.id, 'reset-cursor')
    store.msg(`「${s.name}」游标已归零，重新采集将演示幂等去重`, 'success')
    await loadOverview()
  } catch (e) { store.msg(e.message, 'warn') }
}

async function start(s) {
  try {
    const r = await store.collectTaskOp(s.id, 'start')
    store.msg(r.already ? `「${s.name}」已在运行中` : `「${s.name}」采集任务已启动，调度器即刻开采`, r.already ? 'info' : 'success')
    await loadOverview()
  } catch (e) { store.msg(e.message, 'warn') }
}
async function stop(s) {
  try {
    const r = await store.collectTaskOp(s.id, 'stop')
    store.msg(r.already ? `「${s.name}」本就处于停止状态` : `「${s.name}」采集任务已停止（游标保留，可随时续采）`, r.already ? 'info' : 'success')
    await loadOverview()
  } catch (e) { store.msg(e.message, 'warn') }
}
async function runNow(s) {
  try {
    const r = await store.collectTaskOp(s.id, 'run')
    const res = r.result
    if (res && res.ok) {
      store.msg(`「${s.name}」采集完成：新增 ${res.inserted} 条` +
        (res.duplicated ? `（幂等去重 ${res.duplicated} 条）` : '') +
        (res.alerts ? `，触发预警 ${res.alerts} 次` : ''), res.alerts ? 'warn' : 'success')
    } else if (res) {
      store.msg(`「${s.name}」采集失败：${res.error}${res.giveUp ? '（任务已自动停止）' : '，将按退避自动重试'}`, 'warn')
    }
    await loadOverview()
  } catch (e) { store.msg(e.message, 'warn') }
}

let timer = null
onMounted(async () => {
  await loadOverview()
  timer = setInterval(() => { loadOverview().catch(() => {}) }, 3000)
})
onUnmounted(() => clearInterval(timer))
</script>

<style scoped>
.collect{display:flex;flex-direction:column;gap:12px;}
.ctoolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
.subtabs{display:flex;gap:6px;flex-wrap:wrap;}
.subtabs button{background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#aebadd;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:13px;position:relative;font-family:inherit;}
.subtabs button.active{background:linear-gradient(135deg,#00897b,#2962ff);color:#fff;border-color:transparent;}
.bd{position:absolute;top:-4px;right:-4px;background:#ef5350;color:#fff;font-size:9px;border-radius:8px;padding:1px 5px;font-weight:700;}
.me{margin-left:auto;font-size:11px;color:#8ba2c8;background:#13233f;border:1px solid rgba(120,160,220,0.2);border-radius:8px;padding:6px 12px;}
.sum{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;}
@media(max-width:800px){.sum{grid-template-columns:repeat(2,1fr);}}
.scard{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:10px;padding:10px 14px;text-align:center;}
.scard b{display:block;color:#fff;font-size:20px;}
.scard span{font-size:11px;color:#8ba2c8;}
.srclist{display:flex;flex-direction:column;gap:10px;}
.src{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-left:4px solid #546e7a;border-radius:10px;padding:12px 14px;}
.src.running{border-left-color:#66bb6a;}
.src.retrying{border-left-color:#ffb300;}
.src.failed{border-left-color:#ef5350;}
.src.disabled{opacity:.6;}
.s-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.st{font-size:10px;padding:2px 9px;border-radius:6px;flex:none;}
.st.running{background:#1b5e20;color:#a5d6a7;}
.st.retrying{background:#3e2723;color:#ffcc80;}
.st.stopped{background:#263238;color:#b0bec5;}
.st.failed{background:#4a1518;color:#ef9a9a;}
.st.disabled{background:#21262c;color:#78909c;}
.s-name{color:#fff;font-size:13px;}
.typ{font-size:10px;color:#90caf9;background:#0d2137;border-radius:5px;padding:2px 8px;}
.pulse{font-size:10px;color:#66bb6a;animation:pl 1.6s ease-in-out infinite;}
@keyframes pl{0%,100%{opacity:1;}50%{opacity:.35;}}
.s-meta{display:flex;gap:14px;flex-wrap:wrap;font-size:10px;color:#5b6f94;margin-top:6px;}
.s-meta i{color:#90caf9;font-style:normal;}
.s-meta i.bad{color:#ef9a9a;font-weight:700;}
.s-err{margin-top:6px;font-size:10px;color:#ef9a9a;background:#2c1418;border-radius:6px;padding:4px 8px;}
.s-acts{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;}
.op{background:none;border:1px solid rgba(144,202,249,.4);color:#90caf9;cursor:pointer;border-radius:7px;padding:4px 10px;font-size:11px;font-family:inherit;}
.op:disabled{opacity:.4;cursor:not-allowed;}
.op.start{border-color:rgba(102,187,106,.5);color:#81c784;}
.op.stop{border-color:rgba(255,213,79,.45);color:#ffe082;}
.op.run{border-color:rgba(3,169,244,.5);color:#4fc3f7;}
.hint{margin:0;font-size:10px;color:#5b6f94;line-height:1.6;}
.hint code{background:#0c1730;padding:1px 5px;border-radius:4px;color:#90caf9;}
.card{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px;}
h4{margin:0 0 12px;color:#fff;font-size:14px;display:flex;align-items:center;justify-content:space-between;}
.ro{font-size:10px;color:#5b6f94;font-weight:400;}
.cfg-form{display:flex;flex-direction:column;gap:8px;background:#13233f;border-radius:10px;padding:12px;margin-bottom:10px;}
input,select,button{font-family:inherit;background:#0f1b38;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:8px 10px;font-size:12px;}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
.row select,.row input{flex:1;min-width:100px;}
.nums label{display:flex;align-items:center;gap:6px;font-size:11px;color:#8ba2c8;flex:1;}
.nums input{flex:1;min-width:60px;}
.save{background:#2962ff;border:none;color:#fff;font-weight:600;cursor:pointer;flex:0 1 auto;padding:8px 18px;}
.ghost{background:#16263f;color:#8ba2c8;cursor:pointer;flex:0 1 auto;}
.cfglist{display:flex;flex-direction:column;gap:8px;}
.cfg{display:flex;align-items:center;gap:10px;background:#16263f;border-radius:8px;padding:9px 12px;flex-wrap:wrap;}
.cfg.off{opacity:.55;}
.c-body{flex:1;min-width:200px;}
.c-body b{color:#dbe4f3;font-size:12px;display:block;}
.c-body small{color:#5b6f94;font-size:10px;word-break:break-all;}
.edit{background:none;border:1px solid rgba(144,202,249,.4);color:#90caf9;cursor:pointer;border-radius:7px;padding:4px 9px;font-size:11px;}
.del{background:none;border:1px solid rgba(239,83,80,.4);color:#ef5350;cursor:pointer;border-radius:7px;padding:4px 9px;font-size:11px;}
.ro-tag{font-size:10px;color:#5b6f94;}
.switch{position:relative;width:36px;height:20px;display:inline-block;}
.switch input{opacity:0;width:0;height:0;}
.switch span{position:absolute;inset:0;background:#243357;border-radius:20px;transition:.2s;cursor:pointer;}
.switch span:before{content:'';position:absolute;width:16px;height:16px;left:2px;top:2px;background:#7b8db3;border-radius:50%;transition:.2s;}
.switch input:checked+span{background:#2962ff;}
.switch input:checked+span:before{transform:translateX(16px);background:#fff;}
.run{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px dashed rgba(120,160,220,0.1);}
.run:last-child{border-bottom:none;}
.rst{flex:none;font-size:9px;padding:1px 7px;border-radius:5px;margin-top:2px;}
.rst.success{background:#1b5e20;color:#a5d6a7;}
.rst.failed{background:#4a1518;color:#ef9a9a;}
.r-body{flex:1;min-width:0;}
.r-body b{color:#dbe4f3;font-size:11px;display:block;}
.r-body span{color:#8ba2c8;font-size:10px;}
.r-body .hl{color:#ffb300;font-style:normal;}
.r-body .errtext{color:#ef9a9a;}
.r-time{color:#5b6f94;font-size:10px;font-style:normal;text-align:right;white-space:nowrap;}
.link{background:none;border:none;color:#90caf9;cursor:pointer;padding:2px 6px;font-size:11px;}
.none{color:#5b6f94;text-align:center;padding:24px;}
</style>
