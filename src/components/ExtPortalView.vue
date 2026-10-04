<template>
  <div class="ext">
    <div class="toolbar">
      <button v-if="isAdmin" class="add" @click="showPartners=!showPartners">🏛 协作方管理</button>
      <div class="chips">
        <button class="chip" :class="{on:!statusFilter}" @click="setStatus('')">全部 {{ summary.total || 0 }}</button>
        <button v-for="(txt,k) in dict.status" :key="k" class="chip" :class="[k,{on:statusFilter===k}]" @click="setStatus(k)">
          {{ txt }} {{ summary.counts?.[k] || 0 }}
        </button>
      </div>
      <span class="me">👤 {{ store.user.name }} · {{ roleText(store.user.role) }}</span>
    </div>
    <p class="hint">
      🔗 品牌方 / 监管方 / 媒体经<b>协作门户</b>提交证据与整改进度 → 值班员受理 → 管理员审核采纳：采纳后自动
      <b>回写协同工单日志</b>、可勾选<b>联动解除预警</b>并写入<b>危机统一时间线</b>（锚点可跳转）；紧急提交（如监管督办）提交即<b>联动通知升级</b>。
      <span v-if="summary.urgentOpen" class="urgent-tip">⚠ 当前 {{ summary.urgentOpen }} 条紧急提交待审核</span>
    </p>

    <!-- 协作方管理（admin） -->
    <div v-if="showPartners" class="partners card-box">
      <h4>🏛 外部协作方（凭口令在协作门户提交）</h4>
      <form v-if="isAdmin" class="p-form" @submit.prevent="savePartner">
        <input v-model="pForm.name" placeholder="机构/账号名称，如 XX 品牌管理有限公司" required />
        <select v-model="pForm.kind">
          <option value="brand">品牌方</option>
          <option value="regulator">监管方</option>
          <option value="media">媒体</option>
        </select>
        <input v-model="pForm.access_code" placeholder="门户口令（4-32 位字母数字-_)，如 BRAND-X1" required />
        <input v-model="pForm.contact" placeholder="联系人" />
        <input v-model="pForm.phone" placeholder="电话" />
        <input v-model="pForm.email" placeholder="邮箱" />
        <button class="save" type="submit">登记协作方</button>
      </form>
      <div class="p-list">
        <div v-for="p in partners" :key="p.id" class="p-row" :class="{off:!p.enabled}">
          <span class="p-kind" :class="p.kind">{{ kindText(p.kind) }}</span>
          <b>{{ p.name }}</b>
          <span class="p-contact">{{ p.contact || '—' }} · {{ p.phone || p.email || '未留联系方式' }}</span>
          <code class="p-code" :title="'点击复门口令'">🔑 {{ p.access_code }}</code>
          <span class="p-stat">提交 {{ p.sub_total }}（待审 {{ p.sub_open }}）</span>
          <button v-if="isAdmin" class="op toggle" @click="toggle(p)">{{ p.enabled ? '停用' : '启用' }}</button>
        </div>
      </div>
    </div>

    <div class="filters">
      <select v-model="kindFilter" @change="reload">
        <option value="">全部协作方类型</option>
        <option value="brand">品牌方</option>
        <option value="regulator">监管方</option>
        <option value="media">媒体</option>
      </select>
      <select v-model.number="crisisFilter" @change="reload">
        <option :value="null">全部危机事件</option>
        <option v-for="c in store.crises" :key="c.id" :value="c.id">#{{ c.id }} {{ c.title }}</option>
      </select>
      <button class="ghost sm" @click="reload">🔄 刷新</button>
    </div>

    <div v-if="!items.length" class="none">暂无外部协作提交（协作方将在「协作门户」页提交证据与整改进度）</div>

    <div class="list">
      <div v-for="s in items" :key="s.id" class="s-card" :class="[s.status,{urgent:s.is_urgent,hl:openId===s.id}]">
        <div class="s-head">
          <span class="code">{{ s.code }}</span>
          <span class="st" :class="s.status">{{ s.statusText }}</span>
          <span class="kind" :class="s.kind">{{ s.kindText }}</span>
          <span class="dt">{{ s.docTypeText }}</span>
          <span v-if="s.is_urgent" class="urgent">⚡ 紧急</span>
          <b class="s-title">{{ s.title }}</b>
          <span class="upd">{{ s.updated }}</span>
        </div>
        <div class="s-meta">
          <span>提交方 <i>{{ s.partner_name }}</i></span>
          <span v-if="s.crisis_id" class="crisis-link" @click="gotoCrisis(s)">🛟 危机 #{{ s.crisis_id }} {{ s.crisis_title }} →</span>
          <span v-else class="no-crisis">未关联危机（通用线索）</span>
          <span v-if="s.work_order_id" class="wo-link" @click="gotoWorkOrder(s)">📋 工单 #{{ s.work_order_id }} {{ s.wo_title }} →</span>
          <a v-if="s.source_url" :href="s.source_url" target="_blank" rel="noopener" class="src-url">🔗 来源链接</a>
          <span v-if="s.contact_info" class="contact">📞 {{ s.contact_info }}</span>
        </div>
        <pre class="content">{{ s.content }}</pre>
        <div v-if="s.attachments && s.attachments.length" class="atts">
          📎 <span v-for="(a,i) in s.attachments" :key="i" class="att" :title="fmtSize(a.size)">
            {{ a.name }}<i v-if="a.size">（{{ fmtSize(a.size) }}）</i>
          </span>
        </div>

        <!-- 驳回原因（外部方可见口径） -->
        <div v-if="s.status==='rejected'" class="reject-box">
          ↩ 驳回意见（{{ s.rejected_by }}）：{{ s.reject_reason }}——提交方可补充材料后重新提交
        </div>
        <!-- 采纳说明 -->
        <div v-if="s.status==='accepted'" class="accept-box">
          ✔ 已采纳（{{ s.accepted_by }} · {{ s.accepted_at }}）<template v-if="s.work_order_id"> · 已回写工单 #{{ s.work_order_id }}</template><template v-if="s.resolved_alert_count"> · 联动解除 {{ s.resolved_alert_count }} 条预警</template><template v-if="s.accepted_note"> · {{ s.accepted_note }}</template>
        </div>

        <div class="s-actions">
          <template v-if="canOps">
            <button v-if="['pending','rejected'].includes(s.status)" class="op receive" @click="receive(s)">📥 {{ s.status==='rejected' ? '重新受理' : '受理' }}</button>
            <button v-if="['pending','reviewing','rejected'].includes(s.status) && isAdmin" class="op accept" @click="openAccept(s)">✔ 审核采纳</button>
            <button v-if="['pending','reviewing','rejected'].includes(s.status) && isAdmin" class="op reject" @click="openReject(s)">↩ 驳回</button>
            <button v-if="!s.crisis_id && s.status!=='withdrawn'" class="op bind" @click="openBind(s)">🔗 挂接危机</button>
            <button v-if="s.crisis_id && ['pending','reviewing','rejected'].includes(s.status)" class="op bind" @click="openBind(s)">改挂危机</button>
          </template>
          <button class="op logbtn" @click="toggleLogs(s)">{{ openId===s.id ? '收起留痕' : '🧾 协作留痕' }}</button>
        </div>
        <div v-if="openId===s.id" class="s-logs">
          <div v-for="l in s.logs" :key="l.id" class="slog" :class="l.operator_side">
            <span class="sl-side">{{ sideText(l.operator_side) }}</span>
            <b>{{ l.action }}</b>
            <span>{{ l.detail }}</span>
            <em>{{ l.operator }} · {{ l.time }}</em>
          </div>
        </div>
      </div>
    </div>

    <!-- 采纳弹窗：关联工单 + 采纳说明 + 联动解除预警 -->
    <div v-if="acceptForm" class="modal-mask" @click.self="acceptForm=null">
      <div class="modal">
        <h4>✔ 审核采纳 · {{ acceptForm.code }}</h4>
        <p class="modal-hint">采纳后材料将回写危机统一时间线；可选择回写关联处置工单，并联动解除该危机下全部未解除预警。</p>
        <label>回写处置工单（可选，需属于同一危机且未完结）</label>
        <select v-model.number="acceptWorkOrderId">
          <option :value="null">不回写工单（仅入危机时间线）</option>
          <option v-for="w in acceptWorkOrders" :key="w.id" :value="w.id">
            #{{ w.id }} {{ w.title }}（{{ w.statusText }} · {{ w.assignee || '待分派' }}）
          </option>
        </select>
        <textarea v-model="acceptNote" placeholder="采纳说明（写入危机时间线，供处置团队参考）"></textarea>
        <label class="check"><input type="checkbox" v-model="acceptResolve" /> 联动解除该危机下全部未解除预警（解除途径：外部协作）</label>
        <div class="modal-ops">
          <button class="save" @click="confirmAccept">确认采纳</button>
          <button class="ghost" @click="acceptForm=null">取消</button>
        </div>
      </div>
    </div>

    <!-- 驳回弹窗 -->
    <div v-if="rejectForm" class="modal-mask" @click.self="rejectForm=null">
      <div class="modal">
        <h4>↩ 审核驳回 · {{ rejectForm.code }}</h4>
        <p class="modal-hint">驳回原因将展示在协作门户，提交方可补充材料后重新提交。</p>
        <textarea v-model="rejectReason" placeholder="驳回原因（必填）：证据不足 / 与事件无关 / 需补充正式材料…"></textarea>
        <div class="modal-ops">
          <button class="save danger" @click="confirmReject">确认驳回</button>
          <button class="ghost" @click="rejectForm=null">取消</button>
        </div>
      </div>
    </div>

    <!-- 挂接危机弹窗 -->
    <div v-if="bindForm" class="modal-mask" @click.self="bindForm=null">
      <div class="modal">
        <h4>🔗 挂接危机事件 · {{ bindForm.code }}</h4>
        <select v-model.number="bindCrisisId">
          <option :value="null">解除挂接（通用线索）</option>
          <option v-for="c in openCrises" :key="c.id" :value="c.id">#{{ c.id }} {{ c.title }}</option>
        </select>
        <div class="modal-ops">
          <button class="save" @click="confirmBind">保存</button>
          <button class="ghost" @click="bindForm=null">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { usePubStore } from '@/store/pub'

const store = usePubStore()
const items = ref([])
const summary = ref({ counts: {} })
const dict = ref({ status: {}, kind: {}, docType: {} })
const partners = ref([])
const statusFilter = ref('')
const kindFilter = ref('')
const crisisFilter = ref(store.extFilterCrisis)
const showPartners = ref(false)
const openId = ref(store.extOpenId)
const canOps = computed(() => ['admin', 'ops'].includes(store.user.role))
const isAdmin = computed(() => store.user.role === 'admin')
const openCrises = computed(() => store.crises.filter((c) => c.status !== 'closed'))

const pForm = ref({ name: '', kind: 'brand', access_code: '', contact: '', phone: '', email: '' })
const acceptForm = ref(null)
const acceptWorkOrders = ref([])
const acceptWorkOrderId = ref(null)
const acceptNote = ref('')
const acceptResolve = ref(false)
const rejectForm = ref(null)
const rejectReason = ref('')
const bindForm = ref(null)
const bindCrisisId = ref(null)

function roleText(r) { return { admin: '管理员', ops: '值班员', viewer: '观察员' }[r] || r }
function kindText(k) { return dict.value.kind[k] || k }
function sideText(s) { return { internal: '内部', external: '外部', system: '系统' }[s] || s }
function fmtSize(n) {
  if (!n) return ''
  if (n >= 1048576) return (n / 1048576).toFixed(1) + 'MB'
  return Math.max(1, Math.round(n / 1024)) + 'KB'
}

async function reload() {
  const d = await store.fetchExtSubmissions({
    status: statusFilter.value, kind: kindFilter.value,
    crisis_id: crisisFilter.value || ''
  })
  items.value = d.items
  summary.value = d.summary
  dict.value = d.dict
  // 从危机时间线锚点跳入时自动展开
  if (openId.value && !items.value.some((x) => x.id === openId.value)) {
    const full = await store.fetchExtSubmission(openId.value).catch(() => null)
    if (full) items.value.unshift(full)
  }
}
function setStatus(k) { statusFilter.value = k; reload() }

async function loadPartners() { partners.value = await store.fetchExtPartners() }
async function savePartner() {
  await store.createExtPartner({ ...pForm.value })
  pForm.value = { name: '', kind: 'brand', access_code: '', contact: '', phone: '', email: '' }
  loadPartners()
}
async function toggle(p) { await store.toggleExtPartner(p.id); loadPartners() }

async function receive(s) {
  await store.receiveExt(s.id)
  reload(); loadPartners()
}

async function openAccept(s) {
  acceptForm.value = s
  acceptNote.value = ''
  acceptResolve.value = false
  acceptWorkOrderId.value = null
  acceptWorkOrders.value = []
  if (s.crisis_id) {
    const d = await store.fetchWorkOrders({ crisis_id: s.crisis_id })
    acceptWorkOrders.value = d.items.filter((w) => ['todo', 'doing', 'blocked'].includes(w.status))
  }
}
async function confirmAccept() {
  await store.acceptExt(acceptForm.value.id, {
    work_order_id: acceptWorkOrderId.value,
    note: acceptNote.value,
    resolve_alerts: acceptResolve.value
  })
  acceptForm.value = null
  reload(); loadPartners()
}
function openReject(s) { rejectForm.value = s; rejectReason.value = '' }
async function confirmReject() {
  if (!rejectReason.value.trim()) { store.msg('请填写驳回原因', 'warn'); return }
  await store.rejectExt(rejectForm.value.id, rejectReason.value)
  rejectForm.value = null
  reload()
}
function openBind(s) { bindForm.value = s; bindCrisisId.value = s.crisis_id || null }
async function confirmBind() {
  await store.bindExtCrisis(bindForm.value.id, bindCrisisId.value)
  bindForm.value = null
  reload(); loadPartners()
}

async function toggleLogs(s) {
  if (openId.value === s.id) { openId.value = null; return }
  openId.value = s.id
  if (!s.logs) {
    const full = await store.fetchExtSubmission(s.id)
    const idx = items.value.findIndex((x) => x.id === s.id)
    if (idx >= 0) items.value[idx] = full
  }
}
function gotoCrisis(s) { store.tab = 'crisis' }
function gotoWorkOrder(s) { store.woFilterCrisis = s.crisis_id; store.tab = 'work' }

let timer = null
onMounted(async () => {
  try {
    await reload()
    await loadPartners()
  } catch (e) { store.msg(e.message, 'warn') }
  timer = setInterval(() => { if (document.visibilityState === 'visible') reload().catch(() => {}) }, 8000)
})
onUnmounted(() => { clearInterval(timer); store.extFilterCrisis = null; store.extOpenId = null })
</script>

<style scoped>
.ext{display:flex;flex-direction:column;gap:12px;}
.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
.add{background:linear-gradient(135deg,#8e24aa,#6a1b9a);color:#fff;border:none;padding:9px 16px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;}
.chips{display:flex;gap:6px;flex-wrap:wrap;}
.chip{background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#aebadd;padding:6px 12px;border-radius:14px;cursor:pointer;font-size:12px;}
.chip.on{background:#2c4a7c;color:#fff;border-color:#5b82c0;}
.chip.pending.on{background:#c62828;border-color:#ef5350;}
.chip.reviewing.on{background:#e65100;border-color:#fb8c00;}
.chip.accepted.on{background:#1b5e20;border-color:#43a047;}
.chip.rejected.on{background:#6a1b9a;border-color:#8e24aa;}
.me{margin-left:auto;font-size:12px;color:#8ba2c8;}
.hint{font-size:12px;color:#8ba2c8;line-height:1.7;margin:0;}
.urgent-tip{color:#ef9a9a;font-weight:700;margin-left:8px;}
.filters{display:flex;gap:8px;}
.filters select{background:#13233f;border:1px solid rgba(120,160,220,0.25);color:#dbe4f3;border-radius:7px;padding:7px 10px;font-size:12px;}
.ghost{background:transparent;border:1px solid rgba(120,160,220,0.35);color:#aebadd;border-radius:7px;padding:7px 12px;cursor:pointer;font-size:12px;}
.ghost.sm{padding:7px 14px;}
.card-box{background:#0f1d38;border:1px solid rgba(120,160,220,0.18);border-radius:12px;padding:14px;}
.card-box h4{margin:0 0 10px;font-size:14px;}
.p-form{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;}
.p-form input,.p-form select{background:#13233f;border:1px solid rgba(120,160,220,0.25);color:#dbe4f3;border-radius:7px;padding:8px 10px;font-size:12px;min-width:120px;}
.p-form input{flex:1;min-width:150px;}
.save{background:#2e7d32;color:#fff;border:none;border-radius:7px;padding:8px 16px;cursor:pointer;font-size:12px;font-weight:600;}
.save.danger{background:#c62828;}
.p-list{display:flex;flex-direction:column;gap:6px;}
.p-row{display:flex;align-items:center;gap:10px;background:#13233f;border-radius:8px;padding:8px 12px;font-size:12px;flex-wrap:wrap;}
.p-row.off{opacity:.55;}
.p-kind{padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;}
.p-kind.brand{background:#0d3a2c;color:#80cbc4;}
.p-kind.regulator{background:#3a1f0d;color:#ffb74d;}
.p-kind.media{background:#1f2a4a;color:#90caf9;}
.p-contact{color:#8ba2c8;}
.p-code{background:#0a1224;border:1px solid rgba(120,160,220,0.3);border-radius:5px;padding:2px 8px;color:#ffd54f;font-size:11px;}
.p-stat{color:#6f84ab;margin-left:auto;}
.op.toggle{background:transparent;border:1px solid rgba(239,83,80,.5);color:#ef9a9a;border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;}
.none{text-align:center;color:#6f84ab;padding:50px 0;}
.list{display:flex;flex-direction:column;gap:10px;}
.s-card{background:#0f1d38;border:1px solid rgba(120,160,220,0.15);border-radius:12px;padding:14px 16px;}
.s-card.urgent{border-color:rgba(239,83,80,.55);box-shadow:0 0 0 1px rgba(239,83,80,.25);}
.s-card.hl{outline:2px solid #ffb300;}
.s-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.code{font-family:monospace;background:#0a1224;border:1px solid rgba(120,160,220,0.3);border-radius:5px;padding:2px 8px;font-size:11px;color:#90caf9;}
.st{font-size:11px;padding:2px 9px;border-radius:10px;font-weight:700;}
.st.pending{background:#5d1a1a;color:#ff8a80;}
.st.reviewing{background:#5d3a10;color:#ffcc80;}
.st.accepted{background:#143d1c;color:#a5d6a7;}
.st.rejected{background:#3d1a4d;color:#ce93d8;}
.st.withdrawn{background:#263238;color:#90a4ae;}
.kind{font-size:11px;padding:2px 9px;border-radius:10px;font-weight:700;}
.kind.brand{background:#0d3a2c;color:#80cbc4;}
.kind.regulator{background:#3a1f0d;color:#ffb74d;}
.kind.media{background:#1f2a4a;color:#90caf9;}
.dt{font-size:11px;color:#aebadd;background:#13233f;border-radius:10px;padding:2px 9px;}
.urgent{font-size:11px;color:#fff;background:#c62828;border-radius:10px;padding:2px 9px;font-weight:700;animation:blink 1.2s infinite;}
@keyframes blink{50%{opacity:.55;}}
.s-title{font-size:14px;}
.upd{margin-left:auto;font-size:11px;color:#6f84ab;}
.s-meta{display:flex;gap:14px;flex-wrap:wrap;margin:9px 0;font-size:12px;color:#8ba2c8;}
.s-meta i{color:#dbe4f3;font-style:normal;}
.crisis-link,.wo-link{color:#ffd54f;cursor:pointer;}
.crisis-link:hover,.wo-link:hover{text-decoration:underline;}
.src-url{color:#90caf9;text-decoration:none;}
.no-crisis{color:#ef9a9a;}
.content{white-space:pre-wrap;font-family:inherit;font-size:13px;line-height:1.7;color:#c6d3ea;margin:6px 0;background:#0c1730;border-radius:8px;padding:10px 12px;}
.atts{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:#aebadd;margin-bottom:6px;}
.att{background:#13233f;border-radius:6px;padding:3px 9px;}
.att i{color:#6f84ab;font-style:normal;margin-left:4px;}
.reject-box{background:#3d1a4d33;border:1px solid #8e24aa80;color:#ce93d8;border-radius:8px;padding:8px 12px;font-size:12px;margin:6px 0;}
.accept-box{background:#143d1c55;border:1px solid #43a04780;color:#a5d6a7;border-radius:8px;padding:8px 12px;font-size:12px;margin:6px 0;}
.s-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;}
.op{border-radius:7px;padding:6px 12px;font-size:12px;cursor:pointer;background:transparent;}
.op.receive{border:1px solid #fb8c00;color:#ffcc80;}
.op.accept{border:1px solid #43a047;color:#a5d6a7;font-weight:600;}
.op.reject{border:1px solid #8e24aa;color:#ce93d8;}
.op.bind{border:1px solid #5b82c0;color:#90caf9;}
.logbtn{border:1px solid rgba(120,160,220,0.35);color:#aebadd;}
.s-logs{margin-top:10px;border-top:1px dashed rgba(120,160,220,0.18);padding-top:8px;display:flex;flex-direction:column;gap:5px;max-height:230px;overflow-y:auto;}
.slog{display:flex;gap:10px;align-items:baseline;font-size:12px;flex-wrap:wrap;}
.sl-side{font-size:10px;border-radius:8px;padding:0 7px;font-weight:700;}
.slog.internal .sl-side{background:#0d2b4d;color:#90caf9;}
.slog.external .sl-side{background:#3d2a0d;color:#ffb74d;}
.slog.system .sl-side{background:#263238;color:#b0bec5;}
.slog b{color:#dbe4f3;font-size:12px;min-width:42px;}
.slog span{color:#aebadd;flex:1;min-width:200px;}
.slog em{color:#6f84ab;font-style:normal;font-size:11px;}
.modal-mask{position:fixed;inset:0;background:rgba(4,10,22,.72);z-index:60;display:flex;align-items:center;justify-content:center;padding:20px;}
.modal{background:#0f1d38;border:1px solid rgba(120,160,220,0.3);border-radius:14px;padding:20px;width:560px;max-width:100%;display:flex;flex-direction:column;gap:10px;}
.modal h4{margin:0;font-size:15px;}
.modal-hint{margin:0;font-size:12px;color:#8ba2c8;line-height:1.6;}
.modal label{font-size:12px;color:#aebadd;}
.modal select,.modal textarea{background:#13233f;border:1px solid rgba(120,160,220,0.25);color:#dbe4f3;border-radius:8px;padding:9px 11px;font-size:13px;font-family:inherit;}
.modal textarea{min-height:90px;resize:vertical;}
.check{display:flex;align-items:center;gap:8px;}
.modal-ops{display:flex;gap:10px;justify-content:flex-end;}
</style>
