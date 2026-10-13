// pages/trip-setting/index.js · 旅程设置
const { ensureLogin } = require('../../utils/auth')

const app = getApp()

Page({
  data: {
    trip: null,
    name: '',
    startDate: '',
    endDate: '',
    saving: false,
    isCreator: false,
    members: [],
    membersLoading: false,
    membersLoadFailed: false,
    removingMemberId: ''
  },

  async onLoad() {
    const data = await ensureLogin()
    if (!data) return

    const trip = data.currentTrip
    if (!trip) return
    this.setData({
      trip,
      name: trip.name || '',
      startDate: trip.startDate || '',
      endDate: trip.endDate || '',
      isCreator: trip.role === 'creator'
    })
    await this.loadMembers()
  },

  async loadMembers() {
    this.setData({ membersLoading: true, membersLoadFailed: false })
    try {
      const res = await wx.cloud.callFunction({
        name: 'db',
        data: { action: 'listMembers', data: { tripId: app.globalData.currentTrip._id } }
      })
      if (res.result && res.result.error) throw new Error(res.result.error)
      const members = (res.result && res.result.list) || []
      this.setData({ members: members.map(member => ({ ...member, avatarText: (member.name || '').slice(0, 1) })) })
    } catch (err) {
      console.error('[trip-setting] 获取成员失败', err)
      this.setData({ members: [], membersLoadFailed: true })
      wx.showToast({ title: '成员名单加载失败', icon: 'none' })
    } finally {
      this.setData({ membersLoading: false })
    }
  },

  onRemoveMember(e) {
    if (!this.data.isCreator || this.data.removingMemberId) return
    const member = this.data.members.find(item => item._id === e.currentTarget.dataset.id)
    if (!member || member.role === 'creator') return

    wx.showModal({
      title: '移除同行成员',
      content: `移除后，${member.name}将无法访问当前旅程，已有行程和账单会保留。`,
      confirmText: '移除',
      confirmColor: '#FF6B35',
      success: async result => {
        if (!result.confirm) return
        this.setData({ removingMemberId: member._id })
        try {
          const res = await wx.cloud.callFunction({
            name: 'db',
            data: {
              action: 'removeTripMember',
              data: { tripId: app.globalData.currentTrip._id, memberId: member._id }
            }
          })
          if (res.result && res.result.error) throw new Error(res.result.error)
          this.setData({ members: this.data.members.filter(item => item._id !== member._id) })
          wx.showToast({ title: '已移除', icon: 'success' })
        } catch (err) {
          console.error('[trip-setting] 移除成员失败', err)
          wx.showToast({ title: err.message || '移除失败', icon: 'none' })
        } finally {
          this.setData({ removingMemberId: '' })
        }
      }
    })
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
    if (!this.data.isCreator) return
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
          data: { tripId: app.globalData.currentTrip._id, name: name.trim(), startDate, endDate }
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
