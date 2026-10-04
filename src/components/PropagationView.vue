<template>
  <div class="prop">
    <div class="p-toolbar">
      <button v-if="canOps" class="add" @click="openCreate">＋ 新建传播路径</button>
      <div class="chips">
        <button class="chip" :class="{on:!stage && !crisisFilter}" @click="setStage('')">全部 {{ summary.total||0 }}</button>
        <button v-for="(txt,k) in dict.stage" :key="k" class="chip" :class="[k,{on:stage===k && !crisisFilter}]" @click="setStage(k)">
          {{ txt }} {{ summary.counts?.[k]||0 }}
        </button>
        <button v-if="crisisFilter" class="chip crisis-filter on" @click="clearCrisisFilter">🛟 仅看危机 #{{ crisisFilter }} ✕</button>
      </div>
      <span class="me">👤 {{ store.user.name }} · {{ roleText(store.user.role) }}</span>
    </div>
    <p class="hint">
      🔗 沉淀话题的<b>来源、节点、转发关系与影响阶段</b>：潜伏期 → 发酵期 → 爆发期（节点/热度/KOL 阈值自动推进，可标记回落）；
      关联预警规则与危机事件，按传播变化（爆发/激增/KOL）<b>触发通知</b>，爆发期可自动<b>生成跨角色处置工单</b>。
    </p>

    <!-- 新建路径 -->
    <form v-if="showCreate" class="p-form" @submit.prevent="create">
      <div class="row">
        <input v-model="cform.title" placeholder="路径标题，如 某品牌食安事件传播链" required />
        <input v-model="cform.topic" list="prop-topics" placeholder="归并话题（同危机/预警口径）" />
        <datalist id="prop-topics"><option v-for="t in topics" :key="t" :value="t" /></datalist>
      </div>
      <div class="row">
        <input v-model="cform.root_name" placeholder="首发来源名称（如 澎湃新闻）" />
        <input v-model="cform.channel" placeholder="来源渠道（新闻/微博…）" />
        <select v-model.number="cform.origin_post_id">
          <option :value="null">首条来源舆情（可不选）</option>
          <option v-for="p in recentPosts" :key="p.id" :value="p.id">#{{ p.id }} {{ p.title.slice(0,18) }}</option>
        </select>
      </div>
      <div class="row">
        <select v-model.number="cform.crisis_id">
          <option :value="null">关联危机（留空=按话题自动并入未结案事件）</option>
          <option v-for="c in store.crises" :key="c.id" :value="c.id">#{{ c.id }} {{ c.title }}</option>
        </select>
        <select v-model.number="cform.alert_id">
          <option :value="null">来源预警规则（可不选）</option>
          <option v-for="a in alertRules" :key="a.id" :value="a.id">{{ a.title }}</option>
        </select>
        <label class="auto-wo"><input type="checkbox" v-model="cform.auto_wo" /> 爆发期自动生成处置工单</label>
      </div>
      <div class="row">
        <button class="save" type="submit">建档</button>
        <button type="button" class="ghost" @click="showCreate=false">取消</button>
      </div>
    </form>

    <div v-if="!items.length" class="none">暂无传播路径（点击「新建传播路径」开始沉淀来源与转发关系）</div>

    <div class="p-list">
      <div v-for="p in items" :key="p.id" class="p-card" :class="p.stage">
        <div class="p-head">
          <span class="stage-tag" :class="p.stage">{{ p.stageText }}</span>
          <b class="p-title">{{ p.title }}</b>
          <span class="p-id">#{{ p.id }}</span>
          <span class="p-status" :class="p.status">{{ p.status==='active' ? '● 监测中' : '○ 已停用' }}</span>
          <button v-if="isAdmin" class="del" @click="del(p)">✕</button>
        </div>
        <div class="p-meta">
          <span>话题 <i>#{{ p.topic||'—' }}</i></span>
          <span>节点 <i>{{ p.nodeCount }}</i></span>
          <span>KOL <i :class="{hot:p.kolCount}">{{ p.kolCount }}</i></span>
          <span>峰值热度 <i :class="{hot:p.heat>=60}">{{ p.heat }}</i></span>
          <span>触达 <i>{{ reachText(p.reach) }}</i></span>
          <span>转发 <i>{{ p.reposts.toLocaleString() }}</i></span>
          <span>传播层级 <i>{{ p.maxDepth }}</i></span>
        </div>
        <div class="p-tags">
          <span v-if="p.crisis" class="tag crisis">🛟 #{{ p.crisis.id }} {{ p.crisis.title }}（{{ crisisText(p.crisis.status) }}）</span>
          <span v-else class="tag none-crisis">未关联危机</span>
          <span v-for="a in p.alerts" :key="a.alert_id" class="tag alert" :class="a.alert_level">
            🚨 {{ a.alert_title }}<em v-if="a.is_origin">·源</em>
          </span>
          <span v-if="p.woCount" class="tag wo">📋 处置工单 {{ p.woCount }}</span>
          <span class="tag auto-wo">{{ p.auto_wo ? '⚡爆发自动工单：开' : '⚡爆发自动工单：关' }}</span>
        </div>

        <!-- 展开详情：传播图 + 操作 + 留痕 -->
        <div class="p-body" v-if="openId===p.id">
          <div class="graph-wrap">
            <div class="graph-legend">
              <span><i class="lg root"></i>首发来源</span><span><i class="lg media"></i>媒体</span>
              <span><i class="lg kol"></i>头部账号</span><span><i class="lg node"></i>传播节点</span>
            </div>
            <svg :viewBox="`0 0 ${graphBox(p).w} ${graphBox(p).h}`" class="graph" v-if="p.nodes && p.nodes.length">
              <defs>
                <marker :id="`arr-${p.id}`" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L7,3 L0,6 Z" fill="#5b7fb5" />
                </marker>
              </defs>
              <path v-for="(e,i) in graphEdges(p)" :key="'e'+i" :d="edgePath(e)" class="edge"
                :class="{hot:e.effHeat>=60}" :marker-end="`url(#arr-${p.id})`" />
              <g v-for="n in graphNodes(p)" :key="n.id" :transform="`translate(${n.x},${n.y})`">
                <rect :width="nodeW(n)" :height="NODE_H" rx="8" class="node-rect" :class="n.kind" />
                <text :x="nodeW(n)/2" :y="17" class="n-name" text-anchor="middle">{{ n.name }}</text>
                <text :x="nodeW(n)/2" :y="33" class="n-sub" text-anchor="middle">
                  {{ n.kindText }}{{ n.channel ? ' · '+n.channel : '' }}{{ n.kind==='kol' ? ' · '+followersText(n.followers) : '' }}
                </text>
              </g>
            </svg>
            <div v-else class="none">暂无节点（记录首条转发关系后生成传播图）</div>
          </div>

          <!-- 转发关系明细 -->
          <div class="edges-box">
            <h6>🔁 转发关系（{{ p.edges ? p.edges.length : 0 }}）</h6>
            <div class="edge-rows">
              <div v-for="e in (p.edges||[]) .slice().reverse()" :key="e.id" class="edge-row" :class="{hot:e.effHeat>=60}">
                <span class="e-from">{{ e.from ? e.from.name : '🟠 原创首发' }}</span>
                <span class="e-arrow">→</span>
                <span class="e-to">{{ e.to.name }} <i v-if="e.to.kind==='kol'" class="kol-flag">KOL</i></span>
                <span class="e-stat">🔁{{ e.reposts.toLocaleString() }} · 👁{{ reachText(e.reach) }} · 🔥{{ e.effHeat }}</span>
                <em class="e-time">{{ e.time.slice(5) }}</em>
              </div>
              <div v-if="!p.edges || !p.edges.length" class="none">暂无转发关系</div>
            </div>
          </div>

          <!-- 操作区 -->
          <div class="p-actions" v-if="canOps && p.status==='active'">
            <button class="op edge" @click="openEdge(p)">＋ 记录转发</button>
            <button class="op crisis" @click="bindCrisis(p)">🔗 关联危机</button>
            <button class="op alert" @click="attachAlert(p)">🚨 关联预警</button>
            <button class="op wo" @click="openWo(p)">📋 生成处置工单</button>
            <button v-if="p.stage!=='decline'" class="op decline" @click="decline(p)">📉 标记回落</button>
            <button class="op toggle" @click="toggleActive(p)">{{ p.auto_wo ? '⚡关闭爆发自动工单' : '⚡开启爆发自动工单' }}</button>
          </div>

          <!-- 变化留痕 -->
          <div class="logs-box">
            <h6>🕒 传播变化留痕</h6>
            <div class="clog" v-for="l in (p.logs||[])" :key="l.id">
              <span class="l-act" :class="logClass(l.action)">{{ logText(l.action) }}</span>
              <span class="l-detail">{{ l.detail }}</span>
              <em>{{ l.operator }} · {{ l.time.slice(5) }}</em>
            </div>
          </div>
        </div>

        <button class="expand" @click="toggle(p)">{{ openId===p.id ? '▲ 收起' : '▼ 展开传播图与处置' }}</button>
      </div>
    </div>

    <!-- 记录转发弹窗 -->
    <div v-if="edgeForm.pathId" class="modal-mask" @click.self="edgeForm.pathId=null">
      <form class="modal" @submit.prevent="submitEdge">
        <h4>🔁 记录转发 / 引用关系</h4>
        <p class="modal-hint">转发者（目标节点）必填；来源节点可留空表示原创。同名节点自动合并。<b>高热度/KOL 转发会自动推进影响阶段。</b></p>
        <div class="row">
          <select v-model.number="edgeForm.to_node_id">
            <option :value="0">— 新节点（在下方填写）—</option>
            <option v-for="n in edgeForm.nodes" :key="n.id" :value="n.id">{{ n.name }}（{{ n.kindText }}）</option>
          </select>
          <select v-model="edgeForm.kind">
            <option value="node">普通节点</option>
            <option value="media">媒体</option>
            <option value="kol">头部账号 KOL</option>
          </select>
        </div>
        <div class="row">
          <input v-model="edgeForm.to_name" placeholder="目标节点名称（新节点必填）" />
          <input v-model="edgeForm.channel" placeholder="渠道" />
          <input v-model.number="edgeForm.followers" type="number" placeholder="粉丝量（KOL 参考）" />
        </div>
        <div class="row">
          <select v-model.number="edgeForm.from_node_id">
            <option :value="null">— 无上游（原创首发）—</option>
            <option v-for="n in edgeForm.nodes" :key="'f'+n.id" :value="n.id">转发自：{{ n.name }}</option>
          </select>
          <select v-model.number="edgeForm.post_id">
            <option :value="null">对应舆情（可不选）</option>
            <option v-for="pp in recentPosts" :key="pp.id" :value="pp.id">#{{ pp.id }} {{ pp.title.slice(0,16) }}</option>
          </select>
        </div>
        <div class="row">
          <input v-model.number="edgeForm.reposts" type="number" placeholder="转发量" />
          <input v-model.number="edgeForm.comments" type="number" placeholder="评论" />
          <input v-model.number="edgeForm.likes" type="number" placeholder="点赞" />
          <input v-model.number="edgeForm.reach" type="number" placeholder="触达人次" />
          <input v-model.number="edgeForm.heat" type="number" min="0" max="100" placeholder="热度0-100" />
        </div>
        <input v-model="edgeForm.note" placeholder="备注（如 大V转发冲热搜）" />
        <div class="modal-btns">
          <button class="save" type="submit">记录并重算阶段</button>
          <button type="button" class="ghost" @click="edgeForm.pathId=null">取消</button>
        </div>
      </form>
    </div>

    <!-- 生成工单弹窗 -->
    <div v-if="woForm.pathId" class="modal-mask" @click.self="woForm.pathId=null">
      <form class="modal" @submit.prevent="submitWo">
        <h4>📋 从传播路径拆分跨角色处置工单</h4>
        <div class="row">
          <select v-model="woForm.category">
            <option value="pr">公关口径</option><option value="legal">法务合规</option>
            <option value="ops">现场运营</option><option value="support">客诉跟进</option><option value="other">其他</option>
          </select>
          <select v-model="woForm.priority">
            <option value="urgent">紧急</option><option value="high" selected>高</option><option value="normal">普通</option>
          </select>
          <input v-model.number="woForm.sla_min" type="number" min="0" placeholder="SLA 分钟（0=无时限）" />
        </div>
        <input v-model="woForm.title" placeholder="工单标题（留空=自动按路径生成）" />
        <textarea v-model="woForm.detail" placeholder="任务说明（留空=自动按阶段指标生成）"></textarea>
        <div class="row">
          <input v-model="woForm.assignee" placeholder="处理人（留空=待分派，可认领）" />
          <select v-model="woForm.assignee_role">
            <option value="">职能团队</option>
            <option value="pr">公关</option><option value="legal">法务</option>
            <option value="ops">运营</option><option value="support">客服</option><option value="admin">协调组</option>
          </select>
        </div>
        <div class="modal-btns">
          <button class="save" type="submit">拆分工单</button>
          <button type="button" class="ghost" @click="woForm.pathId=null">取消</button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { usePubStore } from '@/store/pub'

const store = usePubStore()
const items = ref([])
const summary = ref({ counts: {} })
const dict = ref({ stage: {}, nodeKind: {} })
const stage = ref('')
const crisisFilter = ref(null)
const openId = ref(null)
const showCreate = ref(false)
const topics = ref([])
const recentPosts = ref([])
const alertRules = ref([])

const cform = ref({ title: '', topic: '', root_name: '', channel: '', origin_post_id: null, crisis_id: null, alert_id: null, auto_wo: true })
const edgeForm = ref({ pathId: null, nodes: [] })
const woForm = ref({ pathId: null })

const canOps = computed(() => ['admin', 'ops'].includes(store.user.role))
const isAdmin = computed(() => store.user.role === 'admin')
function roleText(r) { return { admin: '管理员', ops: '值班员', viewer: '观察员' }[r] || r }
function crisisText(s) { return { monitoring: '监测中', disposal: '处置中', closed: '已结案' }[s] || s }
function reachText(n) {
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿'
  if (n >= 10000) return (n / 10000).toFixed(n >= 1000000 ? 0 : 1) + 'w'
  return String(n)
}
function followersText(n) { return n >= 10000 ? (n / 10000).toFixed(n >= 1000000 ? 0 : 0) + 'w粉' : n + '粉' }
function logText(a) {
  return { 建档: '建档', 转发: '转发', 阶段推进: '阶段', 关联预警: '关联预警', 关联危机: '关联危机',
    回落: '回落', 自动工单: '自动工单', 工单拆分: '工单', 编辑: '编辑' }[a] || a
}
function logClass(a) {
  if (a.includes('阶段')) return 'stage'
  if (a.includes('工单')) return 'wo'
  if (a.includes('关联')) return 'link'
  if (a.includes('回落')) return 'decline'
  return ''
}

async function load() {
  const qs = {}
  if (stage.value) qs.stage = stage.value
  if (crisisFilter.value) qs.crisis_id = crisisFilter.value
  const d = await store.fetchProp(Object.keys(qs).length ? qs : null)
  items.value = d.items
  summary.value = d.summary
  dict.value = d.dict
  if (openId.value) {
    const fresh = await store.fetchPropPath(openId.value).catch(() => null)
    if (fresh) {
      const idx = items.value.findIndex((x) => x.id === openId.value)
      if (idx >= 0) items.value[idx] = fresh
    }
  }
}
function setStage(k) { stage.value = k; load() }
function clearCrisisFilter() { crisisFilter.value = null; store.propCrisisFilter = null; load() }
async function toggle(p) {
  if (openId.value === p.id) { openId.value = null; return }
  openId.value = p.id
  const full = await store.fetchPropPath(p.id)
  const idx = items.value.findIndex((x) => x.id === p.id)
  if (idx >= 0) items.value[idx] = full
}

function openCreate() {
  showCreate.value = true
  store.fetchTopics().then((t) => { topics.value = t }).catch(() => {})
  store.fetchPosts({ limit: 30 }).then((ps) => { recentPosts.value = ps.slice(0, 30) }).catch(() => {})
  store.fetchAlerts().then((d) => { alertRules.value = d.alerts }).catch(() => {})
}
async function create() {
  try {
    const f = { ...cform.value }
    const r = await store.createProp(f)
    cform.value = { title: '', topic: '', root_name: '', channel: '', origin_post_id: null, crisis_id: null, alert_id: null, auto_wo: true }
    showCreate.value = false
    openId.value = r.id
    await load()
  } catch (e) { store.msg(e.message, 'warn') }
}
async function del(p) {
  if (!confirm(`删除传播路径「${p.title}」？\n节点/转发关系/留痕将清除，来源工单保留。`)) return
  try { await store.deleteProp(p.id); if (openId.value === p.id) openId.value = null }
  catch (e) { store.msg(e.message, 'warn') }
}

function openEdge(p) {
  edgeForm.value = {
    pathId: p.id, nodes: p.nodes || [],
    to_node_id: 0, to_name: '', kind: 'node', channel: '', followers: '',
    from_node_id: null, post_id: null, reposts: '', comments: '', likes: '', reach: '', heat: '', note: ''
  }
  if (!recentPosts.length) store.fetchPosts({ limit: 30 }).then((ps) => { recentPosts.value = ps.slice(0, 30) }).catch(() => {})
}
async function submitEdge() {
  const f = edgeForm.value
  if (!f.to_node_id && !f.to_name.trim()) { store.msg('请选择已有节点或填写新节点名称', 'warn'); return }
  const body = {
    to_node_id: f.to_node_id || undefined, to_name: f.to_name || undefined, kind: f.kind,
    channel: f.channel, followers: f.followers || undefined,
    from_node_id: f.from_node_id || undefined, post_id: f.post_id || undefined,
    reposts: f.reposts || 0, comments: f.comments || 0, likes: f.likes || 0, reach: f.reach || 0,
    heat: f.heat || 0, note: f.note
  }
  edgeForm.value = { pathId: null, nodes: [] }
  try {
    const r = await store.addProp(f.pathId, body)
    if (r.duplicate) store.msg('该转发关系已记录（幂等去重），未重复入库', 'info')
    else {
      const msgs = []
      if (r.advanced) msgs.push(`影响阶段推进至「${({ seed: '潜伏期', ferment: '发酵期', outbreak: '爆发期', decline: '回落期' })[r.stage]}」`)
      if ((r.events || []).includes('outbreak')) msgs.push('已触发爆发升级通知')
      if ((r.events || []).includes('surge')) msgs.push('热度激增，已触发异动通知')
      if ((r.events || []).includes('kol')) msgs.push('KOL 加入，已触发异动通知')
      if (r.workOrderId) msgs.push(`已自动生成跨角色处置工单 #${r.workOrderId}`)
      store.msg(msgs.length ? '🔔 ' + msgs.join('；') : '转发关系已记录', msgs.length ? 'warn' : 'success')
    }
    await load()
  } catch (e) { store.msg(e.message, 'warn'); edgeForm.value = { pathId: f.pathId, nodes: f.nodes } }
}

function openWo(p) {
  if (!p.crisis) { store.msg('该路径尚未关联危机事件，请先关联后再拆分工单', 'warn'); return }
  woForm.value = { pathId: p.id, category: 'pr', priority: 'high', sla_min: 60, title: '', detail: '', assignee: '', assignee_role: '' }
}
async function submitWo() {
  const f = woForm.value
  const id = f.pathId
  woForm.value = { pathId: null }
  try {
    await store.createPropWorkOrder(id, {
      category: f.category, priority: f.priority, sla_min: f.sla_min || 0,
      title: f.title, detail: f.detail, assignee: f.assignee, assignee_role: f.assignee_role
    })
    await load()
  } catch (e) { store.msg(e.message, 'warn'); woForm.value = { ...f, pathId: id } }
}

async function bindCrisis(p) {
  const id = prompt(`关联危机事件 id（输入空值解除关联）。可用：\n${store.crises.map((c) => `#${c.id} ${c.title}`).join('\n')}`, p.crisis_id || '')
  if (id === null) return
  try {
    await store.bindPropCrisis(p.id, id.trim() ? +id.trim() : null)
    store.msg(id.trim() ? '已关联危机事件，时间线已回写' : '已解除危机关联', 'success')
    await load()
  } catch (e) { store.msg(e.message, 'warn') }
}
async function attachAlert(p) {
  if (!alertRules.length) { try { const d = await store.fetchAlerts(); alertRules.value = d.alerts } catch { return } }
  const id = prompt(`关联预警规则 id：\n${alertRules.value.map((a) => `#${a.id} ${a.title}`).join('\n')}`)
  if (id === null || !id.trim()) return
  try {
    await store.attachPropAlert(p.id, +id.trim(), false)
    store.msg('已关联预警规则（该规则后续触发将自动挂接）', 'success')
    await load()
  } catch (e) { store.msg(e.message, 'warn') }
}
async function decline(p) {
  const note = prompt(`标记「${p.title}」进入回落期：\n说明（可留空，如 官方回应后讨论降温）：`)
  if (note === null) return
  try {
    await store.declineProp(p.id, note.trim())
    store.msg('已标记回落期（如再次达到爆发阈值可二次爆发）', 'success')
    await load()
  } catch (e) { store.msg(e.message, 'warn') }
}
async function toggleActive(p) {
  try {
    await store.updateProp(p.id, { auto_wo: !p.auto_wo })
    store.msg(p.auto_wo ? '已关闭爆发自动工单' : '已开启爆发自动工单', 'info')
    await load()
  } catch (e) { store.msg(e.message, 'warn') }
}

// ===== SVG 传播图布局：按 BFS 层级分列，层内纵向排布 =====
const NODE_W = 150
const NODE_H = 42
const COL_GAP = 70
const ROW_GAP = 24
function graphLayout(p) {
  const nodes = p.nodes || []
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const incoming = new Map() // node -> 上游
  const outAdj = new Map()
  for (const e of (p.edges || [])) {
    if (e.from_node_id && byId.has(e.from_node_id) && byId.has(e.to_node_id)) {
      if (!incoming.has(e.to_node_id)) incoming.set(e.to_node_id, new Set())
      incoming.get(e.to_node_id).add(e.from_node_id)
      if (!outAdj.has(e.from_node_id)) outAdj.set(e.from_node_id, [])
      outAdj.get(e.from_node_id).push(e.to_node_id)
    }
  }
  // 层级：root=0，其余按最长上游链；无上游的非 root 节点放到第 0 列末尾（作为补充来源）
  const level = new Map()
  const roots = nodes.filter((n) => n.kind === 'root')
  for (const r of roots) level.set(r.id, 0)
  // 多轮松弛计算最长路径
  for (let pass = 0; pass < nodes.length + 2; pass++) {
    for (const e of (p.edges || [])) {
      if (!e.from_node_id || !byId.has(e.from_node_id)) continue
      const fl = level.get(e.from_node_id)
      if (fl != null) level.set(e.to_node_id, Math.max(level.get(e.to_node_id) ?? -1, fl + 1))
    }
  }
  const orphan = nodes.filter((n) => level.get(n.id) == null)
  orphan.forEach((n) => level.set(n.id, 0))
  // 分列并稳定排序（root 在前，KOL 优先）
  const cols = new Map()
  for (const n of nodes) {
    const lv = level.get(n.id) ?? 0
    if (!cols.has(lv)) cols.set(lv, [])
    cols.get(lv).push(n)
  }
  for (const arr of cols.values()) {
    arr.sort((a, b) => {
      if ((a.kind === 'root') !== (b.kind === 'root')) return a.kind === 'root' ? -1 : 1
      const ka = a.kind === 'kol' ? 0 : 1, kb = b.kind === 'kol' ? 0 : 1
      if (ka !== kb) return ka - kb
      return a.id - b.id
    })
  }
  const maxRows = Math.max(0, ...[...cols.values()].map((a) => a.length))
  const positioned = []
  const maxLv = Math.max(0, ...cols.keys())
  for (const [lv, arr] of cols) {
    arr.forEach((n, i) => {
      positioned.push({ ...n, x: 20 + lv * (NODE_W + COL_GAP), y: 16 + i * (NODE_H + ROW_GAP), lv })
    })
  }
  return { positioned, maxLv, maxRows, byId, outAdj, w: 40 + (maxLv + 1) * NODE_W + maxLv * COL_GAP, h: 32 + maxRows * (NODE_H + ROW_GAP) }
}
function graphNodes(p) { return graphLayout(p).positioned }
function graphBox(p) { const l = graphLayout(p); return { w: Math.max(320, l.w), h: Math.max(120, l.h) } }
function nodeW() { return NODE_W }
function graphEdges(p) {
  const l = graphLayout(p)
  const pos = new Map(l.positioned.map((n) => [n.id, n]))
  const out = []
  for (const e of (p.edges || [])) {
    const from = e.from_node_id ? pos.get(e.from_node_id) : null
    const to = pos.get(e.to_node_id)
    if (!to) continue
    out.push({ ...e, from, to })
  }
  return out
}
function edgePath(e) {
  if (!e.from) return ''
  const x1 = e.from.x + NODE_W
  const y1 = e.from.y + NODE_H / 2
  const x2 = e.to.x
  const y2 = e.to.y + NODE_H / 2
  const mx = (x1 + x2) / 2
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 2},${y2}`
}

let timer = null
onMounted(async () => {
  if (store.propCrisisFilter) { crisisFilter.value = store.propCrisisFilter; store.propCrisisFilter = null }
  await load()
  timer = setInterval(load, 5000) // 传播变化/通知/工单自动刷新
})
onUnmounted(() => clearInterval(timer))
</script>

<style scoped>
.prop{display:flex;flex-direction:column;gap:12px;}
.p-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.add{background:linear-gradient(135deg,#00897b,#00695c);border:none;color:#fff;border-radius:8px;padding:9px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;}
.chips{display:flex;gap:6px;flex-wrap:wrap;}
.chip{background:#0f1b38;border:1px solid rgba(120,160,220,0.18);color:#8ba2c8;border-radius:14px;padding:4px 12px;font-size:11px;cursor:pointer;font-family:inherit;}
.chip.on{border-color:#00897b;color:#fff;background:#0d2b28;}
.chip.outbreak.on{border-color:#ef5350;background:#3a1a24;}
.chip.ferment.on{border-color:#ffb300;background:#33270e;}
.chip.decline.on{border-color:#90a4ae;background:#263238;}
.chip.crisis-filter{border-color:#42a5f5;color:#bbdefb;background:#0d2137;}
.me{margin-left:auto;font-size:11px;color:#8ba2c8;background:#13233f;border:1px solid rgba(120,160,220,0.2);border-radius:8px;padding:6px 12px;}
.hint{margin:0;font-size:11px;color:#5b6f94;line-height:1.6;}
.hint b{color:#80cbc4;font-weight:600;}
.p-form{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px;}
.row{display:flex;gap:8px;flex-wrap:wrap;}
.row>*{flex:1;min-width:140px;}
input,select,textarea,button{font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:8px 10px;font-size:12px;}
textarea{resize:vertical;min-height:48px;}
.save{background:#00897b;border:none;color:#fff;font-weight:600;cursor:pointer;flex:0 1 auto;min-width:90px;}
.ghost{background:#16263f;color:#8ba2c8;cursor:pointer;flex:0 1 auto;min-width:70px;}
.auto-wo{display:flex;align-items:center;gap:5px;font-size:11px;color:#8ba2c8;flex:0 1 auto;min-width:180px;}
.auto-wo input{width:auto;}
.none{color:#5b6f94;text-align:center;padding:24px;}
.p-list{display:flex;flex-direction:column;gap:12px;}
.p-card{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-left:4px solid #546e7a;border-radius:12px;padding:13px 15px;}
.p-card.seed{border-left-color:#78909c;}.p-card.ferment{border-left-color:#ffb300;}.p-card.outbreak{border-left-color:#ef5350;}.p-card.decline{border-left-color:#607d8b;opacity:.85;}
.p-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap;}
.stage-tag{font-size:10px;font-weight:700;padding:3px 10px;border-radius:6px;flex:none;}
.stage-tag.seed{background:#37474f;color:#cfd8dc;}.stage-tag.ferment{background:#33270e;color:#ffe082;}
.stage-tag.outbreak{background:#4a1518;color:#ef9a9a;}.stage-tag.decline{background:#263238;color:#b0bec5;}
.p-title{color:#fff;font-size:14px;flex:1;min-width:160px;}
.p-id{font-size:10px;color:#5b6f94;}
.p-status{font-size:10px;color:#81c784;}
.p-status[class*="active"]{color:#81c784;}
.del{background:none;border:none;color:#ef5350;font-size:14px;cursor:pointer;}
.p-meta{display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:#5b6f94;margin:9px 0;}
.p-meta i{color:#90caf9;font-style:normal;font-weight:600;}
.p-meta i.hot{color:#ef9a9a;}
.p-tags{display:flex;gap:6px;flex-wrap:wrap;}
.tag{font-size:10px;padding:2px 8px;border-radius:5px;background:#0d2137;border:1px solid rgba(144,202,249,.25);color:#90caf9;}
.tag.none-crisis{color:#5b6f94;border-style:dashed;}
.tag.alert.red{color:#ef9a9a;border-color:rgba(239,83,80,.4);}.tag.alert.orange{color:#ffcc80;border-color:rgba(255,152,0,.4);}.tag.alert.yellow{color:#ffe082;border-color:rgba(255,213,79,.4);}
.tag.alert em{font-style:normal;color:#ffd54f;}
.tag.wo{color:#80cbc4;border-color:rgba(0,150,136,.4);}
.tag.auto-wo{color:#ffcc80;}
.p-body{margin-top:12px;border-top:1px dashed rgba(120,160,220,0.15);padding-top:12px;display:flex;flex-direction:column;gap:12px;}
.graph-wrap{background:#0c1730;border-radius:10px;padding:10px;}
.graph-legend{display:flex;gap:14px;font-size:10px;color:#8ba2c8;margin-bottom:6px;}
.graph-legend .lg{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:4px;}
.lg.root{background:#42a5f5;}.lg.media{color:transparent;background:#ab47bc;}.lg.kol{background:#ef5350;}.lg.node{background:#546e7a;}
.graph{width:100%;height:auto;max-height:340px;}
.node-rect{stroke-width:1.2;}
.node-rect.root{fill:#0d253f;stroke:#42a5f5;}.node-rect.media{fill:#2a1530;stroke:#ab47bc;}
.node-rect.kol{fill:#3a1216;stroke:#ef5350;}.node-rect.node{fill:#16263f;stroke:#546e7a;}
.n-name{fill:#e8f0ff;font-size:11px;font-weight:600;}
.n-sub{fill:#7d93ba;font-size:8px;}
.edge{fill:none;stroke:#3d5680;stroke-width:1.4;}
.edge.hot{stroke:#ef5350;stroke-width:2;}
.edges-box h6,.logs-box h6{margin:0 0 7px;color:#ffd54f;font-size:12px;}
.edge-rows{display:flex;flex-direction:column;gap:4px;max-height:170px;overflow-y:auto;}
.edge-row{display:flex;align-items:center;gap:8px;font-size:11px;background:#13233f;border-radius:7px;padding:6px 9px;flex-wrap:wrap;}
.edge-row.hot{border-left:3px solid #ef5350;}
.e-from{color:#90caf9;}.e-arrow{color:#5b6f94;}.e-to{color:#dbe4f3;font-weight:600;}
.kol-flag{font-size:8px;font-style:normal;background:#4a1518;color:#ef9a9a;border-radius:3px;padding:0 4px;margin-left:3px;}
.e-stat{color:#8ba2c8;font-size:10px;}
.e-time{margin-left:auto;color:#5b6f94;font-size:10px;font-style:normal;white-space:nowrap;}
.p-actions{display:flex;gap:7px;flex-wrap:wrap;}
.op{background:none;border:1px solid rgba(144,202,249,.35);color:#90caf9;border-radius:7px;padding:5px 11px;font-size:11px;cursor:pointer;font-family:inherit;}
.op.edge{border-color:#00897b;color:#80cbc4;}.op.alert{border-color:rgba(255,152,0,.45);color:#ffcc80;}
.op.wo{border-color:rgba(102,187,106,.5);color:#81c784;}.op.decline{border-color:rgba(144,163,178,.5);color:#b0bec5;}
.op.crisis{border-color:#42a5f5;color:#90caf9;}.op.toggle{border-color:rgba(255,213,79,.35);color:#ffe082;}
.logs-box{background:#0c1730;border-radius:10px;padding:10px;}
.clog{display:flex;align-items:baseline;gap:8px;font-size:10px;color:#8ba2c8;padding:3px 0;border-bottom:1px dashed rgba(120,160,220,0.08);}
.clog:last-child{border-bottom:none;}
.l-act{flex:none;font-size:9px;padding:1px 7px;border-radius:5px;background:#16263f;color:#90caf9;border:1px solid rgba(144,202,249,.25);}
.l-act.stage{color:#ffcc80;border-color:rgba(255,152,0,.4);}.l-act.wo{color:#81c784;border-color:rgba(102,187,106,.4);}
.l-act.link{color:#ce93d8;border-color:rgba(206,147,216,.35);}.l-act.decline{color:#b0bec5;}
.l-detail{flex:1;color:#aebadd;}
.clog em{color:#5b6f94;font-style:normal;white-space:nowrap;}
.expand{display:block;margin:10px auto 0;background:none;border:1px solid rgba(120,160,220,0.25);color:#8ba2c8;border-radius:7px;padding:4px 14px;font-size:10px;cursor:pointer;font-family:inherit;}
.modal-mask{position:fixed;inset:0;background:rgba(5,10,20,.65);z-index:60;display:grid;place-items:center;padding:20px;}
.modal{background:#0f1b38;border:1px solid rgba(120,160,220,0.3);border-radius:12px;padding:18px;width:min(680px,96vw);max-height:90vh;overflow-y:auto;display:flex;flex-direction:column;gap:9px;}
.modal h4{margin:0;color:#fff;font-size:15px;}
.modal-hint{margin:0;font-size:11px;color:#8ba2c8;line-height:1.5;}
.modal-hint b{color:#ffcc80;}
.modal-btns{display:flex;gap:9px;justify-content:flex-end;}
.modal-btns .save,.modal-btns .ghost{flex:0 0 auto;}
</style>
