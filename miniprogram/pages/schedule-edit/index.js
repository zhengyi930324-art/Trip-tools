// pages/schedule-edit/index.js · 新增/编辑行程项
const { ensureLogin } = require('../../utils/auth')
const { daysBetween, fenToYuan, parseDate, formatDate, weekday } = require('../../utils/format')
const { SCHEDULE_TYPES, getCategory } = require('../../utils/constants')
const app = getApp()

// 待办上限，与云函数 MAX_TODOS 保持一致
const MAX_TODOS = 30

// 附件图片上限（与 wx.chooseImage 单次上限一致）
const MAX_IMAGES = 9

// 兼容旧数据：单图 imageFileID → 数组
function normalizeImageIDs(obj) {
  if (obj && Array.isArray(obj.imageFileIDs) && obj.imageFileIDs.length) return obj.imageFileIDs.slice(0, MAX_IMAGES)
  if (obj && obj.imageFileID) return [obj.imageFileID]
  return []
}

// 生成待办本地 id
let todoSeq = 0
function genTodoId() {
  todoSeq += 1
  return `t${Date.now().toString(36)}${todoSeq}${Math.random().toString(36).slice(2, 6)}`
}

Page({
  data: {
    id: null,
    isEdit: false,
    day: 1,
    dayIndex: 0,
    dayRange: [],
    startTime: '',
    endTime: '',
    type: 'scenic',
    title: '',
    location: '',
    latitude: null,
    longitude: null,
    note: '',
    todos: [],
    todoInput: '',
    todoDoneCount: 0,
    costRecordId: null,
    members: [],
    allRecords: [],
    recordOptions: [],
    recordPickerRange: [],
    costRecordIndex: -1,
    costSummary: '',
    types: SCHEDULE_TYPES,
    trip: null,
    imageFileIDs: [],
    loading: false,
    saving: false,
    uploading: false
  },

  async onLoad(options) {
    const data = await ensureLogin()
    if (!data) return

    const trip = data.currentTrip
    const totalDays = trip && trip.startDate && trip.endDate
      ? Math.max(1, daysBetween(trip.startDate, trip.endDate) + 1)
      : 7
    // 选项直接展示日期和星期，不用 Day N（容易和几号看混）
    const start = trip && trip.startDate ? parseDate(trip.startDate) : null
    const dayRange = Array.from({ length: totalDays }, (_, i) => {
      if (!start || isNaN(start.getTime())) return `第 ${i + 1} 天`
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      return `${formatDate(d, 'MM-DD')} ${weekday(d)}`
    })

    this.setData({ trip, dayRange, loading: true })

    // 载入行程列表（关联账目排除已关联 + 编辑回显）、账目供「关联账目」、成员供待办 @人 选择，失败不阻塞行程编辑
    const [scheduleList] = await Promise.all([
      this.loadScheduleList(),
      this.loadRecords(),
      this.loadMembers()
    ])
    this._scheduleList = scheduleList

    if (options.id) {
      this.setData({ id: options.id, isEdit: true })
      wx.setNavigationBarTitle({ title: '编辑行程' })
      this.applySchedule(scheduleList.find(s => s._id === options.id))
    } else if (options.day) {
      const day = parseInt(options.day) || 1
      this.setData({ day, dayIndex: day - 1 })
    }
    this.refreshRecordOptions()
    this.setData({ loading: false })
  },

  async loadScheduleList() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'db',
        data: { action: 'listSchedule', data: { tripId: app.globalData.currentTrip._id } }
      })
      return (res.result && res.result.list) || []
    } catch (err) {
      console.warn('[schedule-edit] 行程列表载入失败，关联账目不排除已关联', err)
      return []
    }
  },

  async loadRecords() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'db',
        data: { action: 'listRecords', data: { tripId: app.globalData.currentTrip._id } }
      })
      this.setData({ allRecords: (res.result && res.result.list) || [] })
    } catch (err) {
      console.warn('[schedule-edit] 账目载入失败，关联账目不可用', err)
      this.setData({ allRecords: [] })
    }
  },

  async loadMembers() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'db',
        data: { action: 'listMembers', data: { tripId: app.globalData.currentTrip._id } }
      })
      this.setData({ members: (res.result && res.result.list) || [] })
    } catch (err) {
      console.warn('[schedule-edit] 成员载入失败，@人不可用', err)
      this.setData({ members: [] })
    }
  },

  // 列出可关联账目：全部未被其他行程关联的账目（发生日期倒序）
  refreshRecordOptions() {
    const usedIds = {}
    ;(this._scheduleList || []).forEach(s => {
      if (s.costRecordId && s._id !== this.data.id) usedIds[s.costRecordId] = true
    })
    const list = this.data.allRecords
      .filter(r => !usedIds[r._id])
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .map(r => {
        const c = getCategory(r.category)
        return {
          _id: r._id,
          icon: c.icon,
          color: c.color,
          label: r.note || c.name,
          dateShort: (r.date || '').slice(5),
          amountYuan: fenToYuan(r.amount)
        }
      })
    this.setData({
      recordOptions: list,
      recordPickerRange: list
        .map(r => `${r.label} ${r.dateShort} ¥${r.amountYuan}`)
        .concat(['清除关联'])
    })
    this.syncCostDisplay()
  },

  onCostRecordChange(e) {
    const idx = parseInt(e.detail.value)
    // 选择器末项为「清除关联」
    if (idx >= this.data.recordOptions.length) {
      this.setData({ costRecordId: null })
    } else {
      this.setData({ costRecordId: this.data.recordOptions[idx]._id })
    }
    this.syncCostDisplay()
  },

  // 同步选择器回显：选中项下标与摘要文案
  syncCostDisplay() {
    const idx = this.data.recordOptions.findIndex(r => r._id === this.data.costRecordId)
    const opt = idx >= 0 ? this.data.recordOptions[idx] : null
    this.setData({
      costRecordIndex: idx,
      costSummary: opt ? `${opt.label} · ${opt.dateShort} · ¥${opt.amountYuan}` : ''
    })
  },

  // 编辑模式：从并行载入的行程列表回显字段
  applySchedule(item) {
    if (!item) {
      wx.showToast({ title: '行程不存在', icon: 'none' })
      return
    }
    this.setData({
      day: item.day,
      dayIndex: item.day - 1,
      startTime: item.startTime || '',
      endTime: item.endTime || '',
      type: item.type,
      title: item.title || '',
      location: item.location || '',
      latitude: typeof item.latitude === 'number' ? item.latitude : null,
      longitude: typeof item.longitude === 'number' ? item.longitude : null,
      note: item.note || '',
      costRecordId: item.costRecordId || null,
      imageFileIDs: normalizeImageIDs(item)
    })
    this.applyTodos(item.todos)
  },

  onDayChange(e) {
    const idx = parseInt(e.detail.value)
    this.setData({ dayIndex: idx, day: idx + 1 })
  },

  onStartTimeChange(e) {
    this.setData({ startTime: e.detail.value })
  },

  onEndTimeChange(e) {
    this.setData({ endTime: e.detail.value })
  },

  onTypeTap(e) {
    const { key } = e.currentTarget.dataset
    this.setData({ type: key })
  },

  onTitleInput(e) {
    this.setData({ title: e.detail.value })
  },

  // 地图选点：原生选点页搜 POI 定位，回填名称与经纬度；已有坐标时以原点为中心二次编辑
  onChooseLocation() {
    const opts = {
      success: (res) => {
        this.setData({
          location: res.name || res.address || '',
          latitude: res.latitude,
          longitude: res.longitude
        })
      },
      fail: (err) => {
        // 用户取消选点不提示；失败（如接口未审批）给明确文案
        if (err && /cancel/i.test(err.errMsg || '')) return
        console.error('[schedule-edit] 选点失败', err)
        wx.showToast({ title: '选点不可用：请确认位置接口权限', icon: 'none' })
      }
    }
    if (typeof this.data.latitude === 'number' && typeof this.data.longitude === 'number') {
      opts.latitude = this.data.latitude
      opts.longitude = this.data.longitude
    }
    wx.chooseLocation(opts)
  },

  // 查看已选坐标：调起微信内置地图展示（可导航）
  onViewLocation() {
    const { latitude, longitude, location, title } = this.data
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return
    wx.openLocation({
      latitude,
      longitude,
      name: location || title || '',
      address: location || '',
      fail: () => wx.showToast({ title: '打开地图失败', icon: 'none' })
    })
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value })
  },

  // ===== 附件图片 =====

  async onChooseImage() {
    if (this.data.uploading) return
    const remain = MAX_IMAGES - this.data.imageFileIDs.length
    if (remain <= 0) {
      wx.showToast({ title: `最多 ${MAX_IMAGES} 张`, icon: 'none' })
      return
    }
    let tempFilePaths
    try {
      const res = await wx.chooseImage({
        count: remain,
        sizeType: ['compressed'],
        sourceType: ['album', 'camera']
      })
      tempFilePaths = res.tempFilePaths
    } catch (err) {
      // 用户取消选图，不提示
      return
    }

    await this.uploadPaths(tempFilePaths)
  },

  // 逐张上传：每张自带弱网自动重试，仍失败的统一弹一次手动重试
  async uploadPaths(paths) {
    this.setData({ uploading: true })
    wx.showLoading({ title: '上传中...', mask: true })
    const before = this.data.imageFileIDs.length
    const failed = []
    for (const path of paths) {
      try {
        const fileID = await this.uploadWithRetry(path)
        this.setData({ imageFileIDs: this.data.imageFileIDs.concat([fileID]) })
      } catch (err) {
        console.error('[schedule-edit] 上传图片失败', err)
        failed.push(path)
      }
    }
    wx.hideLoading()
    this.setData({ uploading: false })
    const added = this.data.imageFileIDs.length - before
    if (added > 0) wx.showToast({ title: `已上传 ${added} 张`, icon: 'success' })
    if (failed.length) this.offerRetryUpload(failed)
  },

  // 弱网重试：最多 3 次，每次间隔递增
  async uploadWithRetry(filePath, retries = 2) {
    const cloudPath = `schedule/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`
    let lastErr
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await wx.cloud.uploadFile({ cloudPath, filePath })
        return res.fileID
      } catch (err) {
        lastErr = err
        console.warn(`[schedule-edit] 上传第 ${i + 1} 次失败`, err)
        if (i < retries) await new Promise(r => setTimeout(r, 600 * (i + 1)))
      }
    }
    throw lastErr
  },

  // 自动重试仍失败 → 让用户对失败图片统一手动重试
  offerRetryUpload(paths) {
    wx.showModal({
      title: '图片上传失败',
      content: `${paths.length} 张图片没传成功，可能是网络不稳定，是否重试？`,
      confirmText: '重试',
      cancelText: '暂不上传',
      success: async (res) => {
        if (!res.confirm) return
        await this.uploadPaths(paths)
      }
    })
  },

  onRemoveImage(e) {
    const idx = parseInt(e.currentTarget.dataset.idx)
    const ids = this.data.imageFileIDs.slice()
    ids.splice(idx, 1)
    this.setData({ imageFileIDs: ids })
  },

  // 点缩略图放大：可按顺序翻看全部附图
  onPreviewImage(e) {
    const idx = parseInt(e.currentTarget.dataset.idx)
    const urls = this.data.imageFileIDs
    wx.previewImage({ current: urls[idx], urls })
  },

  // ===== 待办清单 =====

  // 把云端 todos 规范化后写入 data
  applyTodos(raw) {
    const todos = (Array.isArray(raw) ? raw : [])
      .filter(t => t && t.id && String(t.text || '').trim())
      .map(t => ({
        id: t.id,
        text: String(t.text),
        done: !!t.done,
        ownerId: t.ownerId || '',
        ownerName: t.ownerName || ''
      }))
    this.setData({ todos, todoDoneCount: todos.filter(t => t.done).length })
  },

  onTodoInput(e) {
    this.setData({ todoInput: e.detail.value })
  },

  onTodoAdd() {
    const text = this.data.todoInput.trim()
    if (!text) {
      wx.showToast({ title: '请输入待办内容', icon: 'none' })
      return
    }
    if (this.data.todos.length >= MAX_TODOS) {
      wx.showToast({ title: `最多 ${MAX_TODOS} 条待办`, icon: 'none' })
      return
    }
    const todos = this.data.todos.concat([{ id: genTodoId(), text, done: false, ownerId: '', ownerName: '' }])
    this.setData({ todos, todoInput: '', todoDoneCount: todos.filter(t => t.done).length })
  },

  onTodoToggle(e) {
    const index = parseInt(e.currentTarget.dataset.index)
    const todos = this.data.todos.map((t, i) => (i === index ? { ...t, done: !t.done } : t))
    this.setData({ todos, todoDoneCount: todos.filter(t => t.done).length })
  },

  onTodoDelete(e) {
    const index = parseInt(e.currentTarget.dataset.index)
    const todos = this.data.todos.filter((t, i) => i !== index)
    this.setData({ todos, todoDoneCount: todos.filter(t => t.done).length })
  },

  // 点 @ 徽章选负责人；actionSheet 最多 6 项，成员过多时截断
  onTodoOwnerTap(e) {
    const index = parseInt(e.currentTarget.dataset.index)
    const members = this.data.members
    if (!members.length) {
      wx.showToast({ title: '成员列表没加载出来', icon: 'none' })
      return
    }
    const pickable = members.slice(0, 5)
    wx.showActionSheet({
      itemList: pickable.map(m => m.name).concat(['清除负责人']),
      success: res => {
        const pick = res.tapIndex
        const owner = pick < pickable.length
          ? { ownerId: pickable[pick]._id, ownerName: pickable[pick].name }
          : { ownerId: '', ownerName: '' }
        const todos = this.data.todos.map((t, i) => (i === index ? { ...t, ...owner } : t))
        this.setData({ todos })
      }
    })
  },

  async onSave() {
    const { day, startTime, endTime, type, title, location, latitude, longitude, note, todos, costRecordId, imageFileIDs, id, isEdit } = this.data

    if (!title.trim()) {
      wx.showToast({ title: '请输入标题', icon: 'none' })
      return
    }
    if (!day || day < 1) {
      wx.showToast({ title: '请选择日期', icon: 'none' })
      return
    }

    this.setData({ saving: true })
    try {
      const action = isEdit ? 'updateSchedule' : 'addSchedule'
      const data = {
        day,
        startTime,
        endTime,
        type,
        title: title.trim(),
        location,
        latitude,
        longitude,
        note,
        todos,
        costRecordId: costRecordId || null,
        // imageFileID 保留为首图，兼容旧版本包读取
        imageFileID: imageFileIDs[0] || '',
        imageFileIDs
      }
      data.tripId = app.globalData.currentTrip._id
      if (isEdit) data._id = id

      const res = await wx.cloud.callFunction({
        name: 'db',
        data: { action, data }
      })

      if (res.result && res.result.error) {
        throw new Error(res.result.error)
      }

      wx.showToast({ title: isEdit ? '已更新' : '已添加', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 600)
    } catch (err) {
      console.error('[schedule-edit] 保存失败', err)
      wx.showToast({ title: err.message || '保存失败', icon: 'none' })
      this.setData({ saving: false })
    }
  },

  async onDelete() {
    const { id } = this.data
    if (!id) return

    const confirm = await new Promise(resolve => {
      wx.showModal({
        title: '确认删除',
        content: '删除后无法恢复',
        confirmColor: '#FF3B30',
        success: res => resolve(res.confirm)
      })
    })

    if (!confirm) return

    try {
      await wx.cloud.callFunction({
        name: 'db',
        data: { action: 'deleteSchedule', data: { tripId: app.globalData.currentTrip._id, _id: id } }
      })
      wx.showToast({ title: '已删除', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 600)
    } catch (err) {
      console.error('[schedule-edit] 删除失败', err)
      wx.showToast({ title: '删除失败', icon: 'none' })
    }
  }
})
