<template>
  <div class="portal">
    <!-- 身份选择（演示：凭门户口令进入；正式环境由独立账号体系承接） -->
    <div v-if="!partner" class="gate">
      <div class="gate-card">
        <div class="gate-logo">📮</div>
        <h2>舆舟 · 外部协作反馈门户</h2>
        <p class="gate-desc">品牌方、监管方、媒体可在此提交<b>证据材料</b>与<b>整改进度</b>，材料经内部审核后将回写处置工单与危机时间线；紧急事项将立即联动内部升级。</p>
        <div class="quick">
          <span class="q-lbl">演示身份（点击快捷进入）：</span>
          <button v-for="c in quick" :key="c.code" class="q-btn" :class="c.kind" @click="login(c.code)">
            <i>{{ kindIcon(c.kind) }}</i>
            <b>{{ c.label }}</b>
            <code>{{ c.code }}</code>
          </button>
        </div>
        <form class="code-form" @submit.prevent="login(inputCode)">
          <input v-model="inputCode" placeholder="或输入协作方专属口令（ACCESS CODE）" required />
          <button class="enter" type="submit">进入门户 →</button>
        </form>
        <p v-if="loginError" class="err">⚠ {{ loginError }}</p>
        <p class="gate-foot">🔒 您只能查看本机构提交的内容；提交后可补充材料或在审核采纳前撤回。</p>
      </div>
    </div>

    <template v-else>
      <div class="toolbar">
        <div class="who">
          <span class="p-kind" :class="partner.kind">{{ kindIcon(partner.kind) }} {{ partner.kindText }}</span>
          <b>{{ partner.name }}</b>
          <span class="p-contact" v-if="partner.contact">联系人：{{ partner.contact }}</span>
        </div>
        <button class="add" @click="showForm=!showForm">＋ 提交证据/整改进度</button>
        <button class="ghost" @click="logout">退出门户</button>
      </div>

      <p class="hint">📌 提交后状态流转：<b>待审核 → 受理中 → 已采纳 / 已驳回</b>；已采纳材料将并入危机处置档案，可在下方查看内部审核意见；被驳回时可补充材料后重新提交。</p>

      <!-- 提交表单 -->
      <form v-if="showForm" class="sub-form" @submit.prevent="submit">
        <div class="row">
          <select v-model="form.doc_type">
            <option value="evidence">🗂 证据材料</option>
            <option value="rectify">📈 整改进度</option>
            <option value="clue">💡 线索反映</option>
          </select>
          <select v-model.number="form.crisis_id">
            <option :value="null">不指定事件（通用线索，内部核实后挂接）</option>
            <option v-for="c in crises" :key="c.id" :value="c.id">
              #{{ c.id }} {{ c.title }}（{{ c.levelText }} · {{ stText(c.status) }}）
            </option>
          </select>
        </div>
        <input v-model="form.title" placeholder="标题，如 门店整改进度日报 / 监督检查证据 / 采访补充材料" required />
        <textarea v-model="form.content" class="content" placeholder="请详细描述：事实经过、整改措施与进度、可核实的时间地点…" required></textarea>
        <div class="row">
          <input v-model="form.source_url" placeholder="来源链接（报道 URL / 公开文号页面，可留空）" />
          <input v-model="form.contact_info" placeholder="本次对接联系方式（可留空）" />
        </div>
        <!-- 附件清单（演示：仅登记元数据，不落文件） -->
        <div class="atts-edit">
          <span class="lbl">📎 附件清单（演示环境登记文件信息，不上传实体文件）</span>
          <div v-for="(a,i) in form.attachments" :key="i" class="att-row">
            <input v-model="a.name" placeholder="文件名，如 检查记录.pdf" />
            <input v-model.number="a.size" type="number" min="0" placeholder="大小(字节)" style="max-width:120px" />
            <input v-model="a.type" placeholder="类型，如 application/pdf" style="max-width:200px" />
            <button type="button" class="del-att" @click="form.attachments.splice(i,1)">✕</button>
          </div>
          <button type="button" class="add-att" @click="form.attachments.push({name:'',size:0,type:''})">＋ 添加附件</button>
        </div>
        <label class="urgent-check"><input type="checkbox" v-model="form.is_urgent" /> ⚡ 紧急提交（监管督办/重大风险，提交后立即通知内部值班负责人并升级）</label>
        <div class="row">
          <button class="save" type="submit">提交</button>
          <button type="button" class="ghost" @click="showForm=false">取消</button>
        </div>
      </form>

      <div v-if="!mine.length" class="none">暂无提交记录，点击右上角「提交证据/整改进度」开始</div>

      <div class="list">
        <div v-for="s in mine" :key="s.id" class="m-card" :class="[s.status,{urgent:s.is_urgent}]">
          <div class="m-head">
            <span class="code">{{ s.code }}</span>
            <span class="st" :class="s.status">{{ s.statusText }}</span>
            <span class="dt">{{ s.docTypeText }}</span>
            <span v-if="s.is_urgent" class="urgent">⚡ 紧急</span>
            <b class="m-title">{{ s.title }}</b>
            <span class="upd">{{ s.updated }}</span>
          </div>
          <div class="m-meta">
            <span v-if="s.crisis_id">关联事件 <i>#{{ s.crisis_id }} {{ s.crisis_title }}</i></span>
            <span v-else class="no-crisis">未关联事件（等待内部核实挂接）</span>
            <a v-if="s.source_url" :href="s.source_url" target="_blank" rel="noopener">🔗 来源链接</a>
          </div>
          <pre class="content">{{ s.content }}</pre>
          <div v-if="s.attachments && s.attachments.length" class="atts">
            📎 <span v-for="(a,i) in s.attachments" :key="i" class="att">{{ a.name }}<i v-if="a.size">（{{ fmtSize(a.size) }}）</i></span>
          </div>

          <!-- 内部反馈 -->
          <div v-if="s.status==='accepted'" class="accept-box">
            ✔ 内部已采纳（{{ s.accepted_by }} · {{ s.accepted_at }}）<template v-if="s.work_order_id"> · 已回写处置工单 #{{ s.work_order_id }}</template><template v-if="s.resolved_alert_count"> · 同步解除 {{ s.resolved_alert_count }} 条预警</template><template v-if="s.accepted_note"><br />📝 {{ s.accepted_note }}</template>
          </div>
          <div v-if="s.status==='rejected'" class="reject-box">↩ 内部驳回：{{ s.reject_reason }}（{{ s.rejected_by }}）——可补充材料后重新提交</div>

          <!-- 外部操作 -->
          <div class="m-actions">
            <button v-if="['pending','reviewing','rejected'].includes(s.status)" class="op sup" @click="openSup(s)">＋ 补充材料</button>
            <button v-if="['pending','reviewing','rejected'].includes(s.status)" class="op wd" @click="withdraw(s)">撤回提交</button>
            <button class="op logbtn" @click="toggleLogs(s)">{{ logId===s.id ? '收起留痕' : '🧾 处理留痕' }}</button>
          </div>
          <div v-if="logId===s.id" class="m-logs">
            <div v-for="l in s.logs" :key="l.id" class="mlog" :class="l.operator_side">
              <span class="ml-side">{{ sideText(l.operator_side) }}</span>
              <b>{{ extLogText(l.action) }}</b>
              <span>{{ l.detail }}</span>
              <em>{{ l.operator }} · {{ l.time }}</em>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { usePubStore } from '@/store/pub'

const store = usePubStore()
const quick = [
  { code: 'BRAND-2026', label: '某连锁品牌总部（公关部）', kind: 'brand' },
  { code: 'GOV-12315', label: '市市场监督管理局', kind: 'regulator' },
  { code: 'PRESS-PP', label: '澎湃新闻（民生调查部）', kind: 'media' }
]
const inputCode = ref('')
const loginError = ref('')
const partner = ref(null)
const crises = ref([])
const mine = ref([])
const showForm = ref(false)
const logId = ref(null)
const form = ref(blankForm())

function blankForm() {
  return { doc_type: 'evidence', crisis_id: null, title: '', content: '', source_url: '', contact_info: '', is_urgent: false, attachments: [] }
}
function kindIcon(k) { return { brand: '🏢', regulator: '⚖️', media: '📰' }[k] || '🤝' }
function stText(s) { return { monitoring: '监测中', disposal: '处置中', closed: '已结案' }[s] || s }
function fmtSize(n) {
  if (!n) return ''
  if (n >= 1048576) return (n / 1048576).toFixed(1) + 'MB'
  return Math.max(1, Math.round(n / 1024)) + 'KB'
}
function sideText(s) { return { internal: '内部', external: '我方', system: '系统' }[s] || s }
function extLogText(a) {
  return { create: '提交', supplement: '补充材料', withdraw: '撤回', receive: '内部受理', accept: '审核采纳', reject: '审核驳回', bind: '挂接事件', urgent: '紧急升级' }[a] || a
}

async function login(code) {
  loginError.value = ''
  store.setPortalCode((code || '').trim())
  try {
    const d = await store.portalBootstrap()
    partner.value = d.partner
    crises.value = d.crises
    mine.value = d.mine
  } catch (e) {
    partner.value = null
    loginError.value = e.message || '门户口令无效'
  }
}
function logout() {
  partner.value = null
  mine.value = []
  inputCode.value = ''
  store.setPortalCode('')
}

async function refresh() {
  if (!partner.value) return
  const d = await store.portalBootstrap()
  partner.value = d.partner
  crises.value = d.crises
  mine.value = d.mine
}
async function submit() {
  // 清理空附件行
  form.value.attachments = form.value.attachments.filter((a) => a.name && a.name.trim())
  await store.portalSubmit({ ...form.value })
  showForm.value = false
  form.value = blankForm()
  refresh()
}
async function openSup(s) {
  const note = window.prompt('补充材料说明（将追加到原提交并通知内部审核）：')
  if (note && note.trim()) { await store.portalSupplement(s.id, note.trim()); refresh() }
}
async function withdraw(s) {
  const reason = window.prompt('撤回原因（可留空）：') || ''
  if (reason === null) return
  await store.portalWithdraw(s.id, reason.trim())
  refresh()
}
async function toggleLogs(s) {
  if (logId.value === s.id) { logId.value = null; return }
  logId.value = s.id
  if (!s.logs) {
    const full = await store.portalFetch(s.id)
    const idx = mine.value.findIndex((x) => x.id === s.id)
    if (idx >= 0) mine.value[idx] = full
  }
}

let timer = null
onMounted(() => {
  timer = setInterval(() => { if (partner.value && document.visibilityState === 'visible') refresh().catch(() => {}) }, 10000)
})
onUnmounted(() => clearInterval(timer))
</script>

<style scoped>
.portal{display:flex;flex-direction:column;gap:12px;}
/* 身份门 */
.gate{min-height:70vh;display:flex;align-items:center;justify-content:center;padding:20px;}
.gate-card{width:560px;max-width:100%;background:linear-gradient(160deg,#10234a,#0c1730);border:1px solid rgba(120,160,220,0.25);border-radius:18px;padding:32px 34px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.45);}
.gate-logo{font-size:42px;}
.gate-card h2{margin:8px 0 10px;font-size:20px;background:linear-gradient(90deg,#90caf9,#ce93d8);-webkit-background-clip:text;background-clip:text;color:transparent;}
.gate-desc{font-size:13px;color:#aebadd;line-height:1.8;margin:0 0 20px;}
.quick{display:flex;flex-direction:column;gap:8px;margin-bottom:18px;text-align:left;}
.q-lbl{font-size:12px;color:#8ba2c8;}
.q-btn{display:flex;align-items:center;gap:10px;background:#13233f;border:1px solid rgba(120,160,220,0.22);border-radius:10px;padding:10px 14px;cursor:pointer;color:#dbe4f3;text-align:left;}
.q-btn:hover{border-color:#5b82c0;background:#163055;}
.q-btn i{font-style:normal;font-size:18px;}
.q-btn b{flex:1;font-size:13px;font-weight:600;}
.q-btn code{font-size:11px;color:#ffd54f;background:#0a1224;border-radius:5px;padding:2px 8px;}
.code-form{display:flex;gap:8px;}
.code-form input{flex:1;background:#0a1224;border:1px solid rgba(120,160,220,0.3);border-radius:9px;padding:11px 14px;color:#dbe4f3;font-size:13px;font-family:monospace;letter-spacing:1px;}
.enter{background:linear-gradient(135deg,#1565c0,#6a1b9a);color:#fff;border:none;border-radius:9px;padding:0 20px;font-weight:700;cursor:pointer;font-size:13px;}
.err{color:#ef9a9a;font-size:12px;margin:10px 0 0;}
.gate-foot{font-size:11px;color:#6f84ab;margin:16px 0 0;}
/* 门户内 */
.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
.who{display:flex;align-items:center;gap:10px;font-size:13px;}
.p-kind{padding:4px 11px;border-radius:14px;font-size:12px;font-weight:700;}
.p-kind.brand{background:#0d3a2c;color:#80cbc4;}
.p-kind.regulator{background:#3a1f0d;color:#ffb74d;}
.p-kind.media{background:#1f2a4a;color:#90caf9;}
.p-contact{color:#8ba2c8;font-size:12px;}
.add{margin-left:auto;background:linear-gradient(135deg,#1565c0,#6a1b9a);color:#fff;border:none;padding:9px 16px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;}
.ghost{background:transparent;border:1px solid rgba(120,160,220,0.35);color:#aebadd;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:13px;}
.hint{font-size:12px;color:#8ba2c8;line-height:1.7;margin:0;}
.sub-form{background:#0f1d38;border:1px solid rgba(120,160,220,0.2);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px;}
.row{display:flex;gap:10px;flex-wrap:wrap;}
.row>*{flex:1;min-width:200px;}
.sub-form select,.sub-form input,.sub-form textarea{background:#13233f;border:1px solid rgba(120,160,220,0.25);color:#dbe4f3;border-radius:8px;padding:9px 11px;font-size:13px;font-family:inherit;}
.sub-form textarea.content{min-height:130px;resize:vertical;}
.atts-edit{display:flex;flex-direction:column;gap:7px;}
.lbl{font-size:12px;color:#8ba2c8;}
.att-row{display:flex;gap:8px;}
.att-row input{flex:1;min-width:0;font-size:12px;padding:7px 9px;}
.del-att{background:transparent;border:1px solid rgba(239,83,80,.5);color:#ef9a9a;border-radius:7px;width:38px;cursor:pointer;}
.add-att{align-self:flex-start;background:transparent;border:1px dashed rgba(120,160,220,0.4);color:#90caf9;border-radius:7px;padding:6px 12px;font-size:12px;cursor:pointer;}
.urgent-check{font-size:12px;color:#ffb74d;display:flex;align-items:center;gap:8px;}
.save{background:#2e7d32;color:#fff;border:none;border-radius:8px;padding:10px 22px;cursor:pointer;font-weight:700;font-size:13px;}
.none{text-align:center;color:#6f84ab;padding:50px 0;}
.list{display:flex;flex-direction:column;gap:10px;}
.m-card{background:#0f1d38;border:1px solid rgba(120,160,220,0.15);border-radius:12px;padding:14px 16px;}
.m-card.urgent{border-color:rgba(239,83,80,.5);}
.m-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.code{font-family:monospace;background:#0a1224;border:1px solid rgba(120,160,220,0.3);border-radius:5px;padding:2px 8px;font-size:11px;color:#90caf9;}
.st{font-size:11px;padding:2px 9px;border-radius:10px;font-weight:700;}
.st.pending{background:#5d1a1a;color:#ff8a80;}
.st.reviewing{background:#5d3a10;color:#ffcc80;}
.st.accepted{background:#143d1c;color:#a5d6a7;}
.st.rejected{background:#3d1a4d;color:#ce93d8;}
.st.withdrawn{background:#263238;color:#90a4ae;}
.dt{font-size:11px;color:#aebadd;background:#13233f;border-radius:10px;padding:2px 9px;}
.urgent{font-size:11px;color:#fff;background:#c62828;border-radius:10px;padding:2px 9px;font-weight:700;}
.m-title{font-size:14px;}
.upd{margin-left:auto;font-size:11px;color:#6f84ab;}
.m-meta{display:flex;gap:14px;flex-wrap:wrap;margin:9px 0;font-size:12px;color:#8ba2c8;}
.m-meta i{color:#dbe4f3;font-style:normal;}
.m-meta a{color:#90caf9;text-decoration:none;}
.no-crisis{color:#ffb74d;}
.content{white-space:pre-wrap;font-family:inherit;font-size:13px;line-height:1.7;color:#c6d3ea;margin:6px 0;background:#0c1730;border-radius:8px;padding:10px 12px;}
.atts{display:flex;gap:10px;flex-wrap:wrap;font-size:12px;color:#aebadd;margin-bottom:6px;}
.att{background:#13233f;border-radius:6px;padding:3px 9px;}
.att i{color:#6f84ab;font-style:normal;margin-left:4px;}
.accept-box{background:#143d1c55;border:1px solid #43a04780;color:#a5d6a7;border-radius:8px;padding:8px 12px;font-size:12px;line-height:1.7;margin:6px 0;}
.reject-box{background:#3d1a4d33;border:1px solid #8e24aa80;color:#ce93d8;border-radius:8px;padding:8px 12px;font-size:12px;margin:6px 0;}
.m-actions{display:flex;gap:8px;flex-wrap:wrap;}
.op{border-radius:7px;padding:6px 12px;font-size:12px;cursor:pointer;background:transparent;}
.op.sup{border:1px solid #fb8c00;color:#ffcc80;}
.op.wd{border:1px solid rgba(239,83,80,.55);color:#ef9a9a;}
.logbtn{border:1px solid rgba(120,160,220,0.35);color:#aebadd;}
.m-logs{margin-top:10px;border-top:1px dashed rgba(120,160,220,0.18);padding-top:8px;display:flex;flex-direction:column;gap:5px;max-height:230px;overflow-y:auto;}
.mlog{display:flex;gap:10px;align-items:baseline;font-size:12px;flex-wrap:wrap;}
.ml-side{font-size:10px;border-radius:8px;padding:0 7px;font-weight:700;}
.mlog.internal .ml-side{background:#0d2b4d;color:#90caf9;}
.mlog.external .ml-side{background:#3d2a0d;color:#ffb74d;}
.mlog.system .ml-side{background:#263238;color:#b0bec5;}
.mlog b{min-width:56px;color:#dbe4f3;}
.mlog span{color:#aebadd;flex:1;min-width:180px;}
.mlog em{color:#6f84ab;font-style:normal;font-size:11px;}
</style>
