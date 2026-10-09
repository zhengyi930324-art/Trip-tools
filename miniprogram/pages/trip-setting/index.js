// pages/trip-setting/index.js · 旅程设置
const { ensureLogin } = require('../../utils/auth')

const app = getApp()

Page({
  data: {
    trip: null,
    name: '',
    startDate: '',
    endDate: '',
    saving: false
  },

  async onLoad() {
    const data = await ensureLogin()
    if (!data) return

    const trip = data.currentTrip
    if (trip) {
      this.setData({
        trip,
        name: trip.name || '',
        startDate: trip.startDate || '',
        endDate: trip.endDate || ''
      })
    }
  },

  onNameInput(e) {
    this.setData({ name: e.detail.value })
  },

  onStartDateChange(e) {
    this.setData({ startDate: e.detail.value })
  },

  onEndDateChange(e) {
    this.setData({ endDate: e.detail.value })
  },

  async onSave() {
    const { name, startDate, endDate } = this.data

    if (!name.trim()) {
      wx.showToast({ title: '请输入旅程名字', icon: 'none' })
      return
    }
    if (!startDate || !endDate) {
      wx.showToast({ title: '请选择日期', icon: 'none' })
      return
    }
    if (startDate > endDate) {
      wx.showToast({ title: '出发日不能晚于返回日', icon: 'none' })
      return
    }

    this.setData({ saving: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'db',
        data: {
          action: 'updateTrip',
          data: { name: name.trim(), startDate, endDate }
        }
      })

      if (res.result && res.result.error) {
        throw new Error(res.result.error)
      }

      // 更新全局数据
      const updatedTrip = {
        ...app.globalData.currentTrip,
        name: name.trim(),
        startDate,
        endDate
      }
      app.globalData.currentTrip = updatedTrip
      this.setData({ trip: updatedTrip })

      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 600)
    } catch (err) {
      console.error('[trip-setting] 保存失败', err)
      wx.showToast({ title: err.message || '保存失败', icon: 'none' })
      this.setData({ saving: false })
    }
  }
})
