const { ensureLogin } = require('../../utils/auth')

const app = getApp()

Page({
  data: {
    trips: [],
    loading: true,
    creating: false,
    name: '',
    startDate: '',
    endDate: ''
  },

  async onLoad(options) {
    this._forceChoose = options && options.choose === '1'
    const user = await ensureLogin({ allowNoTrip: true })
    if (!user) return
    if (app.globalData.pendingInviteToken) {
      wx.redirectTo({ url: `/pages/trip-invite/index?token=${app.globalData.pendingInviteToken}` })
      return
    }

    if (!this._forceChoose) {
      const trips = app.globalData.currentTrips || []
      const selectedTripId = wx.getStorageSync('selectedTripId')
      const selectedTrip = trips.find(trip => trip._id === selectedTripId)
      this.setData({ trips, loading: false })
      if (selectedTrip) {
        this.enterTrip(selectedTrip)
      } else if (selectedTripId) {
        wx.removeStorageSync('selectedTripId')
      }
      return
    }

    this.setData({ trips: app.globalData.currentTrips || [], loading: false })
    this.loadTrips()
  },

  async loadTrips() {
    this.setData({ loading: true })
    try {
      const res = await wx.cloud.callFunction({ name: 'db', data: { action: 'listTrips' } })
      const trips = (res.result && res.result.list) || []
      app.globalData.currentTrips = trips
      this.setData({ trips, loading: false })

      const selectedTripId = wx.getStorageSync('selectedTripId')
      const selectedTrip = trips.find(trip => trip._id === selectedTripId)
      if (selectedTrip && !this._forceChoose) {
        this.enterTrip(selectedTrip)
      } else if (!selectedTrip && selectedTripId) {
        wx.removeStorageSync('selectedTripId')
      }
    } catch (err) {
      console.error('[trip-select] 获取旅程失败', err)
      wx.showToast({ title: '获取旅程失败', icon: 'none' })
      this.setData({ loading: false })
    }
  },

  onNameInput(e) { this.setData({ name: e.detail.value }) },
  onStartDateChange(e) { this.setData({ startDate: e.detail.value }) },
  onEndDateChange(e) { this.setData({ endDate: e.detail.value }) },
  onCreateTap() { this.setData({ creating: true }) },
  onCancelCreate() { this.setData({ creating: false }) },

  async onCreateSubmit() {
    const { name, startDate, endDate } = this.data
    if (!name.trim()) return wx.showToast({ title: '请输入旅程名字', icon: 'none' })
    if (!startDate || !endDate || startDate > endDate) return wx.showToast({ title: '请选择有效的旅程日期', icon: 'none' })
    this.setData({ loading: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'db',
        data: { action: 'createTrip', data: { name: name.trim(), startDate, endDate } }
      })
      if (res.result && res.result.error) throw new Error(res.result.error)
      this.enterTrip(res.result.trip)
    } catch (err) {
      console.error('[trip-select] 创建旅程失败', err)
      wx.showToast({ title: err.message || '创建失败', icon: 'none' })
      this.setData({ loading: false })
    }
  },

  onTripTap(e) {
    const tripId = e.currentTarget.dataset.id
    const trip = this.data.trips.find(item => item._id === tripId)
    if (!trip) {
      wx.showToast({ title: '没有找到这个旅程', icon: 'none' })
      return
    }
    this.enterTrip(trip)
  },

  enterTrip(trip) {
    app.globalData.currentTrip = trip
    wx.setStorageSync('selectedTripId', trip._id)
    wx.switchTab({
      url: '/pages/trip/index',
      fail: err => {
        console.error('[trip-select] 进入旅程失败', err)
        wx.showToast({ title: '进入旅程失败', icon: 'none' })
      }
    })
  }
})
