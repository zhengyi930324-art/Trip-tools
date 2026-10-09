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
    this.globalData.loginReady = this.doLogin()

    // 后台把各云函数叫一遍暖实例，切 Tab 的首次调用不被冷启动卡住
    this.prewarm()
  },

  // 每个云函数调用一次预热（只读 action，错误忽略）
  prewarm() {
    ;[
      { name: 'db', data: { action: 'getTrip' } },
      { name: 'getStats' },
      { name: 'settle' }
    ].forEach(item => {
      wx.cloud.callFunction(item).catch(() => {})
    })
  },

  globalData: {
    openId: null,
    currentMember: null,
    currentTrip: null,
    loginReady: null
  },

  async doLogin() {
    try {
      const res = await wx.cloud.callFunction({ name: 'login' })
      const { openId, member, trip } = res.result
      this.globalData.openId = openId
      this.globalData.currentMember = member
      this.globalData.currentTrip = trip
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
      const { openId, member, trip } = res.result
      this.globalData.openId = openId
      this.globalData.currentMember = member
      this.globalData.currentTrip = trip
      return res.result
    } catch (err) {
      console.error('[app] register 失败', err)
      throw err
    }
  }
})
