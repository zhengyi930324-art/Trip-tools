// pages/ledger/index.js · Tab 2 账单
const { ensureLogin } = require('../../utils/auth')
const { fenToYuan, relativeDay, weekday } = require('../../utils/format')
const { CATEGORIES, getCategory } = require('../../utils/constants')
const cache = require('../../utils/cache')

const app = getApp()

Page({
  data: {
    groupedRecords: [],
    members: [],
    memberMap: {},
    categories: [{ key: 'all', name: '全部', color: '#86868B', icon: '全' }].concat(CATEGORIES),
    activeCategory: 'all',
    summaryLabel: '总支出',
    loading: true,
    totalCost: 0,
    totalCostYuan: '0.00',
    recordCount: 0
  },

  async onLoad() {
    const data = await ensureLogin()
    if (!data) return
    // 有本地缓存先铺出来（仅当筛选条件一致），不用盯着 loading 等云端
    const cached = cache.read('ledger')
    const hit = !!cached && cached.activeCategory === this.data.activeCategory
    if (hit) this.setData({ ...cached, loading: false })
    await this.loadData({ silent: hit })
  },

  async onShow() {
    if (app.globalData.currentMember && !this.data.loading) {
      await this.loadData({ silent: true })
    }
  },

  async onPullDownRefresh() {
    await this.loadData({ silent: true })
    wx.stopPullDownRefresh()
  },

  async loadData(opts = {}) {
    // silent：屏上已有缓存/旧数据时不遮 loading，后台刷新
    if (!opts.silent) this.setData({ loading: true })
    try {
      const [recordsRes, membersRes] = await Promise.all([
        wx.cloud.callFunction({
          name: 'db',
          data: { action: 'listRecords', data: { category: this.data.activeCategory, limit: 500 } }
        }),
        wx.cloud.callFunction({ name: 'db', data: { action: 'listMembers' } })
      ])

      const records = (recordsRes.result && recordsRes.result.list) || []
      const members = (membersRes.result && membersRes.result.list) || []
      const memberMap = {}
      members.forEach(m => { memberMap[m._id] = m })

      const enriched = records.map(r => {
        const cat = getCategory(r.category)
        const payer = memberMap[r.payerId]
        return {
          ...r,
          amountYuan: fenToYuan(r.amount),
          categoryName: cat.name,
          categoryColor: cat.color,
          categoryIcon: cat.icon,
          payerName: payer ? payer.name : '未知',
          participantCount: r.participantIds ? r.participantIds.length : 0
        }
      })

      const grouped = this.groupByDate(enriched)
      const totalCost = enriched.reduce((sum, r) => sum + (r.amount || 0), 0)
      // 筛选某个分类时，合计只包含该分类，标题跟着变，避免误读为全程总支出
      const active = this.data.activeCategory
      const summaryLabel = active === 'all'
        ? '总支出'
        : getCategory(active).name + '支出'

      const payload = {
        groupedRecords: grouped,
        members,
        memberMap,
        summaryLabel,
        totalCost,
        totalCostYuan: fenToYuan(totalCost),
        recordCount: enriched.length,
        activeCategory: active
      }
      this.setData({ ...payload, loading: false })
      cache.write('ledger', payload)
    } catch (err) {
      console.error('[ledger] 加载失败', err)
      wx.showToast({ title: '加载失败', icon: 'none' })
      this.setData({ loading: false })
    }
  },

  groupByDate(records) {
    const map = {}
    records.forEach(r => {
      if (!map[r.date]) map[r.date] = []
      map[r.date].push(r)
    })

    return Object.keys(map)
      .sort((a, b) => b.localeCompare(a))
      .map(date => {
        const items = map[date]
        const dayTotal = items.reduce((sum, r) => sum + (r.amount || 0), 0)
        return {
          date,
          dateLabel: relativeDay(date),
          weekday: weekday(date),
          items,
          dayTotal,
          dayTotalYuan: fenToYuan(dayTotal)
        }
      })
  },

  onCategoryTap(e) {
    const { key } = e.currentTarget.dataset
    if (key === this.data.activeCategory) return
    this.setData({ activeCategory: key })
    this.loadData()
  },

  onAddTap() {
    wx.navigateTo({ url: '/pages/record-edit/index' })
  },

  onRecordTap(e) {
    const { id } = e.currentTarget.dataset
    wx.navigateTo({ url: `/pages/record-edit/index?id=${id}` })
  }
})
