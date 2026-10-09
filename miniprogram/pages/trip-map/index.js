// pages/trip-map/index.js · 行程地图总览
const { ensureLogin } = require('../../utils/auth')
const { formatDate, parseDate, weekday } = require('../../utils/format')

const app = getApp()

Page({
  data: {
    points: [],        // 有坐标的行程点（day + startTime 升序）
    markers: [],
    polyline: [],
    activeItem: null,  // 点 marker 后底部卡片展示的行程
    pointCount: 0,
    loading: true,
    // 无数据时的初始中心（全国大致中心），有数据由 includePoints 自适应
    centerLat: 34.62,
    centerLng: 103.83
  },

  async onLoad() {
    const data = await ensureLogin()
    if (!data) return
    await this.loadData()
  },

  async loadData() {
    this.setData({ loading: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'db',
        data: { action: 'listSchedule' }
      })
      const list = (res.result && res.result.list) || []
      const trip = app.globalData.currentTrip

      const points = list
        .filter(s => typeof s.latitude === 'number' && typeof s.longitude === 'number')
        .sort((a, b) => (a.day - b.day) || (a.startTime || '').localeCompare(b.startTime || ''))
        .map((s, idx) => {
          const date = this.dayToDate(trip, s.day)
          return {
            idx,
            id: s._id,
            title: s.title || '',
            location: s.location || '',
            latitude: s.latitude,
            longitude: s.longitude,
            dateLabel: date ? `${formatDate(date, 'MM-DD')} ${weekday(date)}` : '',
            startTime: s.startTime || ''
          }
        })

      const markers = points.map(p => ({
        id: p.idx,
        latitude: p.latitude,
        longitude: p.longitude,
        callout: {
          content: p.dateLabel ? `${p.dateLabel} · ${p.title}` : p.title,
          color: '#1D1D1F',
          fontSize: 12,
          borderRadius: 8,
          bgColor: '#FFFFFF',
          padding: 6,
          display: 'BYCLICK'
        }
      }))

      // 按时间顺序直线连线（含跨天衔接），不走路网规划
      const polyline = points.length > 1
        ? [{
            points: points.map(p => ({ latitude: p.latitude, longitude: p.longitude })),
            color: '#FF6B35',
            width: 4,
            arrowLine: true
          }]
        : []

      const payload = { points, markers, polyline, pointCount: points.length, loading: false }
      if (points.length > 0) {
        payload.centerLat = points[0].latitude
        payload.centerLng = points[0].longitude
      }
      this.setData(payload)

      // 渲染后自适应缩放容纳全部点
      if (points.length > 0) {
        wx.nextTick(() => {
          wx.createMapContext('tripMap', this).includePoints({
            points: points.map(p => ({ latitude: p.latitude, longitude: p.longitude })),
            padding: [60, 40, 180, 40]
          })
        })
      }
    } catch (err) {
      console.error('[trip-map] 加载失败', err)
      wx.showToast({ title: '加载失败', icon: 'none' })
      this.setData({ loading: false })
    }
  },

  // 行程天序号 → 具体日期（按旅程出发日推算）
  dayToDate(trip, day) {
    if (!trip || !trip.startDate || !day) return null
    const start = parseDate(trip.startDate)
    if (isNaN(start.getTime())) return null
    const d = new Date(start)
    d.setDate(start.getDate() + day - 1)
    return d
  },

  onMarkerTap(e) {
    const markerId = e.markerId !== undefined ? e.markerId : (e.detail && e.detail.markerId)
    const p = this.data.points.find(item => item.idx === markerId)
    this.setData({ activeItem: p || null })
  },

  onCloseCard() {
    this.setData({ activeItem: null })
  },

  // 调起微信内置地图导航
  onNavigate() {
    const p = this.data.activeItem
    if (!p) return
    wx.openLocation({
      latitude: p.latitude,
      longitude: p.longitude,
      name: p.title,
      address: p.location,
      fail: () => wx.showToast({ title: '打开导航失败', icon: 'none' })
    })
  }
})
