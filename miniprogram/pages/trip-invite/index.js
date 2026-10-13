const { ensureLogin } = require('../../utils/auth')

const app = getApp()

Page({
  data: { trip: null, memberCount: 0, alreadyMember: false, loading: true, joining: false, token: '' },

  async onLoad(options = {}) {
    const token = options.token || app.globalData.pendingInviteToken || wx.getStorageSync('pendingInviteToken') || ''
    this.setData({ token })
    if (token) {
      app.globalData.pendingInviteToken = token
      wx.setStorageSync('pendingInviteToken', token)
    }
    const user = await ensureLogin({ allowNoTrip: true })
    if (!user) return
    await this.loadInvite()
  },

  async loadInvite() {
    try {
      const res = await wx.cloud.callFunction({ name: 'db', data: { action: 'getInvite', data: { token: this.data.token } } })
      if (res.result && res.result.error) {
        if (['INVALID_INVITE', 'INVITE_USED', 'TRIP_NOT_FOUND'].includes(res.result.code)) this.clearPendingInvite()
        throw new Error(res.result.error)
      }
      this.setData({ trip: res.result.trip, memberCount: res.result.memberCount, alreadyMember: !!res.result.alreadyMember, loading: false })
    } catch (err) {
      wx.showToast({ title: err.message || '邀请链接无效', icon: 'none' })
      this.setData({ loading: false })
    }
  },

  async onJoinTap() {
    this.setData({ joining: true })
    try {
      const res = await wx.cloud.callFunction({ name: 'db', data: { action: 'joinTrip', data: { token: this.data.token } } })
      if (res.result && res.result.error) throw new Error(res.result.error)
      const trips = await wx.cloud.callFunction({ name: 'db', data: { action: 'listTrips' } })
      app.globalData.currentTrips = (trips.result && trips.result.list) || []
      app.globalData.currentTrip = app.globalData.currentTrips.find(trip => trip._id === res.result.tripId)
      app.globalData.pendingInviteToken = ''
      wx.removeStorageSync('pendingInviteToken')
      wx.switchTab({ url: '/pages/trip/index' })
    } catch (err) {
      wx.showToast({ title: err.message || '加入失败', icon: 'none' })
      this.setData({ joining: false })
    }
  },

  clearPendingInvite() {
    app.globalData.pendingInviteToken = ''
    wx.removeStorageSync('pendingInviteToken')
  },

  onBackTap() {
    this.clearPendingInvite()
    wx.reLaunch({ url: '/pages/trip-select/index' })
  }
})
