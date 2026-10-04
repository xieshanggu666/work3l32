<template>
  <div class="layout">
    <header class="top">
      <div class="brand"><span class="logo">📡</span><div><b>舆舟</b><em>舆情监测 · 危机管理</em></div></div>
      <nav class="tabs">
        <button v-for="t in tabs" :key="t.key" :class="{active:tab===t.key}" @click="tab=t.key">
          {{ t.icon }} {{ t.label }}
          <span v-if="t.badge && t.badge()" class="bd">{{ t.badge() }}</span>
        </button>
      </nav>
      <select class="user-switch" :value="userIdx" @change="switchUser($event.target.value)" title="切换操作身份（权限演示）">
        <option v-for="(u,i) in users" :key="u.name" :value="i">👤 {{ u.name }} · {{ roleText(u.role) }}</option>
      </select>
      <button class="reload" @click="store.load()">🔄</button>
    </header>

    <main>
      <DashboardView v-if="tab==='dash'" />
      <PostsView v-else-if="tab==='posts'" />
      <CollectView v-else-if="tab==='collect'" />
      <AlertCenterView v-else-if="tab==='alerts'" />
      <PropagationView v-else-if="tab==='prop'" />
      <CrisisView v-else-if="tab==='crisis'" />
      <StatementsView v-else-if="tab==='stmt'" />
      <WorkOrderView v-else-if="tab==='work'" />
      <ReportsView v-else-if="tab==='report'" />
      <ExtPortalView v-else-if="tab==='ext'" />
      <PartnerPortalView v-else-if="tab==='portal'" />
      <NotifyView v-else-if="tab==='notify'" />
    </main>

    <transition name="tg">
      <div v-if="store.toast" class="toast" :class="store.toast.type" @click="store.clearToast()">{{ store.toast.msg }}</div>
    </transition>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { usePubStore } from '@/store/pub'
import DashboardView from '@/components/DashboardView.vue'
import PostsView from '@/components/PostsView.vue'
import CollectView from '@/components/CollectView.vue'
import AlertCenterView from '@/components/AlertCenterView.vue'
import PropagationView from '@/components/PropagationView.vue'
import CrisisView from '@/components/CrisisView.vue'
import StatementsView from '@/components/StatementsView.vue'
import WorkOrderView from '@/components/WorkOrderView.vue'
import ReportsView from '@/components/ReportsView.vue'
import ExtPortalView from '@/components/ExtPortalView.vue'
import PartnerPortalView from '@/components/PartnerPortalView.vue'
import NotifyView from '@/components/NotifyView.vue'

const store = usePubStore()
// 页签状态入 store：危机卡片「拆分工单」可跳转工单页并预填所属危机
const tab = computed({ get: () => store.tab, set: (v) => { store.tab = v } })
const tabs = [
  { key: 'dash', icon: '📊', label: '舆情总览', badge: () => store.activeAlerts.length || 0 },
  { key: 'posts', icon: '📰', label: '舆情列表' },
  { key: 'collect', icon: '🛰️', label: '数据源采集', badge: () => store.stats.collectRunning || 0 },
  { key: 'alerts', icon: '🚨', label: '预警中心' },
  { key: 'prop', icon: '🕸', label: '传播路径', badge: () => store.stats.propOutbreak || 0 },
  { key: 'crisis', icon: '🛟', label: '危机处置' },
  { key: 'stmt', icon: '📢', label: '危机声明', badge: () => (store.stats.stmtReview || 0) + (store.stats.stmtChannelFailed || 0) },
  { key: 'work', icon: '📋', label: '协同工单', badge: () => store.stats.workOpen || 0 },
  { key: 'report', icon: '📝', label: '复盘报告', badge: () => store.stats.reportReviewing || 0 },
  { key: 'ext', icon: '🤝', label: '外部协作', badge: () => store.stats.extPending || 0 },
  { key: 'portal', icon: '📮', label: '协作门户' },
  { key: 'notify', icon: '🔔', label: '通知中心', badge: () => store.stats.notifyOpen || 0 }
]
// 演示权限模型：admin 配置+操作（法务审核由管理员角色承担，如法务负责人陈律）/ ops 任务操作 / viewer 只读（服务端强制校验）
const users = [
  { name: '张岚', role: 'admin' },
  { name: '陈律', role: 'admin' },
  { name: '李澈', role: 'ops' },
  { name: '王观', role: 'viewer' }
]
const userIdx = ref(0)
function roleText(r) { return { admin: '管理员', ops: '值班员', viewer: '观察员' }[r] || r }
function switchUser(i) {
  userIdx.value = +i
  const u = users[userIdx.value]
  store.setUser(u)
  store.msg(`已切换身份：${u.name}（${roleText(u.role)}）`, 'info')
}
onMounted(async () => {
  try { await store.load() }
  catch (e) { store.msg('后端未启动，请运行 node server/index.js', 'warn') }
})
</script>

<style scoped>
.layout{min-height:100vh;background:#0a1224;color:#dbe4f3;padding-bottom:40px;}
.top{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:16px;padding:10px 20px;background:#0c1730;border-bottom:1px solid rgba(120,160,220,0.18);flex-wrap:wrap;}
.brand{display:flex;align-items:center;gap:8px;}
.logo{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;font-size:20px;background:linear-gradient(135deg,#ef5350,#e65100);}
.brand b{color:#fff;font-size:15px;display:block;}
.brand em{font-size:10px;color:#6f84ab;font-style:normal;letter-spacing:1px;}
.tabs{display:flex;gap:6px;flex-wrap:wrap;}
.tabs button{background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#aebadd;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:13px;position:relative;}
.tabs button.active{background:linear-gradient(135deg,#8e24aa,#e65100);color:#fff;border-color:transparent;}
.bd{position:absolute;top:-4px;right:-4px;background:#ef5350;color:#fff;font-size:9px;border-radius:8px;padding:1px 5px;font-weight:700;}
.reload{margin-left:auto;background:#13233f;border:1px solid rgba(120,160,220,0.3);border-radius:8px;color:#8ba2c8;font-size:16px;cursor:pointer;padding:4px 10px;}
.user-switch{margin-left:auto;background:#13233f;border:1px solid rgba(120,160,220,0.3);border-radius:8px;color:#aebadd;font-size:12px;padding:6px 8px;font-family:inherit;cursor:pointer;}
.user-switch+.reload{margin-left:0;}
main{max-width:1280px;margin:0 auto;padding:18px 20px;}
.toast{position:fixed;right:20px;top:70px;z-index:50;padding:12px 20px;border-radius:10px;font-size:13px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,0.4);cursor:pointer;max-width:320px;}
.toast.success{background:#1b5e20;color:#c8e6c9;border:1px solid #388e3c;}
.toast.warn{background:#e65100;color:#ffe0b2;border:1px solid #f57c00;}
.toast.info{background:#0d47a1;color:#bbdefb;border:1px solid #1976d2;}
.tg-enter-active,.tg-leave-active{transition:all .3s;}
.tg-enter-from,.tg-leave-to{opacity:0;transform:translateY(-10px);}
</style>