import { defineStore } from 'pinia'

// 当前操作身份（演示权限模型：请求头携带，服务端强制校验）
let actor = { name: '张岚', role: 'admin' }
// 外部协作门户身份（协作方口令；与内部权限身份相互独立，请求头 x-access-code 携带）
let portalCode = ''

async function api(path, method = 'GET', body, qs, extraHeaders) {
  const url = '/api' + path + (qs ? '?' + new URLSearchParams(qs).toString() : '')
  const opt = { method, headers: { 'Content-Type': 'application/json', 'x-user': encodeURIComponent(actor.name), 'x-role': actor.role, ...(extraHeaders || {}) } }
  if (body) opt.body = JSON.stringify(body)
  const r = await fetch(url, opt)
  const data = await r.json()
  if (!r.ok) throw Object.assign(new Error(data.error || '请求失败'), { details: data.details })
  return data
}

// 外部门户接口：以协作方口令鉴权
async function portalApi(path, method = 'GET', body) {
  const url = '/api/portal' + path
  const opt = { method, headers: { 'Content-Type': 'application/json', 'x-access-code': portalCode } }
  if (body) opt.body = JSON.stringify(body)
  const r = await fetch(url, opt)
  const data = await r.json()
  if (!r.ok) throw Object.assign(new Error(data.error || '请求失败'), { status: r.status })
  return data
}

export const usePubStore = defineStore('pub', {
  state: () => ({
    loaded: false,
    sources: [], hotWords: [], activeAlerts: [], crises: [], stats: {}, trend: [],
    user: { name: '张岚', role: 'admin' }, // 当前身份（admin 管理员 / ops 值班员 / viewer 观察员）
    tab: 'dash',          // 当前页签（危机卡片可跳转协同工单）
    woDraftCrisis: null,  // 从危机卡片「拆分工单」带入的预填危机 id
    woFilterCrisis: null, // 从危机卡片「调度链路」角标带入的工单危机过滤
    woOpenId: null,       // 从危机时间线锚点带入的待展开工单 id
    propCrisisFilter: null, // 从危机卡片跳转传播路径页带入的危机过滤
    reportDraftCrisis: null, // 从危机卡片/回溯跳转复盘报告页：无报告时带危机预填建档
    reportOpenId: null,      // 从危机卡片/回溯跳转复盘报告页：已有报告时自动展开详情
    stmtDraftCrisis: null,   // 从危机卡片/工单卡片跳转声明页：带危机预填起草
    stmtWorkOrderId: null,   // 从工单卡片跳转：起草时预关联的处置工单
    stmtOpenId: null,        // 跳转声明页时自动展开详情
    extOpenId: null,         // 从危机时间线锚点带入的待展开外部提交 id
    extFilterCrisis: null,   // 从危机卡片跳转外部协作看板带入的危机过滤
    toast: null
  }),
  actions: {
    setUser(u) {
      this.user = u
      actor = u
    },
    async load() {
      const d = await api('/state')
      this.sources = d.sources; this.hotWords = d.hotWords; this.activeAlerts = d.activeAlerts
      this.crises = d.crises; this.stats = d.stats; this.trend = d.trend
      this.loaded = true
    },
    msg(msg, type = 'info') { this.toast = { msg, type, id: Date.now() } },
    clearToast() { this.toast = null },
    async fetchPosts(filter) { return (await api('/posts', 'GET', null, filter)) },
    async addPost(p) {
      const r = await api('/posts', 'POST', p)
      await this.load() // 统计刷新（与批量导入统一）
      if (r.triggered && r.triggered.length) {
        const parts = r.triggered.map((t) =>
          t.deduped ? `${t.alert}（并入危机 #${t.crisisId}）`
            : t.crisisId ? `${t.alert}（已自动建档 #${t.crisisId}）` : t.alert)
        this.msg(`⚠️ 触发预警：${parts.join('、')}`, 'warn')
      } else this.msg('舆情已收录' + (r.sentiment === 'negative' ? '（负面）' : ''), 'success')
      return r
    },
    // 批量导入（可恢复任务）：创建任务，返回 jobId 供轮询进度/结果
    async createImport(items, idemKey, headers) {
      return await api('/imports', 'POST', { items, idem_key: idemKey || undefined }, null, headers)
    },
    async fetchJob(id) { return await api(`/imports/${id}`) },
    async fetchImports() { return (await api('/imports')).jobs },
    async pauseImport(id) { return await api(`/imports/${id}/pause`, 'POST') },
    async resumeImport(id) { return await api(`/imports/${id}/resume`, 'POST') },
    async fetchAlerts() { return await api('/alerts') },
    async saveAlert(a) { await api('/alerts', 'POST', a); await this.load(); this.msg('预警规则已保存', 'success') },
    async updateAlert(id, a) { await api(`/alerts/${id}`, 'PUT', a); await this.load(); this.msg('预警规则已更新，归并参数即时生效', 'success') },
    async toggleAlert(id) { await api(`/alerts/${id}/toggle`, 'POST'); await this.load() },
    async deleteAlert(id) { await api('/alerts/' + id, 'DELETE'); await this.load() },
    async resolveAlertEvent(id, note) {
      const r = await api(`/alert-events/${id}/resolve`, 'POST', { note })
      await this.load()
      if (r.already) this.msg('该预警已是解除状态，重复解除已忽略', 'info')
      else this.msg(r.crisisId ? `预警已解除，已同步危机 #${r.crisisId} 时间线` : '预警已解除', 'success')
      return r
    },
    async resolveAlert(id, note) {
      const r = await api(`/alerts/${id}/resolve`, 'POST', { note })
      await this.load()
      this.msg(r.resolved ? `已解除 ${r.resolved} 条未解除预警` : '该规则暂无未解除预警', r.resolved ? 'success' : 'info')
      return r
    },
    async addHotword(w) { await api('/hotwords', 'POST', w); await this.load() },
    async delHotword(id) { await api('/hotwords/' + id, 'DELETE'); await this.load() },
    async addCrisis(c) {
      const r = await api('/crisis', 'POST', c); await this.load(); this.msg('危机事件已建档', 'success'); return r.id
    },
    async setCrisisStatus(id, st) { await api(`/crisis/${id}/status`, 'POST', st); await this.load() },
    async addCrisisTimeline(id, t) { await api(`/crisis/${id}/timeline`, 'POST', t); await this.load() },
    async fetchCrisisReview(id) { return await api(`/crisis/${id}/review`) },
    async closeCrisis(id, summary) {
      const r = await api(`/crisis/${id}/close`, 'POST', { summary })
      await this.load()
      if (r.already) this.msg('事件已处于结案状态', 'info')
      else this.msg(r.resolved ? `事件已结案，同步解除 ${r.resolved} 条预警` : '事件已结案', 'success')
      return r
    },
    async reopenCrisis(id, note) {
      const r = await api(`/crisis/${id}/reopen`, 'POST', { note })
      await this.load()
      if (r.already) this.msg('事件未在结案状态，无需回滚', 'info')
      else this.msg(r.restored ? `已回滚结案，恢复 ${r.restored} 条未解除预警` : '已回滚结案，事件重新打开', 'success')
      return r
    },
    async delCrisis(id) { await api('/crisis/' + id, 'DELETE'); await this.load() },
    // ===== 通知中心：多渠道订阅与通知编排 =====
    async fetchTopics() { return await api('/topics') },
    async fetchNotifyOverview() { return await api('/notify/overview') },
    async saveChannel(c) { await api('/notify/channels', 'POST', c); this.msg('通知渠道已保存', 'success') },
    async toggleChannel(id) { await api(`/notify/channels/${id}/toggle`, 'POST') },
    async delChannel(id) { await api(`/notify/channels/${id}`, 'DELETE'); this.msg('渠道已删除', 'success') },
    async saveSub(s) { await api('/notify/subs', 'POST', s); this.msg('订阅已保存', 'success') },
    async toggleSub(id) { await api(`/notify/subs/${id}/toggle`, 'POST') },
    async delSub(id) { await api(`/notify/subs/${id}`, 'DELETE'); this.msg('订阅已删除', 'success') },
    async fetchNotifyTasks(status) { return await api('/notify/tasks', 'GET', null, status ? { status } : null) },
    async fetchNotifyTask(id) { return await api(`/notify/tasks/${id}`) },
    // 任务操作（暂停/恢复/重试/取消）：统一入口，错误 toast 由调用方处理
    async notifyTaskOp(id, op) {
      const r = await api(`/notify/tasks/${id}/${op}`, 'POST')
      await this.load() // 刷新全局角标（待处理通知计数）
      return r
    },
    // 确认回执：同步解除关联预警并写危机时间线
    async ackNotifyTask(id, note) {
      const r = await api(`/notify/tasks/${id}/ack`, 'POST', { note })
      await this.load()
      if (r.already) this.msg('该任务已确认过回执，重复确认已忽略', 'info')
      else if (r.resolved) this.msg(`回执已确认，同步解除 ${r.resolved} 条预警${r.crisisId ? `，已写入危机 #${r.crisisId} 时间线` : ''}`, 'success')
      else this.msg(`回执已确认${r.crisisId ? `，已写入危机 #${r.crisisId} 时间线` : ''}`, 'success')
      return r
    },
    async fetchNotifyLogs(taskId) { return (await api('/notify/logs', 'GET', null, taskId ? { task_id: taskId } : null)).logs },
    // ===== 数据源接入与采集调度 =====
    async fetchCollectOverview() { return await api('/collect/overview') },
    async saveCollectSource(s) { await api('/collect/sources', 'POST', s); this.msg('数据源连接已保存', 'success') },
    async updateCollectSource(id, s) { await api(`/collect/sources/${id}`, 'PUT', s); this.msg('数据源连接已更新', 'success') },
    async toggleCollectSource(id) { await api(`/collect/sources/${id}/toggle`, 'POST') },
    async delCollectSource(id) { await api(`/collect/sources/${id}`, 'DELETE'); this.msg('数据源已删除（采集记录保留）', 'success') },
    // 采集任务操作（启动/停止/立即采集/游标归零）：统一入口，错误 toast 由调用方处理
    async collectTaskOp(id, op) {
      const r = await api(`/collect/tasks/${id}/${op}`, 'POST')
      await this.load() // 采集带来新舆情：刷新总览统计与各闭环角标
      return r
    },
    async fetchCollectRuns(sourceId) { return (await api('/collect/runs', 'GET', null, sourceId ? { source_id: sourceId } : null)).runs },
    // ===== 跨角色危机协同工单 =====
    async fetchWorkOrders(filter) { return await api('/work-orders', 'GET', null, filter) },
    async fetchWorkOrder(id) { return await api(`/work-orders/${id}`) },
    async createWorkOrder(wo) {
      const r = await api('/work-orders', 'POST', wo)
      await this.load() // 刷新危机卡片工单统计与角标
      this.msg(`工单 #${r.id} 已拆分` + (wo.assignee ? `，已分派给 ${wo.assignee}` : '，待分派'), 'success')
      return r
    },
    // 工单操作（认领/指派/开始/阻塞/完成/回退/取消）：统一入口，错误 toast 由调用方处理
    async workOrderOp(id, op, body) {
      const r = await api(`/work-orders/${id}/${op}`, 'POST', body || {})
      await this.load() // 工单回写危机时间线/预警状态：刷新全局统计
      return r
    },
    // ===== 舆情传播路径分析 =====
    async fetchProp(filter) { return await api('/prop', 'GET', null, filter) },
    async fetchPropPath(id) { return (await api(`/prop/${id}`)).path },
    async createProp(p) {
      const r = await api('/prop', 'POST', p)
      await this.load()
      this.msg(`传播路径「${p.title || r.path.title}」已建档`, 'success')
      return r
    },
    async updateProp(id, body) {
      const r = await api(`/prop/${id}`, 'PUT', body)
      await this.load()
      return r
    },
    async deleteProp(id) {
      const r = await api(`/prop/${id}`, 'DELETE')
      await this.load()
      this.msg(`传播路径「${r.title}」已删除（来源工单保留）`, 'info')
      return r
    },
    async bindPropCrisis(id, crisis_id) { return await api(`/prop/${id}/crisis`, 'POST', { crisis_id }) },
    async attachPropAlert(id, alert_id, is_origin) { return await api(`/prop/${id}/alerts`, 'POST', { alert_id, is_origin }) },
    async detachPropAlert(id, alert_id) { return await api(`/prop/${id}/alerts/${alert_id}`, 'DELETE') },
    // 记录转发关系（返回阶段推进/通知事件/自动工单，调用方提示）
    async addPropEdge(id, edge) {
      const r = await api(`/prop/${id}/edges`, 'POST', edge)
      await this.load() // 角标（爆发路径数）刷新
      return r
    },
    async declineProp(id, note) {
      const r = await api(`/prop/${id}/decline`, 'POST', { note })
      await this.load()
      return r
    },
    async createPropWorkOrder(id, wo) {
      const r = await api(`/prop/${id}/work-orders`, 'POST', wo)
      await this.load()
      this.msg(`已从传播路径拆分跨角色工单 #${r.id}`, 'success')
      return r
    },
    // ===== 危机复盘报告 =====
    async fetchReports(filter) { return await api('/reports', 'GET', null, filter) },
    async fetchReport(id) { return (await api(`/reports/${id}`)).report },
    async createReport(body) {
      const r = await api('/reports', 'POST', body)
      await this.load()
      this.msg('复盘报告已创建，进入跨角色分段编制', 'success')
      return r
    },
    async renameReport(id, title) { return await api(`/reports/${id}`, 'PUT', { title }) },
    async saveReportSection(id, section, content) {
      return await api(`/reports/${id}/sections/${section}`, 'PUT', { content })
    },
    async refreshReportSnapshot(id) {
      const r = await api(`/reports/${id}/snapshot`, 'POST')
      this.msg('聚合数据已刷新：预警 / 时间线 / 传播路径 / 工单 / 通知回执', 'success')
      return r
    },
    async submitReport(id, note) {
      const r = await api(`/reports/${id}/submit`, 'POST', { note })
      await this.load()
      this.msg(`报告已提交审核（送审版本 v${r.version} 已归档）`, 'success')
      return r
    },
    async approveReport(id, note) {
      const r = await api(`/reports/${id}/approve`, 'POST', { note })
      await this.load()
      this.msg(`报告已审核通过并发布（v${r.version}），结案档案与统计口径已回写`, 'success')
      return r
    },
    async rejectReport(id, note) {
      const r = await api(`/reports/${id}/reject`, 'POST', { note })
      await this.load()
      this.msg('报告已驳回，退回编制中', 'info')
      return r
    },
    async rollbackReport(id, version, note) {
      const r = await api(`/reports/${id}/rollback`, 'POST', { version, note })
      await this.load()
      this.msg(`已回滚至 v${r.targetVersion}（新归档 v${r.newVersion}），退回编制中`, 'success')
      return r
    },
    // ===== 危机声明（公关起草 → 法务审核 → 分渠道发布登记） =====
    async fetchStatements(filter) { return await api('/statements', 'GET', null, filter) },
    async fetchStatement(id) { return (await api(`/statements/${id}`)).statement },
    async createStatement(body) {
      const r = await api('/statements', 'POST', body)
      await this.load()
      this.msg('危机声明已起草', 'success')
      return r
    },
    async editStatement(id, body) { return await api(`/statements/${id}`, 'PUT', body) },
    async submitStatement(id, body) {
      const r = await api(`/statements/${id}/submit`, 'POST', body || {})
      await this.load()
      this.msg('声明已提交法务审核', 'success')
      return r
    },
    async approveStatement(id, note) {
      const r = await api(`/statements/${id}/approve`, 'POST', { note })
      await this.load()
      this.msg('法务审核通过，声明可发起发布', 'success')
      return r
    },
    async rejectStatement(id, note) {
      const r = await api(`/statements/${id}/reject`, 'POST', { note })
      await this.load()
      this.msg('声明已驳回，退回公关修改', 'info')
      return r
    },
    async startStatementPublish(id, body) {
      const r = await api(`/statements/${id}/publish`, 'POST', body || {})
      await this.load()
      this.msg('已发起分渠道发布，等待各渠道执行登记', 'success')
      return r
    },
    async cancelStatement(id, reason) {
      const r = await api(`/statements/${id}/cancel`, 'POST', { reason })
      await this.load()
      this.msg('声明已取消', 'info')
      return r
    },
    async registerStmtChannel(chId, body) {
      const r = await api(`/statement-channels/${chId}/register`, 'POST', body)
      await this.load()
      return r
    },
    async retryStmtChannel(chId, body) {
      const r = await api(`/statement-channels/${chId}/retry`, 'POST', body || {})
      await this.load()
      this.msg('渠道已重置为待执行，可重新登记结果', 'success')
      return r
    },
    async cancelStmtChannel(chId, reason) {
      const r = await api(`/statement-channels/${chId}/cancel`, 'POST', { reason })
      await this.load()
      this.msg('该渠道已取消', 'info')
      return r
    },
    // ===== 外部协作反馈门户（内部审核看板） =====
    async fetchExtSubmissions(filter) { return await api('/ext-submissions', 'GET', null, filter) },
    async fetchExtSubmission(id) { return (await api(`/ext-submissions/${id}`)).submission },
    async fetchExtPartners() { return (await api('/ext-partners')).items },
    async createExtPartner(p) {
      await api('/ext-partners', 'POST', p)
      this.msg('外部协作方已登记，可凭口令在门户提交', 'success')
    },
    async updateExtPartner(id, p) { await api(`/ext-partners/${id}`, 'PUT', p); this.msg('协作方信息已更新', 'success') },
    async toggleExtPartner(id) { return await api(`/ext-partners/${id}/toggle`, 'POST') },
    async receiveExt(id) {
      const r = await api(`/ext-submissions/${id}/receive`, 'POST')
      await this.load()
      return r
    },
    async acceptExt(id, body) {
      const r = await api(`/ext-submissions/${id}/accept`, 'POST', body)
      await this.load()
      this.msg(`已采纳 ${r.crisisId ? '并回写危机时间线' : ''}${r.workOrderId ? '与工单' : ''}${r.resolved ? `，联动解除 ${r.resolved} 条预警` : ''}`, 'success')
      return r
    },
    async rejectExt(id, reason) {
      const r = await api(`/ext-submissions/${id}/reject`, 'POST', { reason })
      await this.load()
      this.msg('已驳回，提交方可在门户查看原因并补充重提', 'info')
      return r
    },
    async bindExtCrisis(id, crisis_id) {
      const r = await api(`/ext-submissions/${id}/crisis`, 'POST', { crisis_id })
      await this.load()
      this.msg(crisis_id ? `已挂接危机 #${crisis_id}` : '已解除危机挂接', 'success')
      return r
    },
    // ===== 外部协作门户（协作方口令鉴权） =====
    setPortalCode(code) { portalCode = code },
    async portalBootstrap() { return await portalApi('/bootstrap') },
    async portalSubmit(body) {
      const r = await portalApi('/submissions', 'POST', body)
      await this.load()
      this.msg(`提交成功，编号 ${r.code}${r.is_urgent || body.is_urgent ? '（已紧急升级通知内部）' : '，等待内部审核'}`, 'success')
      return r
    },
    async portalFetch(id) { return (await portalApi(`/submissions/${id}`)).submission },
    async portalSupplement(id, note) {
      const r = await portalApi(`/submissions/${id}/supplement`, 'POST', { note })
      await this.load()
      this.msg('补充材料已提交', 'success')
      return r
    },
    async portalWithdraw(id, reason) {
      const r = await portalApi(`/submissions/${id}/withdraw`, 'POST', { reason })
      await this.load()
      this.msg('提交已撤回', 'info')
      return r
    }
  }
})