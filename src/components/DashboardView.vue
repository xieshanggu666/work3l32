<template>
  <div v-if="store.loaded" class="dash">
    <!-- 顶部统计卡 -->
    <div class="stat-grid">
      <div class="stat"><span class="s-ic">📰</span><b>{{ s.total }}</b><em>舆情总量</em></div>
      <div class="stat pos"><span class="s-ic">😊</span><b>{{ s.pos }}</b><em>正面</em></div>
      <div class="stat neu"><span class="s-ic">😐</span><b>{{ s.neu }}</b><em>中性</em></div>
      <div class="stat neg"><span class="s-ic">😟</span><b>{{ s.neg }}</b><em>负面</em></div>
      <div class="stat warn"><span class="s-ic">🔥</span><b>{{ s.hot }}</b><em>热点</em></div>
      <div class="stat red"><span class="s-ic">📢</span><b>{{ s.negRate }}%</b><em>负面占比</em></div>
      <div class="stat alarm"><span class="s-ic">🔔</span><b>{{ s.alertOpen ?? 0 }}</b><em>未解除预警</em></div>
      <div class="stat crisis"><span class="s-ic">🛟</span><b>{{ s.crisisActive ?? 0 }}</b><em>在办危机</em></div>
      <div class="stat wo"><span class="s-ic">📋</span><b>{{ s.workOpen ?? 0 }}</b><em>在办工单{{ s.workOverdue ? `（超时 ${s.workOverdue}）` : '' }}{{ s.workEscalated ? ` · 升级 ${s.workEscalated}` : '' }}</em></div>
      <div class="stat notify"><span class="s-ic">📤</span><b>{{ s.notifyAcked ?? 0 }}</b><em>通知已回执{{ s.notifyOpen ? `（在途 ${s.notifyOpen}）` : '' }}</em></div>
      <div v-if="s.notifyRetries || s.notifyEscalated || s.workDispatchStalled" class="stat notify-warn"><span class="s-ic">🔗</span><b>{{ (s.notifyRetries ?? 0) + (s.notifyEscalated ?? 0) }}</b><em>调度重试/升级{{ s.workDispatchStalled ? ` · ${s.workDispatchStalled} 单发送失败` : '' }}</em></div>
      <div class="stat stmt" :class="{partial:s.stmtPartial}"><span class="s-ic">📢</span><b>{{ (s.stmtReview ?? 0) + (s.stmtPublishing ?? 0) }}</b><em>待办声明{{ s.stmtPartial ? ` · ${s.stmtPartial} 份部分失败` : '' }}{{ s.stmtChannelFailed ? `（${s.stmtChannelFailed} 渠道失败）` : '' }}</em></div>
      <div class="stat ext" :class="{warn:s.extUrgentOpen}"><span class="s-ic">🤝</span><b>{{ (s.extPending ?? 0) + (s.extReviewing ?? 0) }}</b><em>外部协作待审{{ s.extUrgentOpen ? `（⚡紧急 ${s.extUrgentOpen}）` : '' }}</em></div>
      <div class="stat prop"><span class="s-ic">🕸</span><b>{{ s.propActive ?? 0 }}</b><em>监测传播路径</em></div>
      <div class="stat prop-out"><span class="s-ic">🔥</span><b>{{ s.propOutbreak ?? 0 }}</b><em>爆发期路径</em></div>
      <div class="stat report"><span class="s-ic">📝</span><b>{{ s.reportPublished ?? 0 }}</b><em>已发布复盘报告</em></div>
      <div v-if="s.reportReviewing" class="stat report-rev"><span class="s-ic">🖊</span><b>{{ s.reportReviewing }}</b><em>报告待审核</em></div>
    </div>

    <div class="grid">
      <!-- 情感占比 -->
      <div class="card">
        <h4>😶‍🌫️ 情感分布</h4>
        <div class="donut-wrap">
          <svg viewBox="0 0 120 120" class="donut">
            <circle r="48" cx="60" cy="60" fill="none" stroke="#1b3a5c" stroke-width="16"/>
            <circle v-for="(seg, i) in segs" :key="i" r="48" cx="60" cy="60" fill="none"
              :stroke="seg.color" stroke-width="16" :stroke-dasharray="`${seg.len} ${cir}`"
              :stroke-dashoffset="seg.off" transform="rotate(-90 60 60)" stroke-linecap="butt"/>
          </svg>
          <div class="donut-center"><b>{{ s.total }}</b><span>总量</span></div>
        </div>
        <div class="legend">
          <span v-for="seg in segs" :key="seg.key"><i :style="{background:seg.color}"></i>{{ seg.label }} · {{ seg.pct }}%</span>
        </div>
      </div>

      <!-- 热度趋势 -->
      <div class="card">
        <h4>📈 舆情热度趋势（近 {{ trend.length }} 个时段）</h4>
        <svg viewBox="0 0 300 120" class="line-chart">
          <polyline :points="pts" fill="none" stroke="#ffb300" stroke-width="2"/>
          <g v-for="(t,i) in trend" :key="i">
            <circle :cx="cx(i)" :cy="cy(t)" r="3" fill="#ffb300"/>
            <text v-if="i%2===0" :x="cx(i)" :y="112" text-anchor="middle" class="tick">{{ t.label }}</text>
          </g>
        </svg>
      </div>

      <!-- 传播渠道来源 -->
      <div class="card">
        <h4>📡 渠道来源分布</h4>
        <div class="src-bar" v-for="src in sources" :key="src.id">
          <span class="sl">{{ src.name }}</span>
          <div class="st"><i :style="{width: pct(src.cnt)+'%'}"></i></div>
          <span class="sn">{{ src.cnt }}</span>
        </div>
      </div>

      <!-- 热词榜 -->
      <div class="card">
        <h4>☁️ 高频热词</h4>
        <div class="cloud">
          <span v-for="(w,i) in hotWords" :key="i" class="word" :style="wordStyle(w)" :class="w.sentiment">
            {{ w.word }}<b>{{ w.weight }}</b>
          </span>
        </div>
      </div>

      <!-- 生效预警 -->
      <div class="card">
        <h4>🚨 生效预警规则（{{ activeAlerts.length }}）</h4>
        <div v-for="a in activeAlerts" :key="a.id" class="alert" :class="a.level">
          <span class="a-dot"></span>
          <div><b>{{ a.title }}</b>
            <small>关键词[{{ a.keyword||'全部' }}] · 情感[{{ a.sentiment||'不限' }}] · 热度≥{{ a.heat_min }}</small>
          </div>
          <em>{{ a.trigger_count }}次</em>
        </div>
      </div>

      <!-- 危机速览 -->
      <div class="card wide">
        <h4>🛟 危机处置速览</h4>
        <div v-if="!crises.length" class="none">暂无危机事件</div>
        <div class="crisis-row" v-for="c in crises" :key="c.id">
          <span class="c-lv" :class="c.level">{{ c.level==='red'?'红':c.level==='orange'?'橙':'黄' }}</span>
          <span class="c-title">{{ c.title }}<i v-if="c.origin==='auto'" class="c-auto">🤖</i><i v-if="c.topic" class="c-topic">#{{ c.topic }}</i></span>
          <span v-if="c.rules && c.rules.length>1" class="c-rules">多规则 ×{{ c.rules.length }}</span>
          <span v-if="c.open_events" class="c-open">🔔 {{ c.open_events }}</span>
          <span class="c-status" :class="c.status">{{ statusText(c.status) }}</span>
          <span class="c-time">{{ c.updated }}</span>
        </div>
      </div>

      <!-- 传播路径速览 -->
      <div class="card wide">
        <h4>🕸 舆情传播路径速览</h4>
        <div class="prop-row" v-for="p in propPaths" :key="p.id">
          <span class="p-stage" :class="p.stage">{{ stageText(p.stage) }}</span>
          <span class="p-title">{{ p.title }}<i class="p-topic">#{{ p.topic||'未分类' }}</i></span>
          <span class="p-stat">节点 {{ p.nodeCount }}</span>
          <span class="p-stat">KOL {{ p.kolCount }}</span>
          <span class="p-stat" :class="{hot:p.heat>=60}">🔥 {{ p.heat }}</span>
          <span class="p-stat">层级 {{ p.maxDepth }}</span>
          <span v-if="p.woCount" class="p-wo">📋 {{ p.woCount }}</span>
        </div>
        <div v-if="!propPaths.length" class="none">暂无传播路径（在「传播路径」页建档并记录转发关系）</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { usePubStore } from '@/store/pub'
const store = usePubStore()
const s = computed(() => store.stats || {})
const hotWords = computed(() => store.hotWords)
const sources = computed(() => store.sources)
const trend = computed(() => store.trend)
const activeAlerts = computed(() => store.activeAlerts)
const crises = computed(() => store.crises)
const propPaths = ref([])
function stageText(x) { return { seed: '潜伏期', ferment: '发酵期', outbreak: '爆发期', decline: '回落期' }[x] || x }
async function loadProp() {
  try { propPaths.value = (await store.fetchProp()).items.slice(0, 6) } catch { /* 后端未就绪 */ }
}
let timer = null
onMounted(() => { loadProp(); timer = setInterval(loadProp, 6000) })
onUnmounted(() => clearInterval(timer))

const cir = 2 * Math.PI * 48
const segs = computed(() => {
  const p = s.value.pos || 0, n = s.value.neg || 0, u = s.value.neu || 0
  const t = p + n + u || 1
  const items = [
    { key: 'pos', label: '正面', v: p, color: '#66bb6a' },
    { key: 'neu', label: '中性', v: u, color: '#90a4ae' },
    { key: 'neg', label: '负面', v: n, color: '#ef5350' }
  ]
  let off = 0
  return items.map((it) => {
    const len = (it.v / t) * cir
    const seg = { ...it, len, pct: Math.round((it.v / t) * 100), off: -off, color: it.color }
    off += len
    return seg
  })
})
const cx = (i) => 20 + i * (280 / Math.max(1, trend.value.length - 1))
const cy = (t) => 100 - (Math.min(100, t.value) / 100) * 86
const pts = computed(() => trend.value.map((t, i) => `${cx(i)},${cy(t)}`).join(' '))
function pct(n) { const max = Math.max(...sources.value.map((x) => x.cnt), 1); return Math.round((n / max) * 100) }
function wordStyle(w) { return { fontSize: (11 + (w.weight / 40) * 8) + 'px', opacity: 0.75 + (w.weight / 100) } }
function statusText(st) { return { monitoring: '监测中', disposal: '处置中', closed: '已结案' }[st] || st }
</script>

<style scoped>
.dash{display:flex;flex-direction:column;gap:16px;}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;}
.stat{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px;display:flex;flex-direction:column;align-items:center;gap:2px;}
.stat b{font-size:26px;color:#fff;}.stat em{font-size:11px;color:#8ba2c8;font-style:normal;}
.s-ic{font-size:20px;}
.stat.pos b{color:#66bb6a;}.stat.neu b{color:#90a4ae;}.stat.neg b{color:#ef5350;}.stat.warn b{color:#ffb300;}.stat.red b{color:#ef5350;}
.stat.alarm b{color:#ffab91;}.stat.crisis b{color:#90caf9;}.stat.wo b{color:#80cbc4;}.stat.stmt b{color:#4dd0e1;}.stat.stmt.partial{border-color:rgba(255,112,67,.5);}.stat.stmt.partial b{color:#ff8a65;}.stat.ext b{color:#ce93d8;}.stat.ext.warn b{color:#ff8a80;}
.stat.notify b{color:#a5d6a7;}.stat.notify-warn b{color:#ffcc80;}
.stat.prop b{color:#80cbc4;}.stat.prop-out b{color:#ef5350;}
.stat.report b{color:#ce93d8;}.stat.report-rev b{color:#ffcc80;}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;}
@media(max-width:860px){.grid{grid-template-columns:1fr;}}
.card{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px;}
.card.wide{grid-column:1/-1;}
h4{margin:0 0 12px;color:#fff;font-size:14px;}
.donut-wrap{position:relative;width:130px;height:130px;margin:0 auto;}
.donut{width:100%;height:100%;}
.donut-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;}
.donut-center b{font-size:24px;color:#fff;}.donut-center span{font-size:10px;color:#8ba2c8;}
.legend{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px;justify-content:center;font-size:11px;color:#8ba2c8;}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:4px;}
.line-chart{width:100%;height:120px;}.tick{fill:#5b6f94;font-size:8px;}
.src-bar{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:12px;color:#8ba2c8;}
.sl{width:42px;}.sn{width:22px;text-align:right;color:#fff;font-weight:600;}
.st{flex:1;height:9px;background:#0c1730;border-radius:5px;overflow:hidden;}
.st i{display:block;height:100%;background:linear-gradient(90deg,#42a5f5,#1e88e5);}
.cloud{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}
.word{background:#16263f;border:1px solid rgba(120,160,220,0.12);border-radius:7px;padding:4px 8px;line-height:1;}
.word b{color:#5b6f94;font-size:9px;margin-left:4px;}
.word.positive{border-color:rgba(102,187,106,.5);}.word.negative{border-color:rgba(239,83,80,.5);}
.alert{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px dashed rgba(120,160,220,0.1);}
.alert:last-child{border-bottom:none;}
.a-dot{width:9px;height:9px;border-radius:50%;flex:none;}
.alert.red .a-dot{background:#ef5350;}.alert.orange .a-dot{background:#ff9800;}.alert.yellow .a-dot{background:#ffd54f;}
.alert b{color:#dbe4f3;font-size:13px;display:block;}
.alert small{color:#8ba2c8;font-size:10px;}
.alert em{margin-left:auto;color:#ffd54f;font-size:11px;font-style:normal;}
.crisis-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px dashed rgba(120,160,220,0.1);font-size:13px;}
.crisis-row:last-child{border-bottom:none;}
.c-lv{width:22px;height:22px;border-radius:6px;display:grid;place-items:center;font-size:12px;color:#fff;flex:none;}
.c-lv.red{background:#ef5350;}.c-lv.orange{background:#ff9800;}.c-lv.yellow{background:#ffd54f;color:#5d4037;}
.c-title{color:#dbe4f3;flex:1;}
.c-auto{font-style:normal;font-size:11px;margin-left:4px;}
.c-topic{font-style:normal;font-size:10px;color:#90caf9;background:#0d2137;border:1px solid rgba(144,202,249,.25);border-radius:5px;padding:1px 6px;margin-left:6px;}
.c-rules{font-size:10px;color:#ce93d8;border:1px solid rgba(206,147,216,.35);border-radius:5px;padding:1px 6px;}
.c-open{font-size:10px;color:#ffab91;}
.c-status{font-size:10px;padding:2px 8px;border-radius:6px;}
.c-status.monitoring{background:#37474f;color:#b0bec5;}.c-status.disposal{background:#b71c1c;color:#ffcdd2;}.c-status.closed{background:#1b5e20;color:#a5d6a7;}
.c-time{color:#5b6f94;font-size:11px;}
.prop-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px dashed rgba(120,160,220,0.1);font-size:12px;}
.prop-row:last-child{border-bottom:none;}
.p-stage{font-size:10px;padding:2px 8px;border-radius:6px;flex:none;}
.p-stage.seed{background:#37474f;color:#cfd8dc;}.p-stage.ferment{background:#33270e;color:#ffe082;}
.p-stage.outbreak{background:#4a1518;color:#ef9a9a;}.p-stage.decline{background:#263238;color:#b0bec5;}
.p-title{color:#dbe4f3;flex:1;min-width:140px;}
.p-topic{font-style:normal;font-size:10px;color:#80cbc4;background:#0d2b28;border:1px solid rgba(0,150,136,.3);border-radius:5px;padding:1px 6px;margin-left:6px;}
.p-stat{font-size:11px;color:#8ba2c8;}
.p-stat.hot{color:#ef9a9a;font-weight:700;}
.p-wo{font-size:10px;color:#81c784;background:#12261a;border-radius:5px;padding:1px 7px;}
.none{color:#5b6f94;text-align:center;padding:20px;}
</style>