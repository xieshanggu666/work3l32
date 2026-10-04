<template>
  <div class="rp">
    <div class="rp-toolbar">
      <button v-if="canOps" class="add" @click="showForm=!showForm">＋ 编制复盘报告</button>
      <div class="chips">
        <button class="chip" :class="{on:!filter}" @click="setFilter('')">全部 {{ summary.total || 0 }}</button>
        <button v-for="(txt,k) in dict.status" :key="k" class="chip" :class="[k,{on:filter===k}]" @click="setFilter(k)">
          {{ txt }} {{ summary.counts?.[k] || 0 }}
        </button>
        <span v-if="summary.reviewing" class="chip rev">🖊 待审核 {{ summary.reviewing }}</span>
      </div>
      <span class="me">👤 {{ store.user.name }} · {{ roleText(store.user.role) }}</span>
    </div>
    <p class="hint">🔗 复盘报告汇总<b>预警、处置时间线、传播路径、协同工单、危机声明、外部协作反馈、通知回执</b>同源快照；支持跨角色分段编制 → 提交审核 → 审核发布（驳回可重编），每次送审/发布/回滚均归档不可变版本，已发布版本可一键回滚；审核通过自动回写结案档案与统计口径。</p>

    <!-- 创建报告 -->
    <form v-if="showForm" class="rp-form" @submit.prevent="create">
      <div class="row">
        <select v-model.number="form.crisis_id" required>
          <option :value="null" disabled>选择危机事件（每个事件一份复盘报告）</option>
          <option v-for="c in creatableCrises" :key="c.id" :value="c.id">
            #{{ c.id }} {{ c.title }}（{{ stText(c.status) }}）{{ hasReport(c.id) ? '· 已有报告' : '' }}
          </option>
        </select>
      </div>
      <input v-model="form.title" placeholder="报告标题（留空则默认「事件名 · 危机复盘报告」）" />
      <div v-if="!creatableCrises.length" class="no-crisis">⚠️ 所有危机事件均已编制复盘报告</div>
      <div class="row">
        <button class="save" type="submit" :disabled="!form.crisis_id">建档并冻结首版聚合快照</button>
        <button type="button" class="ghost" @click="showForm=false">取消</button>
      </div>
    </form>

    <div v-if="!items.length" class="none">暂无复盘报告（点击上方按钮，为危机事件编制复盘报告）</div>

    <!-- 报告列表 -->
    <div v-for="r in items" :key="r.id" class="rp-card" :class="r.status">
      <div class="r-head" @click="toggle(r)">
        <span class="st" :class="r.status">{{ r.statusText }}</span>
        <b class="r-title">{{ r.title }}</b>
        <span class="crisis-tag">#{{ r.crisis_id }} {{ r.crisis_title }}</span>
        <span class="crisis-st" :class="r.crisis_status">{{ stText(r.crisis_status) }}</span>
        <span class="ver-tag">📄 v{{ r.current_version }}<template v-if="r.published_version"> / 已发布 v{{ r.published_version }}</template></span>
        <span class="ver-count">🗂 {{ r.version_count }} 个归档</span>
        <span class="arrow">{{ openId===r.id ? '▲' : '▼' }}</span>
      </div>

      <!-- 报告详情 -->
      <div v-if="openId===r.id && detail" class="r-body">
        <div class="r-meta">
          <span>编制 <i>{{ detail.created_by }}</i></span>
          <span v-if="detail.submitted_by">送审 <i>{{ detail.submitted_by }} · {{ detail.submitted_at }}</i></span>
          <span v-if="detail.reviewed_by">审核 <i>{{ detail.reviewed_by }} · {{ detail.reviewed_at }}</i></span>
          <span v-if="detail.published_at">发布于 <i>{{ detail.published_at }}</i></span>
          <span>更新 <i>{{ detail.updated }}</i></span>
          <span v-if="detail.snapshotted_at">快照冻结 <i>{{ detail.snapshotted_at }}</i></span>
        </div>

        <!-- 工作操作条 -->
        <div class="work-actions">
          <button v-if="canOps && detail.status==='draft'" class="op snap" @click="refreshSnap(detail)">🔄 刷新聚合数据</button>
          <button v-if="canOps && detail.status==='draft'" class="op submit" @click="submit(detail)">🖊 提交审核</button>
          <button v-if="canReview && detail.status==='reviewing'" class="op approve" @click="approve(detail)">✔ 审核通过并发布</button>
          <button v-if="canReview && detail.status==='reviewing'" class="op reject" @click="reject(detail)">↩ 驳回重编</button>
          <button v-if="canReview && ['published','draft'].includes(detail.status)" class="op rollback" @click="rollback(detail)">⏪ 版本回滚</button>
        </div>

        <div class="sub-tabs">
          <button v-for="t in subTabs" :key="t.key" :class="{on:subTab===t.key}" @click="subTab=t.key">{{ t.label }}</button>
        </div>

        <!-- ① 章节编制 -->
        <div v-if="subTab==='edit'" class="panel">
          <div v-for="(label,key) in dict.sections" :key="key" class="chapter" :class="{empty:!detail[key]}">
            <div class="ch-head">
              <b>{{ label }}</b>
              <span v-if="detail[key+'_by']" class="ch-who">✍️ {{ detail[key+'_by'] }} · {{ detail[key+'_at'] }}</span>
              <span v-else class="ch-who none-who">尚未编制</span>
              <button v-if="editable && !editing[key]" class="mini" @click="startEdit(key)">{{ detail[key] ? '编辑' : '编写' }}</button>
              <template v-if="editable && editing[key]">
                <button class="mini save-mini" @click="saveSection(detail,key)">保存</button>
                <button class="mini ghost-mini" @click="cancelEdit(detail,key)">取消</button>
              </template>
              <span v-if="savedKey===key" class="saved-flash">✓ 已保存</span>
            </div>
            <textarea v-if="editable && editing[key]" v-model="drafts[key]" class="ch-input" rows="4"
              :placeholder="'请编写「' + label + '」…（跨角色分段编制，保存后记录最后编辑人）'"></textarea>
            <pre v-else class="ch-text">{{ detail[key] || '（待编制）' }}</pre>
          </div>
        </div>

        <!-- ② 聚合快照 -->
        <div v-else-if="subTab==='snapshot'" class="panel snapshot">
          <div class="snap-time">📦 快照冻结于 {{ detail.snapshotted_at || detail.snapshot.generatedAt || '—' }}
            <span v-if="editable" class="snap-tip">（编制中可随时「刷新聚合数据」重新汇总；送审/发布时自动冻结）</span></div>
          <div v-if="!detail.snapshot || !detail.snapshot.crisis" class="none">暂无快照，请先刷新聚合数据</div>
          <template v-else>
            <!-- 预警 -->
            <section class="snap-sec">
              <h5>🚨 预警汇总</h5>
              <div class="mini-stats">
                <div><b>{{ snap.alerts.total }}</b><em>触发</em></div>
                <div><b class="ok">{{ snap.alerts.resolved }}</b><em>已解除</em></div>
                <div><b class="warn-num">{{ snap.alerts.open }}</b><em>未解除</em></div>
              </div>
              <div class="rule-row">
                <span v-for="ru in snap.alerts.byRule" :key="ru.alert_id" class="rule-pill" :class="ru.level">
                  {{ ru.title }}<i>{{ ru.open ? ru.open+' 待处置 · ' : '' }}{{ ru.total }} 次</i>
                </span>
              </div>
              <div class="snap-list">
                <div v-for="e in snap.alerts.events" :key="e.id" class="snap-item" :class="{resolved:e.status==='resolved'}">
                  <span class="dot" :class="e.alert_level"></span>
                  <b>{{ e.detail }}</b>
                  <span v-if="e.pt">《{{ e.pt }}》热度 {{ e.heat }}</span>
                  <em>{{ e.time }}</em>
                  <i v-if="e.status==='resolved'" class="tag ok-tag">{{ kindText(e.resolve_kind) }}</i>
                  <i v-else class="tag warn-tag">待处置</i>
                </div>
              </div>
            </section>

            <!-- 时间线 -->
            <section class="snap-sec">
              <h5>🕒 处置时间线（{{ snap.timeline.total }} 条）</h5>
              <div class="tl-mini">
                <div v-for="t in snap.timeline.items" :key="t.id" class="tl-mini-item">
                  <span class="tl-dot"></span><b>{{ t.action }}</b><span>{{ t.note }}</span><em>{{ t.time }}</em>
                </div>
              </div>
            </section>

            <!-- 传播路径 -->
            <section class="snap-sec">
              <h5>🕸 传播路径（{{ snap.propagation.total }} 条 · 爆发 {{ snap.propagation.outbreak }}）</h5>
              <div v-if="!snap.propagation.total" class="snap-empty">该事件暂无关联传播路径</div>
              <div v-for="p in snap.propagation.paths" :key="p.id" class="path-card" :class="p.stage">
                <b>{{ p.title }}</b>
                <span class="p-stage" :class="p.stage">{{ stageText(p.stage) }}</span>
                <span>节点 {{ p.nodeCount }}</span><span>KOL {{ p.kolCount }}</span>
                <span>转发关系 {{ p.edgeCount }}</span><span>累计触达 {{ formatNum(p.totalReach) }}</span>
                <span class="hot">峰值热度 {{ p.peakHeat }}</span>
              </div>
            </section>

            <!-- 工单（含统一调度链路：分派→发送/重试→回执/升级） -->
            <section class="snap-sec">
              <h5>📋 协同工单（{{ snap.workOrders.total }} 张 · 在办 {{ snap.workOrders.open }} · 已完成 {{ snap.workOrders.done }}<template v-if="snap.workOrders.overdue"> · 超时 {{ snap.workOrders.overdue }}</template><template v-if="snap.workOrders.escalated"> · 已升级 {{ snap.workOrders.escalated }}</template>）</h5>
              <div v-if="!snap.workOrders.total" class="snap-empty">该事件暂无协同工单</div>
              <div v-for="w in snap.workOrders.items" :key="w.id" class="wo-card-snap" :class="w.status">
                <span class="tag" :class="'st-'+w.status">{{ woText(w.status) }}</span>
                <b>#{{ w.id }} {{ w.title }}</b>
                <span>{{ catText(w.category) }} · {{ priText(w.priority) }}<template v-if="w.escalated"> · ⬆ {{ w.escalated===2 ? '二级督办' : '一级升级' }}</template></span>
                <span>处理人 {{ w.assignee ? `${w.assignee}${w.assignee_role ? '·'+teamText(w.assignee_role) : ''}` : '待分派' }}</span>
                <span v-if="w.delivery && w.delivery.total" class="wo-dlv">
                  🔗 通知 {{ w.delivery.total }} 渠道<template v-if="w.delivery.sent"> · 送达 {{ w.delivery.sent }}</template><template v-if="w.delivery.acked"> · 回执 {{ w.delivery.acked }}</template><template v-if="w.delivery.pending"> · 在途 {{ w.delivery.pending }}</template><template v-if="w.delivery.escalated"> · 回执升级 {{ w.delivery.escalated }}</template><template v-if="w.delivery.failed"> · 失败 {{ w.delivery.failed }}</template><template v-if="w.delivery.retries"> · 重试 {{ w.delivery.retries }}</template>
                </span>
                <span v-if="w.result" class="wo-result">✅ {{ w.result }}</span>
              </div>
            </section>

            <!-- 危机声明 -->
            <section class="snap-sec">
              <h5>📢 危机声明（{{ (snap.statements && snap.statements.total) || 0 }} 份 · 已发布 {{ (snap.statements && snap.statements.published) || 0 }}<template v-if="snap.statements && snap.statements.partial"> · 部分失败 {{ snap.statements.partial }}</template><template v-if="snap.statements && snap.statements.review"> · 待审 {{ snap.statements.review }}</template>）</h5>
              <div v-if="!snap.statements || !snap.statements.total" class="snap-empty">该事件暂无危机声明</div>
              <div v-for="st in (snap.statements && snap.statements.items) || []" :key="st.id" class="stmt-snap" :class="st.status">
                <div class="stmt-snap-head">
                  <span class="tag" :class="'stmtst-'+st.status">{{ stmtStatusText(st.status) }}</span>
                  <b>{{ st.title }}</b>
                  <span v-if="st.work_order_id" class="stmt-wo">📋 关联工单 #{{ st.work_order_id }}</span>
                  <span>起草 {{ st.drafted_by || '—' }} · 法务 {{ st.reviewed_by || '待审' }}</span>
                </div>
                <div class="stmt-chs">
                  <span v-for="ch in st.channels" :key="ch.id" class="stmt-ch" :class="ch.status">
                    {{ ch.channel_name }}<i>{{ stmtChText(ch.status) }}</i>
                  </span>
                </div>
                <span v-if="st.review_note" class="stmt-note">⚖️ {{ st.review_note }}</span>
              </div>
            </section>

            <!-- 外部协作反馈（品牌方/监管方/媒体证据与整改进度） -->
            <section class="snap-sec">
              <h5>🤝 外部协作反馈（{{ (snap.externalFeedback && snap.externalFeedback.total) || 0 }} 份 · 已采纳 {{ (snap.externalFeedback && snap.externalFeedback.accepted) || 0 }}<template v-if="snap.externalFeedback && snap.externalFeedback.urgent"> · 紧急 {{ snap.externalFeedback.urgent }}</template><template v-if="snap.externalFeedback && snap.externalFeedback.resolvedAlerts"> · 联动解除预警 {{ snap.externalFeedback.resolvedAlerts }}</template>）</h5>
              <div v-if="!snap.externalFeedback || !snap.externalFeedback.total" class="snap-empty">该事件暂无外部协作提交</div>
              <div v-for="ex in (snap.externalFeedback && snap.externalFeedback.items) || []" :key="ex.id" class="ext-snap" :class="ex.status">
                <div class="ext-snap-head">
                  <span class="code">{{ ex.code }}</span>
                  <span class="tag" :class="'extst-'+ex.status">{{ extStatusText(ex.status) }}</span>
                  <span v-if="ex.is_urgent" class="ext-urgent">⚡ 紧急</span>
                  <b>{{ ex.title }}</b>
                  <span class="ext-who">{{ extKindText(ex.kind) }} · {{ ex.partner_name }}</span>
                </div>
                <div class="ext-snap-meta">
                  {{ extDocText(ex.doc_type) }}<template v-if="ex.work_order_id"> · 📋 回写工单 #{{ ex.work_order_id }}</template><template v-if="ex.resolved_alert_count"> · 解除预警 {{ ex.resolved_alert_count }}</template>
                </div>
                <span v-if="ex.accepted_note" class="ext-note">✔ {{ ex.accepted_by }}：{{ ex.accepted_note }}</span>
                <span v-else-if="ex.reject_reason" class="ext-note reject">↩ {{ ex.rejected_by }}：{{ ex.reject_reason }}</span>
              </div>
            </section>

            <!-- 通知回执（与危机看板/工单调度链路同口径） -->
            <section class="snap-sec">
              <h5>🔔 通知与回执（{{ snap.notifications.total }} 条 · 已回执 {{ snap.notifications.acked }} · 已升级 {{ snap.notifications.escalated }}<template v-if="snap.notifications.retries"> · 自动重试 {{ snap.notifications.retries }}</template>）</h5>
              <div v-if="!snap.notifications.total" class="snap-empty">该事件暂无通知任务</div>
              <div class="nt-row">
                <span v-for="(cnt,st) in snap.notifications.byStatus" :key="st" class="nt-pill" :class="st">{{ ntText(st) }} {{ cnt }}</span>
              </div>
              <div class="snap-list">
                <div v-for="t in snap.notifications.items" :key="t.id" class="snap-item nt">
                  <span class="nt-dot" :class="t.status"></span>
                  <b>{{ t.title }}</b>
                  <span>{{ t.channel_name }}（{{ t.channel_type }}）<template v-if="t.work_order_id"> · 📋 工单 #{{ t.work_order_id }}</template><template v-if="t.prop_path_id"> · 🕸 传播路径 #{{ t.prop_path_id }}</template><template v-if="t.ext_submission_id"> · 🤝 外部协作 #{{ t.ext_submission_id }}</template><template v-if="t.attempts>1"> · 尝试 {{ t.attempts }}/{{ t.max_attempts }}</template></span>
                  <i class="tag" :class="'st-'+t.status">{{ ntText(t.status) }}</i>
                  <span v-if="t.escalated_from" class="ack">⬆ 回执超时升级自 #{{ t.escalated_from }}</span>
                  <span v-if="t.ack_by" class="ack">回执：{{ t.ack_by }} · {{ t.ack_at }}<template v-if="t.ack_note">（{{ t.ack_note }}）</template></span>
                  <em>{{ t.sent_at || t.created }}</em>
                </div>
              </div>
            </section>

            <!-- 结案档案 -->
            <section class="snap-sec">
              <h5>✅ 结案档案（{{ snap.closures.length }} 次）</h5>
              <div v-for="cl in snap.closures" :key="cl.id" class="closure-snap" :class="{rolled:cl.rolled_back}">
                <b>{{ cl.rolled_back ? '↩︎ 已回滚结案' : '✔ 结案' }}</b>
                <span>{{ cl.summary }}</span>
                <em>{{ cl.closed_at }}</em>
                <i v-if="cl.report_id" class="tag report-tag">📄 回写报告 v{{ cl.report_version }}</i>
              </div>
            </section>
          </template>
        </div>

        <!-- ③ 版本归档 -->
        <div v-else-if="subTab==='version'" class="panel">
          <div v-if="!detail.versions.length" class="none">暂无归档版本（提交审核时生成首个版本）</div>
          <div v-for="v in detail.versions" :key="v.id" class="ver-row">
            <div class="ver-main" @click="toggleVer(v.version)">
              <span class="ver-no">v{{ v.version }}</span>
              <span class="ver-kind" :class="v.kind">{{ verKindText(v.kind) }}</span>
              <b>{{ v.note || '—' }}</b>
              <span class="ver-op">{{ v.operator }} · {{ v.created }}</span>
              <span v-if="canReview && ['published','draft'].includes(detail.status)" class="ver-actions">
                <button class="mini rollback-mini" @click.stop="rollbackTo(detail,v)">⏪ 回滚到此版本</button>
              </span>
              <span class="arrow">{{ verOpen===v.version ? '▲' : '▼' }}</span>
            </div>
            <div v-if="verOpen===v.version" class="ver-detail">
              <div v-if="v.source_version" class="ver-source">↳ 由 v{{ v.source_version }} 回滚生成</div>
              <div v-for="(label,key) in dict.sections" :key="key" class="ver-ch" :class="{diff: contentDiff(detail,v,key)}">
                <b>{{ label }}<i v-if="contentDiff(detail,v,key)" class="diff-tag">与当前内容有差异</i></b>
                <pre>{{ (v.content && v.content[key]) || '（空）' }}</pre>
              </div>
            </div>
          </div>
        </div>

        <!-- ④ 操作留痕 -->
        <div v-else-if="subTab==='log'" class="panel">
          <div v-for="l in detail.logs" :key="l.id" class="log-row">
            <span class="log-act" :class="l.action">{{ logText(l.action) }}</span>
            <span class="log-detail">{{ l.detail }}</span>
            <em>{{ l.operator }}{{ l.operator_role ? '·'+l.operator_role : '' }} · {{ l.time }}</em>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue'
import { usePubStore } from '@/store/pub'

const store = usePubStore()
const items = ref([])
const summary = ref({ counts: {}, total: 0 })
const dict = ref({ status: {}, sections: {}, roles: {} })
const filter = ref('')
const showForm = ref(false)
const form = ref({ crisis_id: null, title: '' })
const openId = ref(null)
const detail = ref(null)
const subTab = ref('edit')
const editing = reactive({})
const drafts = reactive({})
const savedKey = ref('')
const verOpen = ref(null)

const canOps = computed(() => ['admin', 'ops'].includes(store.user.role))
const canReview = computed(() => store.user.role === 'admin')
const editable = computed(() => detail.value && detail.value.status === 'draft' && canOps.value)
const creatableCrises = computed(() => store.crises)
const subTabs = [
  { key: 'edit', label: '✍️ 章节编制' },
  { key: 'snapshot', label: '📦 数据汇总' },
  { key: 'version', label: '🗂 版本归档' },
  { key: 'log', label: '📜 操作留痕' }
]
const snap = computed(() => detail.value?.snapshot || {})

function roleText(r) { return { admin: '管理员', ops: '值班员', viewer: '观察员' }[r] || r }
function stText(x) { return { monitoring: '监测中', disposal: '处置中', closed: '已结案' }[x] || x }
function stageText(x) { return { seed: '潜伏期', ferment: '发酵期', outbreak: '爆发期', decline: '回落期' }[x] || x }
function woText(x) { return { todo: '待分派', doing: '处理中', blocked: '已阻塞', done: '已完成', cancelled: '已取消' }[x] || x }
function catText(x) { return { pr: '公关口径', legal: '法务合规', ops: '现场运营', support: '客诉跟进', other: '其他' }[x] || x }
function priText(x) { return { urgent: '紧急', high: '高', normal: '普通' }[x] || x }
function teamText(x) { return { pr: '公关', legal: '法务', ops: '运营', support: '客服', admin: '协调组' }[x] || x }
function ntText(x) {
  return { pending: '待发送', sent: '已发送', failed: '发送失败', acked: '已回执', escalated: '已升级', paused: '已暂停', cancelled: '已取消' }[x] || x
}
function verKindText(x) { return { submit: '送审归档', publish: '发布归档', rollback: '回滚归档' }[x] || x }
function logText(a) {
  return { create: '建档', edit: '编制', snapshot: '刷新快照', submit: '送审', approve: '审核通过', reject: '驳回', publish: '发布', rollback: '版本回滚' }[a] || a
}
function kindText(k) { return { manual: '手动解除', batch: '批量解除', close: '结案联动', notify: '通知回执', workorder: '工单联动' }[k] || k || '已解除' }
function stmtStatusText(x) { return { draft: '起草中', review: '待法务审核', approved: '审核通过', publishing: '发布中', partial: '部分渠道失败', published: '已发布', cancelled: '已取消' }[x] || x }
function stmtChText(x) { return { pending: '待执行', publishing: '执行中', success: '已发布', failed: '失败', cancelled: '已取消' }[x] || x }
function extStatusText(x) { return { pending: '待审核', reviewing: '受理中', accepted: '已采纳', rejected: '已驳回', withdrawn: '已撤回' }[x] || x }
function extKindText(x) { return { brand: '品牌方', regulator: '监管方', media: '媒体' }[x] || x }
function extDocText(x) { return { evidence: '证据材料', rectify: '整改进度', clue: '线索反映' }[x] || x }
function formatNum(n) { return n >= 10000 ? (n / 10000).toFixed(1) + ' 万' : String(n || 0) }
function hasReport(crisisId) { return items.value.some((r) => r.crisis_id === crisisId) }

async function load() {
  try {
    const d = await store.fetchReports(filter.value ? { status: filter.value } : {})
    items.value = d.items
    summary.value = d.summary
    dict.value = d.dict
  } catch (e) { /* 后端未就绪 */ }
}
function setFilter(k) {
  filter.value = k
  load()
}
async function create() {
  if (!form.value.crisis_id) return
  const r = await store.createReport({ crisis_id: form.value.crisis_id, title: form.value.title.trim() })
  showForm.value = false
  form.value = { crisis_id: null, title: '' }
  await load()
  await open(r.id)
  subTab.value = 'edit'
}
async function toggle(r) {
  if (openId.value === r.id) { openId.value = null; detail.value = null; return }
  await open(r.id)
}
async function open(id) {
  openId.value = id
  detail.value = await store.fetchReport(id)
  subTab.value = 'edit'
  verOpen.value = null
  for (const k of Object.keys(editing)) editing[k] = false
}
function startEdit(key) { editing[key] = true; drafts[key] = detail.value[key] || '' }
function cancelEdit(r, key) { editing[key] = false; drafts[key] = r[key] || '' }
async function saveSection(r, key) {
  await store.saveReportSection(r.id, key, drafts[key] || '')
  editing[key] = false
  detail.value = await store.fetchReport(r.id)
  await load()
  savedKey.value = key
  setTimeout(() => { if (savedKey.value === key) savedKey.value = '' }, 2000)
}
async function refreshSnap(r) {
  const d = await store.refreshReportSnapshot(r.id)
  detail.value = await store.fetchReport(r.id)
  if (d.snapshot) store.msg('聚合数据已刷新', 'success')
}
async function submit(r) {
  const note = prompt('提交审核说明（可留空）：', '各章节已完成跨角色编制，请管理员审核')
  if (note === null) return
  await store.submitReport(r.id, note)
  await open(r.id)
}
async function approve(r) {
  const note = prompt('审核意见（通过并发布）：', '审核通过，同意发布并回写结案档案')
  if (note === null) return
  try { await store.approveReport(r.id, note); await open(r.id); subTab.value = 'snapshot' }
  catch (e) { store.msg(e.message, 'warn') }
}
async function reject(r) {
  const note = prompt('驳回意见（退回编制中）：', '部分章节需补充，请修改后重新提交')
  if (note === null) return
  await store.rejectReport(r.id, note)
  await open(r.id)
}
async function rollback(r) {
  const versions = r.versions || detail.value.versions
  if (!versions.length) return store.msg('暂无可回滚的归档版本', 'info')
  const latest = versions[0]
  const input = prompt(`回滚到哪个版本？可选 ${versions.map((v) => v.version).reverse().join(' / ')}（最新归档 v${latest.version}）：`, String(latest.version))
  if (input === null) return
  const version = parseInt(input, 10)
  if (!versions.some((v) => v.version === version)) return store.msg('版本号不存在', 'warn')
  const note = prompt('回滚说明（可留空）：', `回滚至 v${version} 重新编制`)
  if (note === null) return
  try {
    const rr = await store.rollbackReport(r.id, version, note)
    await open(rr.newVersion ? r.id : r.id)
  } catch (e) { store.msg(e.message, 'warn') }
}
function rollbackTo(r, v) {
  if (!confirm(`确定将报告回滚至 v${v.version}？当前工作内容会被该版本覆盖，并生成新的回滚归档版本。`)) return
  const note = prompt('回滚说明（可留空）：', `回滚至 v${v.version} 重新编制`)
  if (note === null) return
  store.rollbackReport(r.id, v.version, note).then(() => open(r.id)).catch((e) => store.msg(e.message, 'warn'))
}
function toggleVer(v) { verOpen.value = verOpen.value === v ? null : v }
function contentDiff(r, v, key) { return (v.content?.[key] || '') !== (r[key] || '') }

// 从危机卡片/回溯页跳转：无报告→展开创建表单并预填危机；已有报告→自动展开详情
watch(() => store.reportDraftCrisis, (cid) => {
  if (!cid) return
  filter.value = ''
  showForm.value = true
  form.value.crisis_id = cid
  store.reportDraftCrisis = null
  load()
}, { immediate: true })
watch(() => store.reportOpenId, (rid) => {
  if (!rid) return
  filter.value = ''
  store.reportOpenId = null
  load().then(() => open(rid))
}, { immediate: true })

let timer = null
onMounted(() => { load(); timer = setInterval(() => { if (openId.value) open(openId.value); else load() }, 8000) })
onUnmounted(() => clearInterval(timer))
</script>

<style scoped>
.rp{display:flex;flex-direction:column;gap:12px;}
.rp-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
.add{font-family:inherit;background:linear-gradient(135deg,#5e35b1,#4527a0);border:none;color:#fff;border-radius:8px;padding:9px 14px;font-size:13px;font-weight:600;cursor:pointer;}
.chips{display:flex;gap:6px;flex-wrap:wrap;}
.chip{font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#aebadd;border-radius:7px;padding:5px 11px;font-size:12px;cursor:pointer;}
.chip.on{background:#283559;color:#fff;border-color:#5c7bb8;}
.chip.draft.on{background:#4527a0;border-color:#7e57c2;}
.chip.reviewing.on{background:#b76e00;border-color:#ffa726;}
.chip.published.on{background:#1b5e20;border-color:#66bb6a;}
.chip.rev{background:#3e2f08;color:#ffcc80;border-color:rgba(255,167,38,.4);}
.me{margin-left:auto;font-size:11px;color:#8ba2c8;}
.hint{font-size:11px;color:#5b6f94;line-height:1.7;margin:0;}
.hint b{color:#90caf9;font-weight:600;}
.rp-form{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px;}
.row{display:flex;gap:8px;flex-wrap:wrap;}
input,select,textarea,button{font-family:inherit;}
.rp-form input,.rp-form select{background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:8px 10px;font-size:12px;}
.save{background:#5e35b1;border:none;color:#fff;font-weight:600;cursor:pointer;border-radius:8px;padding:8px 14px;font-size:12px;}
.save:disabled{opacity:.5;cursor:not-allowed;}
.ghost{background:#16263f;color:#8ba2c8;cursor:pointer;border:1px solid rgba(120,160,220,.2);border-radius:8px;padding:8px 14px;font-size:12px;}
.no-crisis{font-size:11px;color:#ffab91;}
.none{color:#5b6f94;text-align:center;padding:36px;}
.rp-card{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;border-left:4px solid #7e57c2;overflow:hidden;}
.rp-card.reviewing{border-left-color:#ffa726;}
.rp-card.published{border-left-color:#66bb6a;}
.r-head{display:flex;align-items:center;gap:10px;padding:13px 16px;cursor:pointer;flex-wrap:wrap;}
.st{font-size:11px;padding:3px 10px;border-radius:6px;flex:none;}
.st.draft{background:#312a55;color:#b39ddb;}.st.reviewing{background:#4a3308;color:#ffcc80;}.st.published{background:#1b5e20;color:#a5d6a7;}
.r-title{color:#fff;font-size:14px;flex:1;min-width:180px;}
.crisis-tag{font-size:10px;color:#90caf9;background:#0d2137;border:1px solid rgba(144,202,249,.25);border-radius:5px;padding:2px 8px;}
.crisis-st{font-size:10px;padding:1px 7px;border-radius:5px;}
.crisis-st.monitoring{background:#37474f;color:#b0bec5;}.crisis-st.disposal{background:#b71c1c;color:#ffcdd2;}.crisis-st.closed{background:#1b5e20;color:#a5d6a7;}
.ver-tag,.ver-count{font-size:10px;color:#8ba2c8;}
.arrow{color:#5b6f94;font-size:10px;}
.r-body{border-top:1px solid rgba(120,160,220,0.12);padding:14px 16px;display:flex;flex-direction:column;gap:12px;}
.r-meta{display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:#5b6f94;}
.r-meta i{color:#90caf9;font-style:normal;}
.work-actions{display:flex;gap:8px;flex-wrap:wrap;}
.op{border:none;border-radius:7px;padding:7px 13px;font-size:12px;font-weight:600;cursor:pointer;color:#fff;}
.op.snap{background:#455a64;}.op.submit{background:#b76e00;}.op.approve{background:#2e7d32;}.op.reject{background:#c62828;}.op.rollback{background:#6a1b9a;}
.sub-tabs{display:flex;gap:6px;border-bottom:1px solid rgba(120,160,220,.15);padding-bottom:8px;}
.sub-tabs button{background:#13233f;border:1px solid rgba(120,160,220,.2);color:#8ba2c8;border-radius:7px 7px 0 0;padding:6px 13px;font-size:12px;cursor:pointer;}
.sub-tabs button.on{background:#243357;color:#fff;border-color:#5c7bb8;}
.panel{display:flex;flex-direction:column;gap:10px;}
.chapter{background:#13233f;border:1px solid rgba(120,160,220,.12);border-radius:9px;padding:11px 13px;}
.chapter.empty{border-style:dashed;}
.ch-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:7px;}
.ch-head b{color:#ce93d8;font-size:12px;}
.ch-who{font-size:10px;color:#5b6f94;}
.ch-who.none-who{color:#4a5a7a;}
.mini{margin-left:auto;background:#26355c;border:1px solid rgba(120,160,220,.3);color:#bbdefb;border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer;}
.save-mini{background:#2e7d32;border-color:#66bb6a;color:#fff;margin-left:0;}
.ghost-mini{margin-left:0;}
.saved-flash{font-size:10px;color:#81c784;}
.ch-input{width:100%;box-sizing:border-box;background:#0c1730;border:1px solid rgba(120,160,220,.25);color:#dbe4f3;border-radius:7px;padding:9px;font-size:12px;resize:vertical;line-height:1.7;}
.ch-text{margin:0;color:#aebadd;font-size:12px;line-height:1.8;white-space:pre-wrap;font-family:inherit;}
.snap-time{font-size:11px;color:#8ba2c8;background:#0c1a30;border:1px dashed rgba(120,160,220,.2);border-radius:7px;padding:7px 11px;}
.snap-tip{color:#5b6f94;}
.snap-sec{background:#13233f;border-radius:9px;padding:12px;}
.snap-sec h5{margin:0 0 9px;color:#ffd54f;font-size:12px;}
.mini-stats{display:flex;gap:8px;margin-bottom:9px;}
.mini-stats div{background:#0c1730;border-radius:7px;padding:6px 14px;text-align:center;display:flex;flex-direction:column;}
.mini-stats b{color:#fff;font-size:16px;}.mini-stats em{font-size:10px;color:#5b6f94;font-style:normal;}
.mini-stats b.ok{color:#81c784;}.mini-stats b.warn-num{color:#ffab91;}
.rule-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:9px;}
.rule-pill{font-size:10px;padding:2px 9px;border-radius:5px;background:#0d2137;border:1px solid rgba(144,202,249,.25);color:#90caf9;display:inline-flex;gap:6px;align-items:center;}
.rule-pill.red{color:#ef9a9a;border-color:rgba(239,83,80,.4);}.rule-pill.orange{color:#ffcc80;border-color:rgba(255,152,0,.4);}.rule-pill.yellow{color:#ffe082;border-color:rgba(255,213,79,.4);}
.rule-pill i{font-style:normal;color:#5b6f94;}
.snap-list{display:flex;flex-direction:column;max-height:230px;overflow-y:auto;}
.snap-item{display:flex;align-items:center;gap:9px;padding:6px 0;border-bottom:1px dashed rgba(120,160,220,.08);font-size:11px;flex-wrap:wrap;}
.snap-item:last-child{border-bottom:none;}
.snap-item.resolved{opacity:.62;}
.snap-item b{color:#dbe4f3;font-weight:600;}
.snap-item span{color:#8ba2c8;}
.snap-item em{color:#5b6f94;font-style:normal;font-size:10px;margin-left:auto;}
.dot{width:8px;height:8px;border-radius:50%;flex:none;}
.dot.red{background:#ef5350;}.dot.orange{background:#ff9800;}.dot.yellow{background:#ffd54f;}
.tag{font-size:9px;font-style:normal;padding:1px 7px;border-radius:4px;flex:none;}
.ok-tag{background:#1b5e20;color:#a5d6a7;}.warn-tag{background:#3e2723;color:#ffab91;}
.tl-mini{border-left:2px solid #243357;padding-left:13px;display:flex;flex-direction:column;gap:6px;max-height:240px;overflow-y:auto;}
.tl-mini-item{position:relative;font-size:11px;display:flex;flex-direction:column;gap:1px;}
.tl-dot{position:absolute;left:-18px;top:4px;width:8px;height:8px;border-radius:50%;background:#78909c;}
.tl-mini-item b{color:#dbe4f3;}
.tl-mini-item span{color:#8ba2c8;}
.tl-mini-item em{color:#5b6f94;font-size:10px;font-style:normal;}
.snap-empty{font-size:11px;color:#5b6f94;padding:6px 0;}
.path-card{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:#0c1730;border-radius:7px;padding:8px 11px;font-size:11px;color:#aebadd;margin-bottom:6px;border-left:3px solid #546e7a;}
.path-card.outbreak{border-left-color:#ef5350;}.path-card.ferment{border-left-color:#ffb300;}.path-card.decline{border-left-color:#78909c;}
.path-card b{color:#dbe4f3;}
.path-card .hot{color:#ef9a9a;font-weight:600;}
.p-stage{font-size:10px;padding:1px 8px;border-radius:5px;}
.p-stage.seed{background:#37474f;color:#cfd8dc;}.p-stage.ferment{background:#33270e;color:#ffe082;}
.p-stage.outbreak{background:#4a1518;color:#ef9a9a;}.p-stage.decline{background:#263238;color:#b0bec5;}
.wo-card-snap{display:flex;align-items:center;gap:9px;flex-wrap:wrap;background:#0c1730;border-radius:7px;padding:7px 11px;font-size:11px;color:#aebadd;margin-bottom:5px;}
.wo-card-snap b{color:#dbe4f3;}
.wo-dlv{color:#80cbc4;background:#0c2622;border:1px solid rgba(38,166,154,.3);border-radius:5px;padding:1px 8px;font-size:10px;}
.wo-result{color:#81c784;}
.stmt-snap{background:#0c1a30;border:1px solid rgba(38,166,154,.2);border-left:3px solid #26a69a;border-radius:7px;padding:8px 11px;margin-bottom:6px;display:flex;flex-direction:column;gap:6px;}
.stmt-snap.review{border-left-color:#ffb300;}.stmt-snap.published{border-left-color:#66bb6a;}.stmt-snap.cancelled{border-left-color:#616161;opacity:.8;}
.stmt-snap-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:#8ba2c8;}
.stmt-snap-head b{color:#dbe4f3;}
.stmt-wo{color:#80cbc4;font-size:10px;}
.tag.stmtst-draft{background:#263238;color:#b0bec5;}.tag.stmtst-review{background:#33270e;color:#ffe082;}
.tag.stmtst-approved{background:#0d2137;color:#90caf9;}.tag.stmtst-publishing{background:#08303a;color:#80deea;}
.tag.stmtst-partial{background:#4e2310;color:#ffab91;}
.tag.stmtst-published{background:#1b5e20;color:#a5d6a7;}.tag.stmtst-cancelled{background:#21262c;color:#78909c;}
.stmt-snap.partial{border-left:3px solid #ff7043;}
.stmt-chs{display:flex;gap:6px;flex-wrap:wrap;}
.stmt-ch{font-size:10px;padding:2px 9px;border-radius:5px;background:#0d2137;border:1px solid rgba(120,160,220,.2);color:#b0bec5;display:inline-flex;gap:5px;align-items:center;}
.stmt-ch i{font-style:normal;}
.stmt-ch.success{color:#a5d6a7;border-color:rgba(102,187,106,.4);}.stmt-ch.failed{color:#ef9a9a;border-color:rgba(239,83,80,.4);}
.stmt-ch.publishing{color:#90caf9;border-color:rgba(66,165,245,.4);}.stmt-ch.cancelled{color:#78909c;}
.stmt-note{font-size:10px;color:#ce93d8;}
.ext-snap{background:#0c1a30;border:1px solid rgba(142,36,170,.22);border-left:3px solid #8e24aa;border-radius:7px;padding:8px 11px;margin-bottom:6px;display:flex;flex-direction:column;gap:5px;}
.ext-snap.accepted{border-left-color:#66bb6a;}.ext-snap.rejected{border-left-color:#ab47bc;}.ext-snap.withdrawn{border-left-color:#616161;opacity:.8;}
.ext-snap-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:#8ba2c8;}
.ext-snap-head b{color:#dbe4f3;}
.ext-snap-head .code{font-family:monospace;color:#ce93d8;background:#1a1030;border-radius:5px;padding:0 6px;}
.ext-urgent{color:#fff;background:#c62828;border-radius:8px;padding:0 7px;font-weight:700;}
.ext-who{color:#aebadd;}
.ext-snap-meta{font-size:10px;color:#8ba2c8;}
.ext-note{font-size:10px;color:#a5d6a7;}.ext-note.reject{color:#ce93d8;}
.st-todo{background:#37474f;color:#cfd8dc;}.st-doing{background:#0d47a1;color:#bbdefb;}.st-blocked{background:#4e342e;color:#ffcc80;}
.st-done{background:#1b5e20;color:#a5d6a7;}.st-cancelled{background:#263238;color:#90a4ae;}
.nt-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:9px;}
.nt-pill{font-size:10px;padding:2px 9px;border-radius:5px;background:#0d2137;color:#90caf9;border:1px solid rgba(144,202,249,.2);}
.nt-pill.acked{color:#a5d6a7;border-color:rgba(102,187,106,.4);}.nt-pill.escalated{color:#ef9a9a;border-color:rgba(239,83,80,.4);}
.nt-pill.failed{color:#ffab91;border-color:rgba(255,138,101,.4);}
.nt-dot{width:7px;height:7px;border-radius:50%;flex:none;background:#78909c;}
.nt-dot.acked{background:#66bb6a;}.nt-dot.escalated{background:#ef5350;}.nt-dot.failed{background:#ff9800;}
.ack{color:#a5d6a7;}
.closure-snap{background:#0c1730;border-left:3px solid #66bb6a;border-radius:7px;padding:8px 11px;font-size:11px;display:flex;flex-direction:column;gap:2px;margin-bottom:6px;}
.closure-snap.rolled{border-left-color:#ffb300;opacity:.85;}
.closure-snap span{color:#8ba2c8;}.closure-snap em{color:#5b6f94;font-style:normal;font-size:10px;}
.report-tag{background:#2e1a52;color:#ce93d8;border:1px solid rgba(206,147,216,.35);align-self:flex-start;}
.ver-row{background:#13233f;border:1px solid rgba(120,160,220,.12);border-radius:9px;}
.ver-main{display:flex;align-items:center;gap:10px;padding:10px 13px;cursor:pointer;flex-wrap:wrap;font-size:12px;}
.ver-no{color:#fff;font-weight:700;background:#283559;border-radius:6px;padding:2px 9px;}
.ver-kind{font-size:10px;padding:2px 8px;border-radius:5px;}
.ver-kind.submit{background:#4527a0;color:#b39ddb;}.ver-kind.publish{background:#1b5e20;color:#a5d6a7;}.ver-kind.rollback{background:#6a1b9a;color:#e1bee7;}
.ver-main b{color:#dbe4f3;font-weight:600;flex:1;min-width:150px;}
.ver-op{color:#5b6f94;font-size:10px;}
.ver-actions{display:flex;}
.rollback-mini{background:#4a148c;border:1px solid #7b1fa2;color:#fff;margin-left:0;}
.ver-detail{border-top:1px dashed rgba(120,160,220,.15);padding:10px 13px;display:flex;flex-direction:column;gap:8px;}
.ver-source{font-size:10px;color:#ce93d8;}
.ver-ch{background:#0c1730;border-radius:7px;padding:8px 11px;}
.ver-ch.diff{border:1px solid rgba(255,179,0,.35);}
.ver-ch b{font-size:11px;color:#90caf9;display:flex;align-items:center;gap:8px;margin-bottom:4px;}
.diff-tag{font-size:9px;font-style:normal;background:#4a3308;color:#ffcc80;border-radius:4px;padding:1px 6px;}
.ver-ch pre{margin:0;color:#aebadd;font-size:11px;line-height:1.7;white-space:pre-wrap;font-family:inherit;}
.log-row{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px dashed rgba(120,160,220,.08);font-size:11px;flex-wrap:wrap;}
.log-act{font-size:10px;padding:2px 8px;border-radius:5px;background:#26355c;color:#bbdefb;flex:none;}
.log-act.submit{background:#4527a0;color:#d1c4e9;}.log-act.approve{background:#1b5e20;color:#a5d6a7;}
.log-act.reject{background:#b71c1c;color:#ffcdd2;}.log-act.rollback{background:#6a1b9a;color:#e1bee7;}
.log-detail{color:#aebadd;flex:1;min-width:160px;}
.log-row em{color:#5b6f94;font-style:normal;font-size:10px;}
</style>
