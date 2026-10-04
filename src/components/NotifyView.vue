<template>
  <div class="notify">
    <div class="ntoolbar">
      <div class="subtabs">
        <button v-for="t in subtabs" :key="t.key" :class="{active:sub===t.key}" @click="sub=t.key">
          {{ t.icon }} {{ t.label }}
          <span v-if="t.key==='tasks' && openCount" class="bd">{{ openCount }}</span>
        </button>
      </div>
      <span class="me">👤 {{ store.user.name }} · {{ roleText(store.user.role) }}</span>
    </div>

    <!-- ============ 任务看板 ============ -->
    <template v-if="sub==='tasks'">
      <div class="counts">
        <button class="chip" :class="{on:!filter}" @click="setFilter('')">全部 {{ totalCount }}</button>
        <button v-for="(txt,k) in taskStatus" :key="k" class="chip" :class="[k,{on:filter===k}]" @click="setFilter(k)">
          {{ txt }} {{ counts[k]||0 }}
        </button>
      </div>
      <div v-if="!tasks.length" class="none">暂无通知任务（触发预警或危机状态流转后按订阅自动生成）</div>
      <div class="tasks">
        <div v-for="t in tasks" :key="t.id" class="task" :class="t.status">
          <div class="t-head">
            <span class="st" :class="t.status">{{ t.statusText }}</span>
            <b class="t-title">{{ t.title }}</b>
            <span class="kind">{{ kindText(t) }}</span>
            <span v-if="t.corr_id" class="corr" :title="'调度链路：' + t.corr_id + '（第 ' + t.seq + ' 轮）'">🔗 {{ corrShort(t.corr_id) }}<template v-if="t.seq">#{{ t.seq }}</template></span>
            <span v-if="t.escalated_from" class="esc-tag">⬆ 升级自 #{{ t.escalated_from }}</span>
          </div>
          <div class="t-content">{{ t.content }}</div>
          <div class="t-meta">
            <span>渠道 <i>{{ t.channel_name || '#'+t.channel_id }}</i></span>
            <span>订阅 <i>{{ t.sub_name || '—' }}</i></span>
            <span>尝试 <i>{{ t.attempts }}/{{ t.max_attempts }}</i></span>
            <span v-if="t.require_ack">回执 <i>{{ t.ack_by ? `${t.ack_by} · ${t.ack_at}` : '待确认' }}</i></span>
            <span v-if="t.crisis_id">危机 <i>#{{ t.crisis_id }}</i></span>
            <span v-if="t.work_order_id">工单 <i>#{{ t.work_order_id }}</i></span>
            <span v-if="t.prop_path_id">传播路径 <i>#{{ t.prop_path_id }}</i></span>
            <span v-if="t.ext_submission_id">外部协作 <i>#{{ t.ext_submission_id }}</i></span>
            <span>更新 <i>{{ t.updated }}</i></span>
          </div>
          <div v-if="t.last_error" class="t-err">⚠ {{ t.last_error }}</div>
          <div v-if="t.ack_note" class="t-ack">💬 回执备注：{{ t.ack_note }}</div>
          <div class="t-actions" v-if="canOps">
            <button v-if="['pending','failed'].includes(t.status)" class="op" @click="op(t,'pause')">⏸ 暂停</button>
            <button v-if="t.status==='paused'" class="op" @click="op(t,'resume')">▶ 恢复</button>
            <button v-if="t.status==='failed'" class="op retry" @click="op(t,'retry')">↻ 重试</button>
            <button v-if="t.require_ack && ['sent','escalated'].includes(t.status)" class="op ack" @click="ack(t)">✔ 确认回执</button>
            <button v-if="['pending','failed','paused'].includes(t.status)" class="op cancel" @click="op(t,'cancel')">✕ 取消</button>
          </div>
          <button class="logbtn" @click="toggleLogs(t)">{{ logId===t.id ? '收起日志' : '📜 日志' }}</button>
          <div v-if="logId===t.id" class="t-logs">
            <div v-for="l in taskLogs" :key="l.id" class="tlog">
              <span class="lg-act" :class="l.action">{{ logActionText(l.action) }}</span>
              <span class="lg-detail">{{ l.detail }}</span>
              <em>{{ l.operator }} · {{ l.time }}</em>
            </div>
            <div v-if="!taskLogs.length" class="none">暂无日志</div>
          </div>
        </div>
      </div>
    </template>

    <!-- ============ 订阅与渠道 ============ -->
    <template v-else-if="sub==='config'">
      <div class="cfg-grid">
        <!-- 渠道配置 -->
        <div class="card">
          <h4>📡 通知渠道 <span class="ro" v-if="!isAdmin">（只读，需管理员权限）</span></h4>
          <form v-if="isAdmin" class="ch-form" @submit.prevent="addChannel">
            <div class="row">
              <input v-model="chForm.name" placeholder="渠道名称，如 值班群 Webhook" required />
              <select v-model="chForm.type">
                <option v-for="(txt,k) in channelTypes" :key="k" :value="k">{{ txt }}</option>
              </select>
            </div>
            <input v-model="chForm.target" placeholder="推送地址（含 flaky 首发失败、always-fail 持续失败，用于演练）" required />
            <button class="save" type="submit">保存渠道</button>
          </form>
          <div class="ch-list">
            <div v-for="c in channels" :key="c.id" class="ch" :class="{off:!c.enabled}">
              <span class="ch-type">{{ channelTypes[c.type] || c.type }}</span>
              <div class="ch-body">
                <b>{{ c.name }}</b>
                <small>{{ c.target }}</small>
              </div>
              <template v-if="isAdmin">
                <label class="switch">
                  <input type="checkbox" :checked="!!c.enabled" @change="run(()=>store.toggleChannel(c.id))" />
                  <span></span>
                </label>
                <button class="del" @click="delChannel(c)">删除</button>
              </template>
              <span v-else class="ro-tag">{{ c.enabled ? '启用' : '停用' }}</span>
            </div>
          </div>
        </div>

        <!-- 订阅编排 -->
        <div class="card">
          <h4>🔔 订阅编排 <span class="ro" v-if="!isAdmin">（只读，需管理员权限）</span></h4>
          <form v-if="isAdmin" class="sub-form" @submit.prevent="addSub">
            <input v-model="subForm.name" placeholder="订阅名称，如 红色预警全员通知" required />
            <div class="row">
              <select v-model="subForm.mode">
                <option value="alert">🚨 预警触发</option>
                <option value="crisis">🛟 危机状态流转</option>
                <option value="wo">📋 协同工单事件</option>
                <option value="prop">🕸 传播路径事件</option>
                <option value="ext">🤝 外部协作门户</option>
                <option value="stmt">📢 危机声明渠道</option>
              </select>
              <select v-if="subForm.mode==='alert'" v-model="subForm.alert_id">
                <option :value="null">全部规则</option>
                <option v-for="a in alertRules" :key="a.id" :value="a.id">{{ a.title }}</option>
              </select>
              <select v-else-if="subForm.mode==='crisis'" v-model="subForm.crisis_status">
                <option value="monitoring">监测中（建档）</option>
                <option value="disposal">处置中</option>
                <option value="closed">已结案</option>
              </select>
              <select v-else-if="subForm.mode==='wo'" v-model="subForm.wo_event">
                <option value="created">拆分/分派（含改派、认领提醒）</option>
                <option value="escalated">超时升级（两级升级均触发）</option>
              </select>
              <select v-else-if="subForm.mode==='ext'" v-model="subForm.ext_event">
                <option value="submitted">外部提交到达（证据/整改进度）</option>
                <option value="escalated">紧急提交升级（监管督办等）</option>
              </select>
              <select v-else-if="subForm.mode==='stmt'" v-model="subForm.stmt_event">
                <option value="chfail">单渠道发布失败（即时提醒）</option>
                <option value="partial">部分渠道失败·发布未完成（督办，建议需回执）</option>
              </select>
              <select v-else v-model="subForm.prop_event">
                <option value="outbreak">进入爆发期（爆发升级）</option>
                <option value="surge">传播异动（热度激增 / KOL 加入）</option>
              </select>
            </div>
            <div class="row">
              <input v-if="!['wo','ext','stmt'].includes(subForm.mode)" v-model="subForm.topic" list="topic-list" placeholder="限定话题（留空=不限）" />
              <datalist id="topic-list"><option v-for="t in topics" :key="t" :value="t" /></datalist>
              <div v-if="subForm.mode==='alert'" class="lv-checks">
                <label v-for="l in levels" :key="l.k"><input type="checkbox" v-model="subForm.levels" :value="l.k" /> {{ l.t }}</label>
              </div>
            </div>
            <div class="ch-checks">
              <span>推送渠道：</span>
              <label v-for="c in channels" :key="c.id" :class="{off:!c.enabled}">
                <input type="checkbox" v-model="subForm.channel_ids" :value="c.id" /> {{ c.name }}
              </label>
            </div>
            <div class="row ack-row">
              <label class="ack-check"><input type="checkbox" v-model="subForm.require_ack" /> 需要确认回执</label>
              <template v-if="subForm.require_ack">
                <input v-model.number="subForm.ack_timeout_min" type="number" min="1" placeholder="超时(分)" />
                <select v-model="subForm.escalate_channel_id">
                  <option :value="null">升级渠道=原渠道</option>
                  <option v-for="c in channels" :key="c.id" :value="c.id">升级→{{ c.name }}</option>
                </select>
              </template>
              <input v-model.number="subForm.max_retry" type="number" min="1" max="5" placeholder="重试上限" />
            </div>
            <button class="save" type="submit">保存订阅</button>
            <p class="hint">💡 预警订阅按「规则 + 话题 + 级别」匹配；危机订阅按状态流转；工单订阅按拆分分派/超时升级匹配。需回执的任务超时未确认将自动升级；回执会同步解除关联预警并写入危机时间线。</p>
          </form>
          <div class="sub-list">
            <div v-for="s in subs" :key="s.id" class="sub" :class="{off:!s.active}">
              <div class="s-head">
                <b>{{ s.name }}</b>
                <span class="s-kind">{{ s.stmt_event ? '📢 声明·'+(s.stmt_event==='partial'?'部分失败督办':'渠道失败提醒') : s.ext_event ? '🤝 外部协作·'+(s.ext_event==='escalated'?'紧急升级':'提交到达') : s.prop_event ? '🕸 传播·'+(s.prop_event==='outbreak'?'爆发升级':'异动/激增/KOL') : s.wo_event ? '📋 工单·'+(s.wo_event==='escalated'?'超时升级':'拆分分派') : s.crisis_status ? '🛟 危机·'+crisisStatus[s.crisis_status] : '🚨 预警' }}</span>
              </div>
              <small>{{ subDesc(s) }}</small>
              <div class="s-chs">
                <span v-for="c in s.channel_list" :key="c.id" class="s-ch" :class="{off:!c.enabled}">{{ c.name }}</span>
                <span v-if="s.require_ack" class="s-ack">需回执 · {{ s.ack_timeout_min }}分钟超时升级</span>
                <span class="s-ack">重试≤{{ s.max_retry }}</span>
              </div>
              <div class="s-btns" v-if="isAdmin">
                <label class="switch">
                  <input type="checkbox" :checked="!!s.active" @change="run(()=>store.toggleSub(s.id))" />
                  <span></span>
                </label>
                <button class="del" @click="delSub(s)">删除</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ============ 发送历史 ============ -->
    <template v-else>
      <div class="logs card">
        <h4>📜 通知历史追踪</h4>
        <div v-if="!logs.length" class="none">暂无历史记录</div>
        <div v-for="l in logs" :key="l.id" class="log">
          <span class="lg-act" :class="l.action">{{ logActionText(l.action) }}</span>
          <div class="lg-body">
            <b>#{{ l.task_id }} {{ l.task_title || '' }}</b>
            <span>{{ l.detail }}</span>
          </div>
          <em>{{ l.operator }}<br />{{ l.time }}</em>
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
  { key: 'tasks', icon: '📮', label: '任务看板' },
  { key: 'config', icon: '⚙️', label: '订阅与渠道' },
  { key: 'logs', icon: '📜', label: '发送历史' }
]

const channels = ref([])
const subs = ref([])
const counts = ref({})
const tasks = ref([])
const logs = ref([])
const filter = ref('')
const taskStatus = ref({})
const channelTypes = ref({})
const crisisStatus = ref({})
const alertRules = ref([])
const topics = ref([])
const logId = ref(null)
const taskLogs = ref([])

const levels = [{ k: 'red', t: '红' }, { k: 'orange', t: '橙' }, { k: 'yellow', t: '黄' }]
const chForm = ref({ name: '', type: 'webhook', target: '' })
const subForm = ref({
  name: '', mode: 'alert', alert_id: null, crisis_status: 'closed', wo_event: 'created', prop_event: 'outbreak', ext_event: 'submitted', stmt_event: 'chfail', topic: '',
  levels: [], channel_ids: [], require_ack: false, ack_timeout_min: 30, escalate_channel_id: null, max_retry: 3
})

const isAdmin = computed(() => store.user.role === 'admin')
const canOps = computed(() => ['admin', 'ops'].includes(store.user.role))
const isViewer = computed(() => store.user.role === 'viewer')
const openCount = computed(() => (counts.value.pending || 0) + (counts.value.failed || 0))
const totalCount = computed(() => Object.values(counts.value).reduce((a, b) => a + b, 0))

function roleText(r) { return { admin: '管理员', ops: '值班员', viewer: '观察员' }[r] || r }
function kindText(t) {
  if (t.kind === 'workorder') return '📋 工单'
  if (t.kind === 'prop') return '🕸 传播'
  if (t.kind === 'ext') return '🤝 外部协作'
  if (t.kind === 'statement') return '📢 声明'
  if (t.kind === 'alert') return '🚨 预警'
  return '🛟 危机'
}
// 调度链路关联键简写：wo3:dispatch → 工单#3 分派；stmt3:partial → 声明#3 部分失败
function corrShort(c) {
  let m = String(c).match(/^wo(\d+):(\w+)/)
  if (m) {
    const phase = { dispatch: '分派', escalate: '升级', ackEsc: '回执升级' }[m[2]] || m[2]
    return `工单#${m[1]}·${phase}`
  }
  m = String(c).match(/^stmt(\d+):(\w+)/)
  if (m) {
    const phase = { partial: '部分失败督办', channels: '渠道失败', ackEsc: '回执升级' }[m[2]] || m[2]
    return `声明#${m[1]}·${phase}`
  }
  return c.length > 14 ? c.slice(0, 14) + '…' : c
}
function logActionText(a) {
  return {
    created: '生成', sent: '发送成功', retry: '待重试', failed: '发送失败',
    paused: '暂停', resumed: '恢复', acked: '确认回执', escalated: '升级', cancelled: '取消'
  }[a] || a
}
function subDesc(s) {
  if (s.ext_event) return `外部协作方${s.ext_event === 'escalated' ? '紧急提交（升级督办）' : '提交证据/整改进度'}时通知${s.topic ? ` · 话题「${s.topic}」` : ''}`
  if (s.stmt_event) return `危机声明${s.stmt_event === 'partial' ? '全部渠道登记完但存在失败（发布未完成、阻塞结案）' : '单个渠道发布失败'}时通知${s.topic ? ` · 话题「${s.topic}」` : ''}`
  if (s.prop_event) return `传播路径${s.prop_event === 'outbreak' ? '进入爆发期（爆发升级）' : '热度激增 / KOL 加入'}时通知${s.topic ? ` · 话题「${s.topic}」` : ''}`
  if (s.wo_event) return `协同工单${s.wo_event === 'escalated' ? '超时升级（两级）' : '拆分/分派'}时通知${s.topic ? ` · 话题「${s.topic}」` : ''}`
  if (s.crisis_status) return `危机进入「${crisisStatus.value[s.crisis_status] || s.crisis_status}」时通知${s.topic ? ` · 话题「${s.topic}」` : ''}`
  const parts = []
  if (s.alert_id) { const a = alertRules.value.find((x) => x.id === s.alert_id); parts.push(`规则「${a ? a.title : '#'+s.alert_id}」`) }
  else parts.push('全部规则')
  if (s.topic) parts.push(`话题「${s.topic}」`)
  if (s.level_list && s.level_list.length) parts.push(`级别 ${s.level_list.map((x) => ({ red: '红', orange: '橙', yellow: '黄' }[x] || x)).join('/')}`)
  return parts.join(' · ')
}

async function run(fn) {
  try { await fn(); await loadOverview() }
  catch (e) { store.msg(e.message, 'warn') }
}
async function loadOverview() {
  const d = await store.fetchNotifyOverview()
  channels.value = d.channels
  subs.value = d.subs
  counts.value = d.counts
  taskStatus.value = d.taskStatus
  channelTypes.value = d.channelTypes
  crisisStatus.value = d.crisisStatus
}
async function loadTasks() {
  const d = await store.fetchNotifyTasks(filter.value)
  tasks.value = d.tasks
  counts.value = d.counts
}
async function loadLogs() { logs.value = await store.fetchNotifyLogs() }
function setFilter(k) { filter.value = k; loadTasks() }

async function op(t, action) {
  try {
    await store.notifyTaskOp(t.id, action)
    await Promise.all([loadTasks(), loadOverview()])
  } catch (e) { store.msg(e.message, 'warn') }
}
async function ack(t) {
  const note = prompt(`确认回执「${t.title}」？\n回执将同步解除关联预警并写入危机时间线。\n回执备注（可留空）：`)
  if (note == null) return
  try {
    await store.ackNotifyTask(t.id, note.trim())
    await Promise.all([loadTasks(), loadOverview()])
  } catch (e) { store.msg(e.message, 'warn') }
}
async function toggleLogs(t) {
  if (logId.value === t.id) { logId.value = null; taskLogs.value = []; return }
  const d = await store.fetchNotifyTask(t.id)
  taskLogs.value = d.logs
  logId.value = t.id
}
async function addChannel() {
  await run(() => store.saveChannel({ ...chForm.value }))
  chForm.value = { name: '', type: 'webhook', target: '' }
}
async function delChannel(c) {
  if (!confirm(`删除渠道「${c.name}」？引用它的订阅将不再向该渠道推送。`)) return
  await run(() => store.delChannel(c.id))
}
async function addSub() {
  const f = subForm.value
  if (!f.channel_ids.length) { store.msg('请至少选择一个推送渠道', 'warn'); return }
  await run(() => store.saveSub({
    name: f.name,
    alert_id: f.mode === 'alert' ? f.alert_id : null,
    topic: ['wo', 'ext', 'stmt'].includes(f.mode) ? '' : f.topic,
    crisis_status: f.mode === 'crisis' ? f.crisis_status : '',
    wo_event: f.mode === 'wo' ? f.wo_event : '',
    prop_event: f.mode === 'prop' ? f.prop_event : '',
    ext_event: f.mode === 'ext' ? f.ext_event : '',
    stmt_event: f.mode === 'stmt' ? f.stmt_event : '',
    levels: f.mode === 'alert' ? f.levels : [],
    channel_ids: f.channel_ids,
    require_ack: f.require_ack,
    ack_timeout_min: f.ack_timeout_min,
    escalate_channel_id: f.escalate_channel_id,
    max_retry: f.max_retry
  }))
  subForm.value = { name: '', mode: 'alert', alert_id: null, crisis_status: 'closed', wo_event: 'created', prop_event: 'outbreak', ext_event: 'submitted', stmt_event: 'chfail', topic: '', levels: [], channel_ids: [], require_ack: false, ack_timeout_min: 30, escalate_channel_id: null, max_retry: 3 }
}
async function delSub(s) {
  if (!confirm(`删除订阅「${s.name}」？已生成的任务不受影响。`)) return
  await run(() => store.delSub(s.id))
}

let timer = null
onMounted(async () => {
  await loadOverview()
  await Promise.all([loadTasks(), loadLogs()])
  store.fetchAlerts().then((d) => { alertRules.value = d.alerts }).catch(() => {})
  store.fetchTopics().then((t) => { topics.value = t }).catch(() => {})
  timer = setInterval(() => {
    loadTasks()
    if (sub.value === 'logs') loadLogs()
    if (logId.value) { const id = logId.value; store.fetchNotifyTask(id).then((d) => { if (logId.value === id) taskLogs.value = d.logs }).catch(() => {}) }
  }, 4000)
})
onUnmounted(() => clearInterval(timer))
</script>

<style scoped>
.notify{display:flex;flex-direction:column;gap:12px;}
.ntoolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
.subtabs{display:flex;gap:6px;flex-wrap:wrap;}
.subtabs button{background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#aebadd;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:13px;position:relative;font-family:inherit;}
.subtabs button.active{background:linear-gradient(135deg,#00897b,#2962ff);color:#fff;border-color:transparent;}
.bd{position:absolute;top:-4px;right:-4px;background:#ef5350;color:#fff;font-size:9px;border-radius:8px;padding:1px 5px;font-weight:700;}
.me{margin-left:auto;font-size:11px;color:#8ba2c8;background:#13233f;border:1px solid rgba(120,160,220,0.2);border-radius:8px;padding:6px 12px;}
.counts{display:flex;gap:6px;flex-wrap:wrap;}
.chip{background:#0f1b38;border:1px solid rgba(120,160,220,0.18);color:#8ba2c8;border-radius:14px;padding:4px 12px;font-size:11px;cursor:pointer;font-family:inherit;}
.chip.on{border-color:#2962ff;color:#fff;background:#132a52;}
.chip.failed.on{border-color:#ef5350;background:#3a1a24;}
.chip.escalated.on{border-color:#ff9800;background:#33230e;}
.tasks{display:flex;flex-direction:column;gap:10px;}
.task{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-left:4px solid #546e7a;border-radius:10px;padding:12px 14px;position:relative;}
.task.pending{border-left-color:#42a5f5;}
.task.sent{border-left-color:#66bb6a;}
.task.failed{border-left-color:#ef5350;}
.task.acked{border-left-color:#26a69a;}
.task.escalated{border-left-color:#ff9800;}
.task.paused{border-left-color:#90a4ae;opacity:.8;}
.task.cancelled{opacity:.5;}
.t-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.st{font-size:10px;padding:2px 9px;border-radius:6px;flex:none;}
.st.pending{background:#0d2137;color:#90caf9;}
.st.sent{background:#1b5e20;color:#a5d6a7;}
.st.failed{background:#4a1518;color:#ef9a9a;}
.st.acked{background:#004d40;color:#80cbc4;}
.st.escalated{background:#3e2723;color:#ffcc80;}
.st.paused{background:#263238;color:#b0bec5;}
.st.cancelled{background:#21262c;color:#78909c;}
.t-title{color:#fff;font-size:13px;flex:1;min-width:160px;}
.kind{font-size:10px;color:#8ba2c8;}
.corr{font-size:10px;color:#80cbc4;background:#0c2622;border:1px solid rgba(38,166,154,.3);border-radius:5px;padding:1px 7px;}
.esc-tag{font-size:10px;color:#ffcc80;background:#3e2723;border-radius:5px;padding:1px 6px;}
.t-content{color:#8ba2c8;font-size:11px;margin:6px 0;}
.t-meta{display:flex;gap:14px;flex-wrap:wrap;font-size:10px;color:#5b6f94;}
.t-meta i{color:#90caf9;font-style:normal;}
.t-err{margin-top:6px;font-size:10px;color:#ef9a9a;background:#2c1418;border-radius:6px;padding:4px 8px;}
.t-ack{margin-top:6px;font-size:10px;color:#80cbc4;background:#0c2622;border-radius:6px;padding:4px 8px;}
.t-actions{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;}
.op{background:none;border:1px solid rgba(144,202,249,.4);color:#90caf9;cursor:pointer;border-radius:7px;padding:4px 10px;font-size:11px;font-family:inherit;}
.op.retry{border-color:rgba(255,213,79,.45);color:#ffe082;}
.op.ack{border-color:rgba(102,187,106,.5);color:#81c784;}
.op.cancel{border-color:rgba(239,83,80,.4);color:#ef5350;}
.logbtn{position:absolute;top:12px;right:12px;background:none;border:1px solid rgba(120,160,220,0.25);color:#8ba2c8;border-radius:7px;padding:3px 9px;font-size:10px;cursor:pointer;font-family:inherit;}
.t-logs{margin-top:10px;border-top:1px dashed rgba(120,160,220,0.15);padding-top:8px;display:flex;flex-direction:column;gap:5px;max-height:180px;overflow-y:auto;}
.tlog{display:flex;align-items:baseline;gap:8px;font-size:10px;color:#8ba2c8;}
.tlog em{margin-left:auto;color:#5b6f94;font-style:normal;white-space:nowrap;}
.lg-act{flex:none;font-size:9px;padding:1px 7px;border-radius:5px;background:#16263f;color:#90caf9;border:1px solid rgba(144,202,249,.25);}
.lg-act.failed,.lg-act.escalated{color:#ffab91;border-color:rgba(255,138,101,.35);}
.lg-act.acked,.lg-act.sent{color:#81c784;border-color:rgba(102,187,106,.35);}
.lg-act.paused,.lg-act.cancelled{color:#b0bec5;border-color:rgba(176,190,197,.3);}
.cfg-grid{display:grid;grid-template-columns:1fr 1.4fr;gap:16px;}
@media(max-width:900px){.cfg-grid{grid-template-columns:1fr;}}
.card{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px;}
h4{margin:0 0 12px;color:#fff;font-size:14px;}
.ro{font-size:10px;color:#5b6f94;font-weight:400;}
.ch-form,.sub-form{display:flex;flex-direction:column;gap:8px;background:#13233f;border-radius:10px;padding:12px;margin-bottom:10px;}
input,select,button{font-family:inherit;background:#0f1b38;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:8px 10px;font-size:12px;}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
.row select,.row input{flex:1;min-width:100px;}
.save{background:#2962ff;border:none;color:#fff;font-weight:600;cursor:pointer;}
.hint{margin:0;font-size:10px;color:#5b6f94;line-height:1.5;}
.ch-list,.sub-list{display:flex;flex-direction:column;gap:8px;max-height:400px;overflow-y:auto;}
.ch{display:flex;align-items:center;gap:10px;background:#16263f;border-radius:8px;padding:9px 12px;}
.ch.off{opacity:.55;}
.ch-type{font-size:10px;background:#0d2137;color:#90caf9;border-radius:5px;padding:2px 8px;flex:none;}
.ch-body{flex:1;min-width:0;}
.ch-body b{color:#dbe4f3;font-size:12px;display:block;}
.ch-body small{color:#5b6f94;font-size:10px;word-break:break-all;}
.ro-tag{font-size:10px;color:#5b6f94;}
.sub{background:#16263f;border-radius:8px;padding:10px 12px;}
.sub.off{opacity:.55;}
.s-head{display:flex;align-items:center;justify-content:space-between;gap:8px;}
.s-head b{color:#dbe4f3;font-size:13px;}
.s-kind{font-size:10px;color:#90caf9;}
.sub small{color:#8ba2c8;font-size:10px;display:block;margin:4px 0;}
.s-chs{display:flex;gap:5px;flex-wrap:wrap;align-items:center;}
.s-ch{font-size:10px;background:#0d2137;color:#90caf9;border:1px solid rgba(144,202,249,.25);border-radius:5px;padding:1px 7px;}
.s-ch.off{opacity:.5;text-decoration:line-through;}
.s-ack{font-size:10px;color:#ffcc80;background:#3e2723;border-radius:5px;padding:1px 7px;}
.s-btns{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:6px;}
.switch{position:relative;width:36px;height:20px;display:inline-block;}
.switch input{opacity:0;width:0;height:0;}
.switch span{position:absolute;inset:0;background:#243357;border-radius:20px;transition:.2s;cursor:pointer;}
.switch span:before{content:'';position:absolute;width:16px;height:16px;left:2px;top:2px;background:#7b8db3;border-radius:50%;transition:.2s;}
.switch input:checked+span{background:#2962ff;}
.switch input:checked+span:before{transform:translateX(16px);background:#fff;}
.del{background:none;border:1px solid rgba(239,83,80,.4);color:#ef5350;cursor:pointer;border-radius:7px;padding:4px 9px;font-size:11px;}
.ch-checks{display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:#8ba2c8;align-items:center;}
.ch-checks label{display:flex;align-items:center;gap:4px;cursor:pointer;}
.ch-checks label.off{opacity:.5;}
.ch-checks input,.lv-checks input,.ack-check input{width:auto;}
.lv-checks{display:flex;gap:10px;font-size:11px;color:#8ba2c8;align-items:center;}
.lv-checks label{display:flex;align-items:center;gap:3px;cursor:pointer;}
.ack-row{font-size:11px;color:#8ba2c8;}
.ack-check{display:flex;align-items:center;gap:5px;cursor:pointer;}
.logs .log{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px dashed rgba(120,160,220,0.1);}
.logs .log:last-child{border-bottom:none;}
.lg-body{flex:1;min-width:0;}
.lg-body b{color:#dbe4f3;font-size:11px;display:block;}
.lg-body span{color:#8ba2c8;font-size:10px;}
.logs em{color:#5b6f94;font-size:10px;font-style:normal;text-align:right;white-space:nowrap;}
.none{color:#5b6f94;text-align:center;padding:24px;}
</style>
