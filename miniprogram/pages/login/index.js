// pages/login/index.js
const app = getApp()

Page({
  data: {
    name: '',
    loading: false,
    errMsg: '',
    avatarUrl: '',
    avatarFileID: ''
  },

  // 微信官方头像授权：用户确认后拿到临时头像，上传到云存储供全员可见
  async onChooseAvatar(e) {
    const url = e.detail.avatarUrl
    if (!url) return
    this.setData({ avatarUrl: url, errMsg: '' })
    await this.uploadAvatar(url)
  },

  async uploadAvatar(url) {
    try {
      const ext = (url.split('.').pop() || 'png').split('?')[0].slice(0, 8)
      const cloudPath = `avatars/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
      const up = await wx.cloud.uploadFile({ cloudPath, filePath: url })
      this.setData({ avatarFileID: up.fileID })
    } catch (err) {
      console.warn('[login] 头像上传失败，注册时重试', err)
    }
  },

  async onLoad() {
    if (app.globalData.loginReady) await app.globalData.loginReady
    if (app.globalData.currentMember) this.continueAfterLogin()
  },

  onInput(e) {
    this.setData({ name: e.detail.value, errMsg: '' })
  },

  async onSubmit() {
    const name = this.data.name.trim()
    if (!name) {
      this.setData({ errMsg: '请先填个名字（点输入框可一键用微信昵称）' })
      return
    }
    if (name.length > 20) {
      this.setData({ errMsg: '名字太长了，最多 20 个字' })
      return
    }

    this.setData({ loading: true, errMsg: '' })
    try {
      // 选过头像但刚才上传失败的，这里补传一次
      if (this.data.avatarUrl && !this.data.avatarFileID) {
        await this.uploadAvatar(this.data.avatarUrl)
      }
      const res = await app.register(name, this.data.avatarFileID)
      if (!res || !res.member) {
        // 把云端返回的真实错误透出来，别只说“注册失败”
        throw new Error((res && res.error) || '注册失败')
      }
      wx.showToast({ title: '欢迎，' + name, icon: 'success', duration: 800 })
      setTimeout(() => this.continueAfterLogin(), 600)
    } catch (err) {
      console.error('[login] 注册失败', err)
      this.setData({
        loading: false,
        errMsg: this.describeError(err)
      })
    }
  },

  continueAfterLogin() {
    const token = app.globalData.pendingInviteToken || wx.getStorageSync('pendingInviteToken')
    if (token) {
      app.globalData.pendingInviteToken = token
      wx.redirectTo({ url: `/pages/trip-invite/index?token=${token}` })
    } else {
      wx.reLaunch({ url: '/pages/trip-select/index' })
    }
  },

  // 把常见部署/环境问题翻译成能看懂的话
  describeError(err) {
    const msg = (err && (err.errMsg || err.message)) || String(err || '')
    if (/not found|FunctionName|function.*not.*exist/i.test(msg)) {
      return '云函数 login 还没部署：在开发者工具里右键 cloudfunctions/login → 上传并部署'
    }
    if (/env|environment/i.test(msg)) {
      return '云开发环境不对：检查 app.js 里的 env 是否等于你控制台的环境 ID'
    }
    if (/collection.*not.*exist|database/i.test(msg)) {
      return '数据库集合还没建好：到云开发控制台手动建 trips/members/schedule/records/tripMembers/tripInvites'
    }
    if (/timeout|network|request:fail/i.test(msg)) {
      return '网络不通：检查网络后重试'
    }
    return '注册失败：' + msg
  }
})
