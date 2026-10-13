// pages/record-edit/index.js · 记一笔 / 编辑账目
const { ensureLogin } = require('../../utils/auth')
const { fenToYuan, yuanToFen, today, daysBetween } = require('../../utils/format')
const { CATEGORIES } = require('../../utils/constants')

const app = getApp()

// 附件图片上限（与 wx.chooseImage 单次上限一致）
const MAX_IMAGES = 9

// 兼容旧数据：单图 imageFileID → 数组
function normalizeImageIDs(obj) {
  if (obj && Array.isArray(obj.imageFileIDs) && obj.imageFileIDs.length) return obj.imageFileIDs.slice(0, MAX_IMAGES)
  if (obj && obj.imageFileID) return [obj.imageFileID]
  return []
}

Page({
  data: {
    id: null,
    isEdit: false,
    amount: '',
    category: 'food',
    date: '',
    payerId: '',
    participantIds: [],
    note: '',
    imageFileIDs: [],
    categories: CATEGORIES,
    members: [],
    trip: null,
    loading: false,
    saving: false,
    uploading: false
  },

  async onLoad(options) {
    const data = await ensureLogin()
    if (!data) return

    const member = data.currentMember
    this.setData({
      date: today(),
      payerId: member._id,
      trip: data.currentTrip
    })

    await this.loadMembers()

    // 默认全选所有成员
    this.setData({
      participantIds: this.data.members.map(m => m._id)
    })

    // 编辑模式
    if (options.id) {
      this.setData({ id: options.id, isEdit: true })
      wx.setNavigationBarTitle({ title: '编辑账目' })
      await this.loadRecord(options.id)
    }
  },

  async loadMembers() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'db',
        data: { action: 'listMembers', data: { tripId: app.globalData.currentTrip._id } }
      })
      const members = (res.result && res.result.list) || []
      this.setData({ members })
    } catch (err) {
      console.error('[record-edit] 加载成员失败', err)
    }
  },

  async loadRecord(id) {
    this.setData({ loading: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'db',
        data: { action: 'getRecord', data: { tripId: app.globalData.currentTrip._id, _id: id } }
      })
      const record = res.result && res.result.record
      if (!record) {
        wx.showToast({ title: '记录不存在', icon: 'none' })
        this.setData({ loading: false })
        return
      }

      // 清洗无效引用（非 cloud:// 的临时路径/空值），避免缩略图与预览卡死
      const rawIds = normalizeImageIDs(record)
      const imageFileIDs = rawIds.filter(x => typeof x === 'string' && x.startsWith('cloud://'))
      if (imageFileIDs.length !== rawIds.length) {
        wx.showToast({ title: `有 ${rawIds.length - imageFileIDs.length} 张图片引用无效已移除，可重新添加`, icon: 'none' })
      }

      this.setData({
        amount: fenToYuan(record.amount),
        // 遗留分类（娱乐/购物）已不存在，回显归到「其他」，保存时即转换
        category: CATEGORIES.some(c => c.key === record.category) ? record.category : 'other',
        date: record.date,
        payerId: record.payerId,
        participantIds: record.participantIds || [],
        note: record.note || '',
        imageFileIDs,
        loading: false
      })
    } catch (err) {
      console.error('[record-edit] 加载记录失败', err)
      wx.showToast({ title: '加载失败', icon: 'none' })
      this.setData({ loading: false })
    }
  },

  // 根据账目发生日期换算它属于旅程的第几天（超出旅程区间返回 null）
  // 行程页按天统计花费依赖 day，日期口径为实际发生日期而非付账时间
  computeDay(dateStr) {
    const trip = this.data.trip
    if (!trip || !trip.startDate || !trip.endDate || !dateStr) return null
    const day = daysBetween(trip.startDate, dateStr) + 1
    const totalDays = daysBetween(trip.startDate, trip.endDate) + 1
    if (day < 1 || day > totalDays) return null
    return day
  },

  onAmountInput(e) {
    this.setData({ amount: e.detail.value })
  },

  onCategoryTap(e) {
    const { key } = e.currentTarget.dataset
    this.setData({ category: key })
  },

  onDateChange(e) {
    this.setData({ date: e.detail.value })
  },

  onPayerTap(e) {
    const { id } = e.currentTarget.dataset
    this.setData({ payerId: id })
  },

  onParticipantTap(e) {
    const { id } = e.currentTarget.dataset
    const ids = this.data.participantIds.slice()
    const idx = ids.indexOf(id)
    if (idx >= 0) {
      // 至少保留一个
      if (ids.length === 1) {
        wx.showToast({ title: '至少选一个参与人', icon: 'none' })
        return
      }
      ids.splice(idx, 1)
    } else {
      ids.push(id)
    }
    this.setData({ participantIds: ids })
  },

  onSelectAllParticipants() {
    this.setData({
      participantIds: this.data.members.map(m => m._id)
    })
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value })
  },

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
        console.error('[record-edit] 上传图片失败', err)
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
    const cloudPath = `records/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`
    let lastErr
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await wx.cloud.uploadFile({ cloudPath, filePath })
        return res.fileID
      } catch (err) {
        lastErr = err
        console.warn(`[record-edit] 上传第 ${i + 1} 次失败`, err)
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

  async onSave() {
    const { amount, category, date, payerId, participantIds, note, imageFileIDs, id, isEdit } = this.data

    const amountFen = yuanToFen(amount)
    if (!amountFen || amountFen <= 0) {
      wx.showToast({ title: '请输入金额', icon: 'none' })
      return
    }
    if (!payerId) {
      wx.showToast({ title: '请选择付款人', icon: 'none' })
      return
    }
    if (participantIds.length === 0) {
      wx.showToast({ title: '至少选择一个参与人', icon: 'none' })
      return
    }

    this.setData({ saving: true })
    try {
      const action = isEdit ? 'updateRecord' : 'addRecord'
      const data = {
        amount: amountFen,
        category,
        date,
        // day 由日期 + 旅程出发日推算，行程页按天统计花费依赖它
        day: this.computeDay(date),
        payerId,
        participantIds,
        note,
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

      wx.showToast({ title: isEdit ? '已更新' : '已记账', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 600)
    } catch (err) {
      console.error('[record-edit] 保存失败', err)
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
        data: { action: 'deleteRecord', data: { tripId: app.globalData.currentTrip._id, _id: id } }
      })
      wx.showToast({ title: '已删除', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 600)
    } catch (err) {
      console.error('[record-edit] 删除失败', err)
      wx.showToast({ title: '删除失败', icon: 'none' })
    }
  }
})
