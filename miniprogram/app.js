// app.js
App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
      return
    }
    wx.cloud.init({
      env: 'cloud1-d2gttkgdgd065942b',
      traceUser: true
    })

    // 启动登录流程，保存 promise 供页面 await
    this.globalData.loginReady = this.doLogin().then(result => {
      this.prewarm(result.trips || [])
      return result
    })
  },

  // 已加入旅程时才预热行程相关云函数。
  prewarm(trips) {
    const tripId = trips[0] && trips[0]._id
    if (!tripId) return
    ;[
      { name: 'db', data: { action: 'getTrip', data: { tripId } } },
      { name: 'getStats', data: { tripId } },
      { name: 'settle', data: { tripId } }
    ].forEach(item => {
      wx.cloud.callFunction(item).catch(() => {})
    })
  },

  globalData: {
    openId: null,
    currentMember: null,
    currentTrip: null,
    currentTrips: [],
    pendingInviteToken: '',
    loginReady: null
  },

  async doLogin() {
    try {
      const res = await wx.cloud.callFunction({ name: 'login' })
      const { openId, member, trips } = res.result
      this.globalData.openId = openId
      this.globalData.currentMember = member
      this.globalData.currentTrips = trips || []
      this.globalData.currentTrip = null
      this.globalData.pendingInviteToken = wx.getStorageSync('pendingInviteToken') || ''
      return res.result
    } catch (err) {
      console.error('[app] login 失败', err)
      throw err
    }
  },

  // 供 login 页调用：注册新成员（可带头像 fileID）
  async register(name, avatarFileID) {
    try {
      const res = await wx.cloud.callFunction({
        name: 'login',
        data: { name, avatarFileID: avatarFileID || '' }
      })
      const { openId, member, trips } = res.result
      this.globalData.openId = openId
      this.globalData.currentMember = member
      this.globalData.currentTrips = trips || []
      this.globalData.currentTrip = null
      return res.result
    } catch (err) {
      console.error('[app] register 失败', err)
      throw err
    }
  }
})
