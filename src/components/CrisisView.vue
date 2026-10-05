<template>
  <div class="crisis">
    <div class="toolbar">
      <button class="add" @click="showForm=!showForm">＋ 新建危机事件</button>
      <span class="loop-hint">🔗 红/橙预警按「话题 + 时间窗口」归并：多规则并发触发可承接同一事件并上调级别；统一结案守卫核验工单/声明/外部协作/复盘审核，结案联动解除预警、收口通知回执，解除幂等、结案可回滚；可拆分跨角色协同工单</span>
    </div>

    <form v-if="showForm" class="c-form" @submit.prevent="create">
      <div class="row">
        <input v-model="form.title" placeholder="事件标题" required />
        <select v-model="form.level"><option value="red">红色 · 紧急</option><option value="orange">橙色 · 较高</option><option value="yellow">黄色 · 一般</option></select>
      </div>
      <input v-model="form.topic" placeholder="归并话题（如 食品安全）" />
      <input v-model="form.keyword" placeholder="关联关键词" />
      <input v-model="form.linked_email" placeholder="联系邮箱（用于响应）" />
      <textarea v-model="form.plan" placeholder="处置方案（每行一项）"></textarea>
      <textarea v-model="form.analysis" placeholder="舆情研判分析"></textarea>
      <div class="row">
        <button class="save" type="submit">建档</button>
        <button type="button" class="ghost" @click="showForm=false">取消</button>
      </div>
    </form>

    <div v-if="!store.crises.length" class="none">暂无危机事件</div>
    <div class="list">
      <div v-for="c in store.crises" :key="c.id" class="crisis-card" :class="c.level">
        <div class="c-head">
          <span class="lv" :class="c.level">{{ lvText(c.level) }}</span>
          <b class="ct">{{ c.title }}</b>
          <span class="origin" :class="c.origin">{{ c.origin==='auto' ? '🤖 自动建档' : '✍️ 人工建档' }}</span>
          <span v-if="c.open_events" class="open-badge">🔔 未解除预警 {{ c.open_events }}</span>
          <span v-if="c.wo_total" class="wo-badge" :class="{open:c.wo_open}">📋 工单 {{ c.wo_open ? c.wo_open+' 在办 / ' : '' }}{{ c.wo_total }}</span>
          <span v-if="c.dispatch" class="dispatch-badge" :class="dispatchClass(c.dispatch)" @click="gotoWorkOrder(c)" title="查看该事件的协同工单与通知调度链路">
            🔗 调度链路<template v-if="c.dispatch.total"> · 通知 {{ c.dispatch.total }}<template v-if="c.dispatch.acked"> / 回执 {{ c.dispatch.acked }}</template><template v-if="c.dispatch.pending"> / 在途 {{ c.dispatch.pending }}</template><template v-if="c.dispatch.failed"> / 失败 {{ c.dispatch.failed }}</template><template v-if="c.dispatch.escalated"> / 回执升级 {{ c.dispatch.escalated }}</template><template v-if="c.dispatch.retries"> · 重试 {{ c.dispatch.retries }}</template></template><template v-if="c.dispatch.woEscalated"> · 工单升级 {{ c.dispatch.woEscalated }}</template><template v-else-if="c.dispatch.woOverdue"> · 工单超时 {{ c.dispatch.woOverdue }}</template>
          </span>
          <span v-if="c.prop_active" class="prop-badge" :class="{out:c.prop_outbreak}" @click="gotoProp(c)" title="查看关联的传播路径">
            🕸 传播路径 {{ c.prop_active }}{{ c.prop_outbreak ? ' · 🔥爆发 '+c.prop_outbreak : '' }}
          </span>
          <span v-if="c.report" class="report-badge" :class="c.report.status" @click="gotoReport(c)" title="查看复盘报告">
            📝 复盘报告 · {{ c.report.statusText }} v{{ c.report.current_version }}
          </span>
          <span v-if="c.statement" class="stmt-badge" :class="c.statement.status" @click="gotoStmt(c)" title="查看危机声明">
            📢 {{ c.statement.statusText }}
          </span>
          <span v-if="c.extPortal" class="ext-badge" :class="{urgent:c.extPortal.urgent}" @click="gotoExt(c)" title="查看外部协作反馈">
            🤝 外部协作<template v-if="c.extPortal.open"> · 待审 {{ c.extPortal.open }}<template v-if="c.extPortal.urgent">（⚡{{ c.extPortal.urgent }}）</template></template><template v-else> · 已采纳 {{ c.extPortal.accepted }}</template>
          </span>
          <span class="st" :class="c.status">{{ stText(c.status) }}</span>
          <button class="del" @click="del(c)">✕</button>
        </div>
        <div class="keywords">
          <span>话题 <i>#{{ c.topic||'—' }}</i></span>
          <span>关键词 <i>#{{ c.keyword||'—' }}</i></span>
          <span v-if="c.rules && c.rules.length" class="rules-chip">
            承接规则
            <i v-for="r in c.rules" :key="r.alert_id" class="rule-chip" :class="r.alert_level">{{ r.alert_title }}{{ r.is_origin ? '·源' : '' }}</i>
          </span>
          <span v-else-if="c.alert_title">来源规则 <i>{{ c.alert_title }}</i></span>
          <span>邮箱 <i>{{ c.linked_email||'—' }}</i></span>
          <span>更新 <i>{{ c.updated }}</i></span>
        </div>

        <div class="cols">
          <div class="col">
            <h5>🗺️ 处置方案</h5>
            <pre class="plan">{{ c.plan||'（未填写）' }}</pre>
          </div>
          <div class="col">
            <h5>🧠 舆情研判</h5>
            <p class="analysis">{{ c.analysis||'（未填写）' }}</p>
          </div>
        </div>

        <div class="timeline-block">
          <h5>🕒 处置时间线</h5>
          <div class="tl">
            <div v-for="(t,i) in c.timeline" :key="t.id" class="tl-item">
              <span class="tl-dot" :class="{latest:i===0, linked:['workorder','ext'].includes(t.ref_type)}"></span>
              <div class="tl-body">
                <b>{{ t.action }}
                  <span v-if="t.ref_type==='workorder'" class="tl-link" @click.stop="openTimelineWorkOrder(t)">📋 #{{ t.ref_id }} →</span>
                  <span v-else-if="t.ref_type==='ext'" class="tl-link ext" @click.stop="openTimelineExt(t)">🤝 {{ t.note.match(/（(EXT-\d+)）/)?.[1] || ('#'+t.ref_id) }} →</span>
                </b>
                <span>{{ t.note }}</span>
                <em>{{ t.time }}</em>
              </div>
            </div>
          </div>
        </div>

        <!-- 回溯面板 -->
        <div v-if="review && reviewId===c.id" class="review">
          <h5>🔍 事件回溯</h5>
          <div class="rv-stats">
            <div><b>{{ review.stats.triggers }}</b><em>预警触发</em></div>
            <div><b>{{ review.stats.resolved }}</b><em>已解除</em></div>
            <div><b class="warn-num">{{ review.stats.open }}</b><em>未解除</em></div>
            <div><b>{{ review.stats.rules }}</b><em>承接规则</em></div>
            <div><b>{{ review.stats.posts }}</b><em>关联舆情</em></div>
            <div><b class="t">{{ review.stats.firstAt || '—' }}</b><em>首次触发</em></div>
            <div><b class="t">{{ review.stats.lastAt || '—' }}</b><em>最近触发</em></div>
          </div>
          <div v-if="review.rules && review.rules.length" class="rv-rules">
            <span v-for="r in review.rules" :key="r.alert_id" class="rv-rule" :class="r.alert_level">
              <i class="rd"></i>{{ r.alert_title }}<em v-if="r.is_origin" class="origin-tag">来源</em>
              <b>{{ r.open ? r.open+' 待处置 · ' : '' }}{{ r.triggers }} 次</b>
            </span>
          </div>
          <div v-if="review.events.length" class="rv-events">
            <div v-for="e in review.events" :key="e.id" class="rv-ev" :class="{resolved:e.status==='resolved'}">
              <span class="rv-dot" :class="e.alert_level"></span>
              <div class="rv-body">
                <b>{{ e.detail }}</b>
                <span v-if="e.pt">关联舆情《{{ e.pt }}》 · 热度{{ e.heat }}</span>
              </div>
              <em v-if="e.status==='resolved' && e.resolve_kind" class="rv-kind">{{ kindText(e.resolve_kind) }}</em>
              <span class="rv-st" :class="e.status">{{ e.status==='resolved' ? '已解除' : '待处置' }}</span>
            </div>
          </div>
          <div v-else class="rv-none">无关联预警触发记录（人工建档）</div>

          <!-- 结案档案：结案/回滚历史（统一时间线口径） -->
          <div v-if="review.closures && review.closures.length" class="rv-closures">
            <div v-for="cl in review.closures" :key="cl.id" class="rv-closure" :class="{rolled: cl.rolled_back}">
              <b>{{ cl.rolled_back ? '↩︎ 结案已回滚' : '✔ 结案' }}</b>
              <span class="cl-sum">{{ cl.summary || '（无总结）' }}</span>
              <span v-if="cl.report_id || (review.report && review.report.published_version)" class="cl-report">
                📝 复盘报告已回写：{{ cl.report_title || review.report?.title }}（v{{ cl.report_version || review.report?.published_version }}）
              </span>
              <span v-if="settledCount(cl)" class="cl-notify">🔔 收口通知 {{ settledCount(cl) }} 个（回滚时恢复）</span>
              <em>{{ cl.closed_at }}<template v-if="cl.rolled_back"> · 回滚于 {{ cl.rolled_back_at }}{{ cl.rollback_note ? '：' + cl.rollback_note : '' }}</template></em>
            </div>
          </div>

          <!-- 复盘报告回写状态（统计口径同源） -->
          <div v-if="review.report" class="rv-report" :class="review.report.status">
            📝 复盘报告「{{ review.report.title }}」· {{ review.report.statusText }}
            <template v-if="review.report.published_version"> · 已发布 v{{ review.report.published_version }}（审核：{{ review.report.reviewed_by }}）</template>
            <button class="mini-link" @click="gotoReport(c)">前往报告 →</button>
          </div>

          <!-- 统一结案状态守卫：阻塞项 / 联动收口项 / 提示 -->
          <div v-if="c.status!=='closed' && review.readiness" class="rv-guard">
            <h6>🔒 结案就绪清单</h6>
            <div v-if="review.readiness.blocks.length" class="guard-blocks">
              <div v-for="b in review.readiness.blocks" :key="b.key" class="guard-item block">
                <span class="g-ico">⛔</span>
                <span class="g-text">{{ b.text }}</span>
                <button class="g-link" @click="gotoGuard(b, c)">去处理 →</button>
              </div>
            </div>
            <div v-else class="guard-ok">✅ 状态守卫已通过：工单、声明、外部协作、复盘审核均已闭环，可以结案</div>
            <div v-for="a in review.readiness.actions" :key="a.key" class="guard-item action">
              <span class="g-ico">🔗</span>
              <span class="g-text">{{ a.text }}</span>
            </div>
            <div v-for="n in review.readiness.notice" :key="n.key" class="guard-item notice">
              <span class="g-ico">ℹ️</span>
              <span class="g-text">{{ n.text }}</span>
              <button class="g-link" @click="gotoReport(c)">前往报告 →</button>
            </div>
          </div>

          <div v-if="c.status!=='closed'" class="close-box">
            <textarea v-model="closeSummary" placeholder="结案回溯总结：处置结果、舆情回落情况、经验沉淀…"></textarea>
            <div class="close-row">
              <button v-if="review.readiness && review.readiness.blocks.length" class="close" disabled
                title="存在未闭环事项，请先按结案就绪清单处理">⛔ {{ review.readiness.blocks.length }} 项未闭环</button>
              <button v-else class="close" @click="confirmClose(c)">✔ 确认结案</button>
            </div>
          </div>
          <div v-else class="closed-tip">✅ 已结案 · 回溯只读</div>
        </div>

        <div class="actions">
          <button class="ghost" @click="addStep(c)">＋ 记录处置</button>
          <button v-if="c.status==='monitoring'||c.status==='disposal'" class="prog" @click="advance(c)">推进处置</button>
          <button v-if="c.status!=='closed'" class="wo-btn" @click="splitWorkOrder(c)">📋 拆分工单</button>
          <button v-if="c.status!=='closed' || c.statement" class="stmt-btn" @click="gotoStmt(c)">{{ c.statement ? '📢 查看声明' : '📢 危机声明' }}</button>
          <button v-if="c.report || isOps" class="report-btn" @click="gotoReport(c)">📝 {{ c.report ? '复盘报告' : '编制复盘' }}</button>
          <button class="ghost" @click="toggleReview(c)">{{ reviewId===c.id ? '收起回溯' : '🔍 回溯' }}</button>
          <button v-if="c.status!=='closed'" class="close" @click="toggleReview(c, true)">结案</button>
          <button v-else class="reopen" @click="reopen(c)">↩︎ 回滚结案</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { usePubStore } from '@/store/pub'
const store = usePubStore()
const isOps = computed(() => ['admin', 'ops'].includes(store.user.role))
const showForm = ref(false)
const form = ref({ title: '', level: 'orange', topic: '', keyword: '', linked_email: '', plan: '', analysis: '' })
const reviewId = ref(null)
const review = ref(null)
const closeSummary = ref('')

function create() {
  store.addCrisis({ ...form.value })
  form.value = { title: '', level: 'orange', topic: '', keyword: '', linked_email: '', plan: '', analysis: '' }
  showForm.value = false
}
function advance(c) {
  const note = prompt('推进响应，记录一次处置动作：', c.status === 'monitoring' ? '转入处置阶段，发布首次回应' : '跟进处置进展')
  if (note == null) return
  if (c.status === 'monitoring') store.setCrisisStatus(c.id, { status: 'disposal', action: '启动处置', note })
  else store.addCrisisTimeline(c.id, { action: '处置跟进', note })
}
function addStep(c) {
  const note = prompt('新增一条处置记录：')
  if (note) store.addCrisisTimeline(c.id, { action: '处置记录', note })
}
async function toggleReview(c, forClose = false) {
  if (reviewId.value === c.id && !forClose) { reviewId.value = null; review.value = null; return }
  review.value = await store.fetchCrisisReview(c.id)
  reviewId.value = c.id
  closeSummary.value = c.status === 'closed' ? '' : defaultSummary(c)
}
function defaultSummary(c) {
  return `「${c.title}」处置完毕，舆情热度回落至常态区间，未出现次生舆情，完成闭环。`
}
async function confirmClose(c) {
  const ready = review.value?.readiness
  if (ready && ready.blocks.length) {
    store.msg(ready.blocks[0].text, 'warn') // 统一状态守卫：阻塞项未清零时前端拦截
    return
  }
  const autoBits = (ready?.actions || []).map((a) => `${a.label} ${a.count}`)
  const tip = autoBits.length ? `（将自动联动：${autoBits.join('、')}）` : ''
  if (!confirm(`确定结案「${c.title}」？${tip}`)) return
  try {
    await store.closeCrisis(c.id, closeSummary.value)
    reviewId.value = null
    review.value = null
  } catch (e) {
    // 并发兜底：服务端统一守卫返回 blocks 时展示第一条阻塞原因
    const msg = e.blocks?.[0]?.text || e.message
    store.msg(msg, 'warn')
    if (reviewId.value === c.id) review.value = await store.fetchCrisisReview(c.id)
  }
}
// 结案档案中归档的通知收口数量（历史档案无该列时按 0 处理）
function settledCount(cl) {
  try { return (JSON.parse(cl.settled_notify || '[]') || []).length } catch { return 0 }
}
// 结案守卫阻塞项 → 跳转对应模块处理
function gotoGuard(b, c) {
  if (b.key === 'workorder') gotoWorkOrder(c)
  else if (b.key === 'statement') gotoStmt(c)
  else if (b.key === 'ext') gotoExt(c)
  else if (b.key === 'report') gotoReport(c)
}
// 跳转传播路径页并按该危机过滤
function gotoProp(c) {
  store.propCrisisFilter = c.id
  store.tab = 'prop'
}
// 跳转协同工单页并预填所属危机（页签状态在 store）
function splitWorkOrder(c) {
  store.woDraftCrisis = c.id
  store.tab = 'work'
}
// 跳转危机声明页：已有声明则定位查看，无声明且未结案则预填起草
function gotoStmt(c) {
  store.stmtOpenId = c.statement ? c.statement.id : null
  store.stmtDraftCrisis = c.statement || c.status === 'closed' ? null : c.id
  store.tab = 'stmt'
}
// 跳转复盘报告页（已有报告直接打开，无报告则带危机预填建档）
function gotoReport(c) {
  store.reportOpenId = c.report ? c.report.id : null
  store.reportDraftCrisis = c.report ? null : c.id
  store.tab = 'report'
}
// 跳转外部协作审核看板并按该危机过滤
function gotoExt(c) {
  store.extOpenId = null
  store.extFilterCrisis = c.id
  store.tab = 'ext'
}
// 从时间线锚点跳转到外部协作提交详情（自动展开留痕）
function openTimelineExt(t) {
  store.extFilterCrisis = t.crisis_id
  store.extOpenId = t.ref_id
  store.tab = 'ext'
}
async function reopen(c) {
  const note = prompt(`回滚结案「${c.title}」：结案时联动解除的预警将恢复为未解除，事件重回处置流程。\n回滚说明（可留空）：`)
  if (note == null) return
  await store.reopenCrisis(c.id, note)
  if (reviewId.value === c.id) review.value = await store.fetchCrisisReview(c.id) // 刷新回溯（结案档案/未解除计数）
}
function kindText(k) { return { manual: '手动解除', batch: '批量解除', close: '结案联动', notify: '通知回执', workorder: '工单联动' }[k] || k }
async function del(c) {
  if (confirm(`删除危机「${c.title}」？`)) await store.delCrisis(c.id)
}
// 跳转协同工单页并按该危机过滤
function gotoWorkOrder(c) {
  store.woOpenId = null
  store.woFilterCrisis = c.id
  store.tab = 'work'
}
// 从时间线条目跳转（携带该条目的危机过滤，并自动展开工单调度链路）
function openTimelineWorkOrder(t) {
  store.woFilterCrisis = t.crisis_id
  store.woOpenId = t.ref_id
  store.tab = 'work'
}
function dispatchClass(d) {
  if (d.woEscalated || d.escalated || d.failed) return 'warn'
  if (d.acked) return 'acked'
  if (d.pending || d.sent) return 'active'
  return ''
}
function lvText(x) { return { red: '红', orange: '橙', yellow: '黄' }[x] || x }
function stText(x) { return { monitoring: '监测中', disposal: '处置中', closed: '已结案' }[x] || x }
</script>

<style scoped>
.crisis{display:flex;flex-direction:column;gap:12px;}
.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
.toolbar button{font-family:inherit;background:linear-gradient(135deg,#43a047,#2e7d32);border:none;color:#fff;border-radius:8px;padding:9px 14px;font-size:13px;font-weight:600;cursor:pointer;}
.loop-hint{font-size:11px;color:#5b6f94;}
.c-form{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px;}
.row{display:flex;gap:8px;flex-wrap:wrap;}
input,select,textarea,button{font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:8px 10px;font-size:12px;}
textarea{resize:vertical;min-height:52px;}
.save{background:#2962ff;border:none;color:#fff;font-weight:600;cursor:pointer;}
.ghost{background:#16263f;color:#8ba2c8;cursor:pointer;}
.c-form .row:last-child{margin-top:4px;}
.list{display:flex;flex-direction:column;gap:14px;}
.crisis-card{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px;border-top:4px solid #ffd54f;}
.crisis-card.red{border-top-color:#ef5350;}.crisis-card.orange{border-top-color:#ff9800;}
.c-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.lv{width:26px;height:26px;border-radius:7px;display:grid;place-items:center;color:#fff;font-size:14px;flex:none;}
.lv.red{background:#ef5350;}.lv.orange{background:#ff9800;}.lv.yellow{background:#ffd54f;color:#5d4037;}
.ct{color:#fff;font-size:16px;flex:1;min-width:140px;}
.origin{font-size:10px;padding:2px 8px;border-radius:6px;background:#0d2137;color:#90caf9;border:1px solid rgba(144,202,249,.25);}
.origin.manual{background:#1a2332;color:#8ba2c8;border-color:rgba(120,160,220,.2);}
.open-badge{font-size:10px;padding:2px 8px;border-radius:6px;background:#3e2723;color:#ffab91;border:1px solid rgba(255,138,101,.3);}
.wo-badge{font-size:10px;padding:2px 8px;border-radius:6px;background:#0d2137;color:#90caf9;border:1px solid rgba(144,202,249,.25);}
.wo-badge.open{background:#132a52;color:#bbdefb;border-color:rgba(66,165,245,.4);}
.dispatch-badge{font-size:10px;padding:2px 8px;border-radius:6px;background:#0c2622;color:#80cbc4;border:1px solid rgba(38,166,154,.3);cursor:pointer;}
.dispatch-badge.active{background:#0d2137;color:#90caf9;border-color:rgba(144,202,249,.3);}
.dispatch-badge.acked{background:#12261a;color:#a5d6a7;border-color:rgba(102,187,106,.35);}
.dispatch-badge.warn{background:#3a1a24;color:#ef9a9a;border-color:rgba(239,83,80,.45);}
.prop-badge{font-size:10px;padding:2px 8px;border-radius:6px;background:#0d2b28;color:#80cbc4;border:1px solid rgba(0,150,136,.3);cursor:pointer;}
.prop-badge.out{background:#3a1a24;color:#ef9a9a;border-color:rgba(239,83,80,.45);}
.report-badge{font-size:10px;padding:2px 8px;border-radius:6px;background:#1f1640;color:#ce93d8;border:1px solid rgba(149,117,205,.35);cursor:pointer;}
.report-badge.published{background:#122e1c;color:#a5d6a7;border-color:rgba(102,187,106,.4);}
.report-badge.reviewing{background:#3d2a07;color:#ffcc80;border-color:rgba(255,167,38,.4);}
.stmt-badge{font-size:10px;padding:2px 8px;border-radius:6px;background:#0d302c;color:#80cbc4;border:1px solid rgba(38,166,154,.4);cursor:pointer;}
.stmt-badge.review{background:#33270e;color:#ffe082;border-color:rgba(255,179,0,.45);}
.stmt-badge.publishing{background:#08303a;color:#80deea;border-color:rgba(38,198,218,.5);}
.stmt-badge.partial{background:#3a1c12;color:#ffab91;border-color:rgba(255,112,67,.6);}
.stmt-badge.published{background:#122e1c;color:#a5d6a7;border-color:rgba(102,187,106,.4);}
.stmt-badge.draft{background:#263238;color:#b0bec5;border-color:rgba(120,144,156,.4);}
.ext-badge{font-size:10px;padding:2px 8px;border-radius:6px;background:#261a3d;color:#ce93d8;border:1px solid rgba(142,36,170,.45);cursor:pointer;}
.ext-badge.urgent{background:#3d1414;color:#ff8a80;border-color:rgba(239,83,80,.6);animation:extpulse 1.2s infinite;}
@keyframes extpulse{50%{box-shadow:0 0 0 3px rgba(239,83,80,.18);}}
.st{font-size:11px;padding:2px 10px;border-radius:6px;}
.st.monitoring{background:#37474f;color:#b0bec5;}.st.disposal{background:#b71c1c;color:#ffcdd2;}.st.closed{background:#1b5e20;color:#a5d6a7;}
.del{background:none;border:none;color:#ef5350;font-size:15px;cursor:pointer;}
.keywords{display:flex;gap:16px;font-size:11px;color:#8ba2c8;margin:10px 0;flex-wrap:wrap;align-items:center;}
.keywords i{color:#90caf9;font-style:normal;}
.rules-chip{display:inline-flex;gap:5px;flex-wrap:wrap;align-items:center;}
.rule-chip{font-style:normal;font-size:10px;padding:1px 7px;border-radius:5px;background:#0d2137;border:1px solid rgba(144,202,249,.25);color:#90caf9;}
.rule-chip.red{color:#ef9a9a;border-color:rgba(239,83,80,.4);}
.rule-chip.orange{color:#ffcc80;border-color:rgba(255,152,0,.4);}
.rule-chip.yellow{color:#ffe082;border-color:rgba(255,213,79,.4);}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
@media(max-width:700px){.cols{grid-template-columns:1fr;}}
.col{background:#13233f;border-radius:10px;padding:12px;}
h5{margin:0 0 8px;color:#ffd54f;font-size:12px;}
.plan{white-space:pre-wrap;margin:0;color:#aebadd;font-size:12px;line-height:1.6;}
.analysis{color:#aebadd;font-size:12px;line-height:1.6;margin:0;}
.timeline-block{margin-top:12px;background:#13233f;border-radius:10px;padding:12px;}
.tl{border-left:2px solid #243357;padding-left:14px;display:flex;flex-direction:column;gap:8px;max-height:160px;overflow-y:auto;}
.tl-item{position:relative;}
.tl-dot{position:absolute;left:-19px;top:4px;width:9px;height:9px;border-radius:50%;background:#546e7a;}
.tl-dot.latest{background:#ffd54f;}
.tl-dot.linked{background:#26a69a;box-shadow:0 0 0 3px rgba(38,166,154,.15);}
.tl-link{font-size:10px;font-weight:400;color:#80cbc4;background:#0c2622;border:1px solid rgba(38,166,154,.35);border-radius:5px;padding:0 6px;margin-left:6px;cursor:pointer;}
.tl-link:hover{background:#10433d;}
.tl-link.ext{color:#ce93d8;background:#241636;border-color:rgba(142,36,170,.4);}
.tl-link.ext:hover{background:#341d4d;}
.tl-body b{color:#dbe4f3;font-size:12px;display:block;}
.tl-body span{color:#8ba2c8;font-size:11px;}
.tl-body em{color:#5b6f94;font-size:10px;font-style:normal;display:block;margin-top:2px;}
.review{margin-top:12px;background:#0c1a30;border:1px solid rgba(144,202,249,.2);border-radius:10px;padding:12px;}
.rv-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:8px;margin-bottom:10px;}
.rv-stats>div{background:#13233f;border-radius:8px;padding:8px;text-align:center;display:flex;flex-direction:column;gap:2px;}
.rv-stats b{color:#fff;font-size:16px;}
.rv-stats b.t{font-size:10px;color:#90caf9;line-height:1.4;}
.rv-stats .warn-num{color:#ffab91;}
.rv-stats em{font-size:10px;color:#5b6f94;font-style:normal;}
.rv-rules{display:flex;flex-direction:column;gap:5px;margin-bottom:10px;}
.rv-rule{display:flex;align-items:center;gap:6px;font-size:11px;color:#dbe4f3;background:#13233f;border-radius:7px;padding:5px 9px;}
.rv-rule .rd{width:8px;height:8px;border-radius:50%;background:#90a4ae;flex:none;}
.rv-rule.red .rd{background:#ef5350;}.rv-rule.orange .rd{background:#ff9800;}.rv-rule.yellow .rd{background:#ffd54f;}
.rv-rule b{margin-left:auto;color:#90caf9;font-size:10px;font-weight:600;}
.origin-tag{font-size:9px;font-style:normal;color:#1b2a44;background:#90caf9;border-radius:4px;padding:0 5px;}
.rv-events{display:flex;flex-direction:column;max-height:150px;overflow-y:auto;margin-bottom:10px;}
.rv-ev{display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-bottom:1px dashed rgba(120,160,220,0.1);}
.rv-ev:last-child{border-bottom:none;}
.rv-ev.resolved{opacity:.6;}
.rv-dot{width:8px;height:8px;border-radius:50%;margin-top:4px;flex:none;background:#546e7a;}
.rv-dot.red{background:#ef5350;}.rv-dot.orange{background:#ff9800;}.rv-dot.yellow{background:#ffd54f;}
.rv-body{flex:1;min-width:0;}
.rv-body b{color:#dbe4f3;font-size:11px;display:block;}
.rv-body span{color:#5b6f94;font-size:10px;}
.rv-st{font-size:10px;padding:1px 7px;border-radius:5px;flex:none;}
.rv-st.open{background:#3e2723;color:#ffab91;}
.rv-st.resolved{background:#1b5e20;color:#a5d6a7;}
.rv-kind{font-size:9px;font-style:normal;color:#90caf9;background:#0d2137;border:1px solid rgba(144,202,249,.25);border-radius:4px;padding:1px 5px;flex:none;margin-top:2px;}
.rv-closures{display:flex;flex-direction:column;gap:5px;margin-bottom:10px;}
.rv-closure{background:#13233f;border-radius:7px;padding:6px 9px;font-size:11px;color:#dbe4f3;display:flex;flex-direction:column;gap:2px;border-left:3px solid #66bb6a;}
.rv-closure.rolled{border-left-color:#ffb300;opacity:.85;}
.rv-closure .cl-sum{color:#8ba2c8;font-size:10px;}
.cl-report{font-size:10px;color:#ce93d8;background:#1d1440;border:1px solid rgba(149,117,205,.35);border-radius:5px;padding:2px 8px;align-self:flex-start;}
.rv-closure em{color:#5b6f94;font-size:10px;font-style:normal;}
.rv-report{display:flex;align-items:center;gap:8px;font-size:11px;color:#dbe4f3;background:#13233f;border-radius:7px;padding:7px 11px;margin-bottom:10px;border-left:3px solid #7e57c2;flex-wrap:wrap;}
.rv-report.published{border-left-color:#66bb6a;}.rv-report.reviewing{border-left-color:#ffa726;}
.mini-link{margin-left:auto;background:none;border:none;color:#90caf9;font-size:11px;cursor:pointer;text-decoration:underline;}
/* 统一结案状态守卫清单 */
.rv-guard{background:#0d2137;border:1px solid rgba(144,202,249,.22);border-radius:8px;padding:9px 11px;margin-bottom:10px;}
.rv-guard h6{margin:0 0 7px;color:#ffd54f;font-size:11px;font-weight:600;}
.guard-blocks{display:flex;flex-direction:column;gap:5px;margin-bottom:6px;}
.guard-item{display:flex;align-items:center;gap:8px;font-size:11px;padding:5px 9px;border-radius:6px;background:#13233f;flex-wrap:wrap;}
.guard-item.block{color:#ef9a9a;border:1px solid rgba(239,83,80,.35);background:#2a1418;}
.guard-item.action{color:#90caf9;border:1px solid rgba(66,165,245,.25);background:#0e2238;}
.guard-item.notice{color:#ffe082;border:1px solid rgba(255,224,130,.25);background:#2c260f;}
.g-ico{flex:none;}
.g-text{flex:1;min-width:180px;}
.g-link{margin-left:auto;background:#0d2137;border:1px solid rgba(120,160,220,.3);color:#90caf9;border-radius:5px;padding:2px 9px;font-size:10px;cursor:pointer;white-space:nowrap;}
.g-link:hover{background:#17345c;}
.guard-ok{font-size:11px;color:#a5d6a7;background:#12261a;border:1px solid rgba(102,187,106,.35);border-radius:6px;padding:6px 9px;margin-bottom:6px;}
.cl-notify{font-size:10px;color:#80cbc4;background:#0c2622;border:1px solid rgba(38,166,154,.35);border-radius:5px;padding:2px 8px;align-self:flex-start;}
.rv-none{color:#5b6f94;font-size:11px;text-align:center;padding:8px 0;}
.close-box{border-top:1px dashed rgba(120,160,220,0.15);padding-top:10px;display:flex;flex-direction:column;gap:8px;}
.close-box textarea{min-height:56px;}
.close-row{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap;}
.cascade{font-size:10px;color:#ffab91;}
.closed-tip{color:#81c784;font-size:11px;text-align:center;padding:6px 0 2px;}
.actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;}
.prog{background:linear-gradient(135deg,#ef6c00,#e65100);border:none;color:#fff;font-weight:600;cursor:pointer;}
.wo-btn{background:linear-gradient(135deg,#00897b,#00695c);border:none;color:#fff;font-weight:600;cursor:pointer;}
.stmt-btn{background:linear-gradient(135deg,#00838f,#006064);border:none;color:#fff;font-weight:600;cursor:pointer;}
.report-btn{background:linear-gradient(135deg,#7b1fa2,#4a148c);border:none;color:#fff;font-weight:600;cursor:pointer;}
.close{background:linear-gradient(135deg,#2e7d32,#1b5e20);border:none;color:#fff;font-weight:600;cursor:pointer;}
.close:disabled{background:#3a4456;color:#90a4ae;cursor:not-allowed;font-weight:400;opacity:.85;}
.reopen{background:linear-gradient(135deg,#f9a825,#f57f17);border:none;color:#fff;font-weight:600;cursor:pointer;}
.none{color:#5b6f94;text-align:center;padding:40px;}
</style>
