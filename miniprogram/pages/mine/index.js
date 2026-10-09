// pages/mine/index.js · Tab 4 我的（占位）
const { ensureLogin } = require('../../utils/auth')

const app = getApp()

Page({
  data: {
    member: null,
    trip: null,
    avatarText: ''
  },

  async onLoad() {
    const data = await ensureLogin()
    if (!data) return
    this.setDataFromGlobal()
  },

  onShow() {
    if (app.globalData.currentMember) {
      this.setDataFromGlobal()
    }
  },

  setDataFromGlobal() {
    const member = app.globalData.currentMember
    const trip = app.globalData.currentTrip
    this.setData({
      member,
      trip,
      avatarText: member && member.name ? member.name.charAt(0) : '?'
    })
  },

  // 微信官方头像授权：确认后上传云存储并更新成员资料
  async onChooseAvatar(e) {
    const url = e.detail.avatarUrl
    if (!url) return
    try {
      const ext = (url.split('.').pop() || 'png').split('?')[0].slice(0, 8)
      const cloudPath = `avatars/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
      const up = await wx.cloud.uploadFile({ cloudPath, filePath: url })
      const res = await wx.cloud.callFunction({
        name: 'db',
        data: { action: 'updateMember', data: { avatarFileID: up.fileID } }
      })
      if (res.result && res.result.error) throw new Error(res.result.error)
      const member = { ...this.data.member, avatarFileID: up.fileID }
      app.globalData.currentMember = member
      this.setData({ member })
      wx.showToast({ title: '头像已更新', icon: 'success' })
    } catch (err) {
      console.error('[mine] 换头像失败', err)
      wx.showToast({ title: err.message || '更新失败', icon: 'none' })
    }
  },

  onTripSettingTap() {
    wx.navigateTo({ url: '/pages/trip-setting/index' })
  }
})
