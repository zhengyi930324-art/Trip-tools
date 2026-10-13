// pages/stats/index.js · Tab 3 统计
const { ensureLogin } = require('../../utils/auth')
const { fenToYuan, weekday } = require('../../utils/format')
const { CATEGORIES, getCategory } = require('../../utils/constants')
const cache = require('../../utils/cache')

const app = getApp()

// 导出长图的逻辑宽度与边距
const EW = 375
const EM = 24

const pad2 = n => String(n).padStart(2, '0')

// 手写圆角矩形路径（不依赖 roundRect）
function rr(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, 0)
  ctx.lineTo(x + w, y + h - r)
  ctx.arc(x + w - r, y + h - r, r, 0, Math.PI / 2)
  ctx.lineTo(x + r, y + h)
  ctx.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI)
  ctx.lineTo(x, y + r)
  ctx.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5)
  ctx.closePath()
  ctx.fill()
}

Page({
  data: {
    stats: null,
    categoryList: [],
    balances: [],
    openMemberId: '',
    loading: true,
    totalYuan: '0.00',
    avgYuan: '0.00',
    count: 0,
    memberCount: 0,
    exporting: false
  },

  async onLoad() {
    const data = await ensureLogin()
    if (!data) return
    this._tripId = app.globalData.currentTrip._id
    // 有本地缓存先铺出来（含饼图），不用盯着 loading 等云端
    const tripId = app.globalData.currentTrip._id
    const cached = cache.read(`trip:${tripId}:stats`)
    if (cached) {
      this.setData({ ...cached, loading: false })
      wx.nextTick(() => this.drawPie())
    }
    await this.loadData({ silent: !!cached })
  },

  async onShow() {
    if (app.globalData.currentMember && app.globalData.currentTrip && this._tripId !== app.globalData.currentTrip._id) {
      this._tripId = app.globalData.currentTrip._id
      this.setData({ stats: null, categoryList: [], balances: [], totalYuan: '0.00', avgYuan: '0.00', count: 0, memberCount: 0, loading: true })
      await this.loadData()
    } else if (app.globalData.currentMember && !this.data.loading) {
      await this.loadData({ silent: true })
    }
  },

  async onPullDownRefresh() {
    await this.loadData({ silent: true })
    wx.stopPullDownRefresh()
  },

  // 展开 / 收起某人的付款明细
  onMemberTap(e) {
    const { id } = e.currentTarget.dataset
    this.setData({ openMemberId: this.data.openMemberId === id ? '' : id })
  },

  async loadData(opts = {}) {
    // silent：屏上已有缓存/旧数据时不遮 loading，后台刷新
    if (!opts.silent) this.setData({ loading: true })
    try {
      const [statsRes, recordsRes] = await Promise.all([
        wx.cloud.callFunction({ name: 'getStats', data: { tripId: app.globalData.currentTrip._id } }),
        wx.cloud.callFunction({ name: 'db', data: { action: 'listRecords', data: { tripId: app.globalData.currentTrip._id, limit: 500 } } })
      ])

      const stats = statsRes.result
      if (!stats || stats.error) {
        throw new Error((stats && stats.error) || '统计失败')
      }

      const records = (recordsRes.result && recordsRes.result.list) || []

      // 分类数据（按金额降序，过滤 0）；遗留分类（娱乐/购物）并入「其他」
      const byCategory = { ...(stats.byCategory || {}) }
      Object.keys(byCategory).forEach(k => {
        if (CATEGORIES.some(c => c.key === k)) return
        byCategory.other = (byCategory.other || 0) + byCategory[k]
        delete byCategory[k]
      })
      const categoryList = CATEGORIES
        .map(cat => {
          const amount = byCategory[cat.key] || 0
          const percent = stats.total > 0 ? Math.round((amount / stats.total) * 1000) / 10 : 0
          return {
            ...cat,
            amount,
            amountYuan: fenToYuan(amount),
            percent
          }
        })
        .filter(c => c.amount > 0)
        .sort((a, b) => b.amount - a.amount)

      // 本人付款明细：按付款人分组，沿用云端返回的发生日期倒序
      const byPayer = {}
      records.forEach(r => {
        const c = getCategory(r.category)
        const list = byPayer[r.payerId] || (byPayer[r.payerId] = [])
        list.push({
          key: r._id,
          dateShort: (r.date || '').slice(5),
          icon: c.icon,
          color: c.color,
          categoryName: c.name,
          note: r.note || '',
          amountYuan: fenToYuan(r.amount)
        })
      })

      // 每人收支：已付 / 应付（分摊）/ 差额（正=应收，负=应付）+ 可展开的本人明细
      const balances = (stats.balances || []).map(b => ({
        memberId: b.memberId,
        name: b.name,
        paidYuan: fenToYuan(b.paid),
        owedYuan: fenToYuan(b.owed),
        diffType: b.balance > 0 ? 'recv' : (b.balance < 0 ? 'pay' : 'even'),
        diffText: b.balance > 0 ? `应收 ¥${fenToYuan(b.balance)}` : (b.balance < 0 ? `应付 ¥${fenToYuan(-b.balance)}` : '已持平'),
        count: (byPayer[b.memberId] || []).length,
        records: byPayer[b.memberId] || []
      }))

      // 导出长图用的明细分组（不入 data / 不入缓存）：按发生日期倒序
      const nameMap = {}
      ;(stats.balances || []).forEach(b => { nameMap[b.memberId] = b.name })
      const gmap = {}
      records.forEach(r => {
        const c = getCategory(r.category)
        const g = gmap[r.date] || (gmap[r.date] = { date: r.date, weekday: weekday(r.date), dayTotal: 0, items: [] })
        g.dayTotal += r.amount || 0
        g.items.push({
          icon: c.icon,
          color: c.color,
          label: r.note || c.name,
          payerName: nameMap[r.payerId] || '未知',
          amountYuan: fenToYuan(r.amount)
        })
      })
      this._exportGroups = Object.keys(gmap)
        .sort((a, b) => b.localeCompare(a))
        .map(k => ({ ...gmap[k], dayTotalYuan: fenToYuan(gmap[k].dayTotal) }))

      const avg = stats.memberCount > 0 ? Math.round(stats.total / stats.memberCount) : 0

      const payload = {
        stats,
        categoryList,
        balances,
        totalYuan: fenToYuan(stats.total),
        avgYuan: fenToYuan(avg),
        count: stats.count || 0,
        memberCount: stats.memberCount || 0
      }
      this.setData({ ...payload, loading: false })
      cache.write(`trip:${app.globalData.currentTrip._id}:stats`, payload)

      // 渲染完成后再画饼图（canvas 处于 wx:if 块内）
      wx.nextTick(() => this.drawPie())
    } catch (err) {
      console.error('[stats] 加载失败', err)
      wx.showToast({ title: '加载失败', icon: 'none' })
      this.setData({ loading: false })
    }
  },

  // 分类环形饼图（canvas 2d）
  drawPie() {
    const list = this.data.categoryList
    if (!list || list.length === 0) return

    wx.createSelectorQuery()
      .select('#catPie')
      .fields({ node: true, size: true })
      .exec((res) => {
        try {
          if (!res || !res[0] || !res[0].node) return
          const canvas = res[0].node
          const ctx = canvas.getContext('2d')
          const dpr = this.getPixelRatio()
          const w = res[0].width
          const h = res[0].height
          if (!w || !h) return

          canvas.width = w * dpr
          canvas.height = h * dpr
          ctx.scale(dpr, dpr)
          ctx.clearRect(0, 0, w, h)

          const cx = w / 2
          const cy = h / 2
          const outer = Math.min(w, h) / 2 - 1
          const inner = outer * 0.64
          const total = list.reduce((sum, c) => sum + c.amount, 0)
          if (total <= 0) return

          // 单一分类占满时画整圆，避开 arc 起止角相同的退化情况
          if (list.length === 1) {
            ctx.beginPath()
            ctx.arc(cx, cy, outer, 0, Math.PI * 2)
            ctx.fillStyle = list[0].color
            ctx.fill()
          } else {
            let start = -Math.PI / 2
            list.forEach(c => {
              const angle = (c.amount / total) * Math.PI * 2
              if (angle <= 0) return
              ctx.beginPath()
              ctx.moveTo(cx, cy)
              ctx.arc(cx, cy, outer, start, start + angle)
              ctx.closePath()
              ctx.fillStyle = c.color
              ctx.fill()
              start += angle
            })
          }

          // 挖空中心成环形，中间留给总额文字
          ctx.beginPath()
          ctx.arc(cx, cy, inner, 0, Math.PI * 2)
          ctx.fillStyle = '#FFFFFF'
          ctx.fill()
        } catch (e) {
          console.error('[stats] 饼图绘制失败', e)
        }
      })
  },

  // 绘制导出长图；ctx 传 null 时只做高度测量（与绘制共用同一套布局，保证不漂移）
  paintExport(ctx) {
    const groups = this._exportGroups || []
    const cats = this.data.categoryList || []
    const bals = this.data.balances || []
    const trip = app.globalData.currentTrip || {}
    let y = 32

    const T = (text, x, yy, font, color, alignRight, maxW) => {
      if (!ctx) return
      let t = String(text)
      ctx.font = font
      if (maxW) {
        while (t.length > 1 && ctx.measureText(t).width > maxW) t = t.slice(0, -1)
        if (t !== String(text)) t = t.slice(0, -1) + '…'
      }
      ctx.fillStyle = color
      if (alignRight) {
        ctx.fillText(t, x - ctx.measureText(t).width, yy)
      } else {
        ctx.fillText(t, x, yy)
      }
    }
    const chip = (x, yy, s, color, icon) => {
      if (!ctx) return
      ctx.fillStyle = color
      rr(ctx, x, yy, s, s, 4)
      if (icon) {
        ctx.fillStyle = '#FFFFFF'
        ctx.font = '10px sans-serif'
        ctx.fillText(icon, x + s / 2 - 5, yy + s - 4)
      }
    }
    const line = yy => {
      if (!ctx) return
      ctx.fillStyle = '#E5E5EA'
      ctx.fillRect(EM, yy, EW - EM * 2, 1)
    }

    // 头部
    T('出去撒欢 · 账单总结', EM, y + 20, 'bold 20px sans-serif', '#1D1D1F')
    y += 34
    T(`${trip.name || ''}  ${trip.startDate || ''} 至 ${trip.endDate || ''}`, EM, y + 12, '12px sans-serif', '#86868B')
    y += 40

    // 总览
    T('总花销', EM, y + 12, '12px sans-serif', '#86868B')
    y += 22
    T(`¥ ${this.data.totalYuan}`, EM, y + 30, 'bold 30px sans-serif', '#004E89')
    y += 46
    T(`${this.data.memberCount} 人 · ${this.data.count} 笔 · 人均 ¥${this.data.avgYuan}`, EM, y + 12, '12px sans-serif', '#86868B')
    y += 40
    line(y)
    y += 25

    // 分类统计
    T('分类统计', EM, y + 16, 'bold 16px sans-serif', '#1D1D1F')
    y += 36
    cats.forEach(c => {
      chip(EM, y + 4, 14, c.color)
      T(c.name, EM + 22, y + 16, '13px sans-serif', '#3A3A3C')
      T(`${c.percent}%`, EM + 76, y + 16, '11px sans-serif', '#B0B0B5')
      T(`¥${c.amountYuan}`, EW - EM, y + 16, '13px sans-serif', '#004E89', true)
      y += 36
    })
    y += 28

    // 每人收支
    T('每人收支', EM, y + 16, 'bold 16px sans-serif', '#1D1D1F')
    y += 36
    bals.forEach(b => {
      T(b.name, EM, y + 16, '14px sans-serif', '#1D1D1F')
      T(`已付 ¥${b.paidYuan} · 应付 ¥${b.owedYuan}`, EM, y + 34, '11px sans-serif', '#86868B')
      const color = b.diffType === 'recv' ? '#34C759' : (b.diffType === 'pay' ? '#FF3B30' : '#86868B')
      T(b.diffText, EW - EM, y + 26, '13px sans-serif', color, true)
      y += 56
    })
    y += 28

    // 账单明细（全部）
    T(`账单明细（${this.data.count} 笔）`, EM, y + 16, 'bold 16px sans-serif', '#1D1D1F')
    y += 36
    groups.forEach(g => {
      T(`${g.date} ${g.weekday}`, EM, y + 14, 'bold 13px sans-serif', '#1D1D1F')
      T(`合计 ¥${g.dayTotalYuan}`, EW - EM, y + 14, '11px sans-serif', '#86868B', true)
      y += 30
      g.items.forEach(it => {
        chip(EM, y + 3, 16, it.color, it.icon)
        T(it.label, EM + 24, y + 16, '13px sans-serif', '#3A3A3C', false, 150)
        T(it.payerName, EM + 190, y + 16, '11px sans-serif', '#B0B0B5', false, 60)
        T(`¥${it.amountYuan}`, EW - EM, y + 16, '13px sans-serif', '#004E89', true)
        y += 44
      })
      y += 16
    })

    // 页脚
    line(y)
    y += 17
    const d = new Date()
    const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    T(`导出时间 ${stamp} · 出去撒欢`, EM, y + 12, '10px sans-serif', '#B0B0B5')
    y += 44
    return y
  },

  // 导出长图：离屏 canvas 绘制 → 临时文件 → 保存相册
  async onExportTap() {
    if (this.data.exporting) return
    if (!this.data.count) {
      wx.showToast({ title: '还没有账单数据', icon: 'none' })
      return
    }
    this.setData({ exporting: true })
    try {
      const node = await new Promise((resolve, reject) => {
        wx.createSelectorQuery()
          .select('#exportCanvas')
          .fields({ node: true, size: true })
          .exec(res => {
            if (res && res[0] && res[0].node) resolve(res[0].node)
            else reject(new Error('canvas 不可用'))
          })
      })

      const H = this.paintExport(null)
      // 控制总像素，超长图降 dpr，避免超出设备 canvas 上限
      const dpr = H * 2 <= 16000 ? 2 : 1
      node.width = EW * dpr
      node.height = H * dpr
      const ctx = node.getContext('2d')
      ctx.scale(dpr, dpr)
      // 白底
      ctx.fillStyle = '#FFFFFF'
      ctx.fillRect(0, 0, EW, H)
      this.paintExport(ctx)

      const temp = await new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({ canvas: node, fileType: 'jpg', quality: 0.9, success: resolve, fail: reject })
      })
      await new Promise((resolve, reject) => {
        wx.saveImageToPhotosAlbum({ filePath: temp.tempFilePath, success: resolve, fail: reject })
      })
      wx.showToast({ title: '已保存到相册', icon: 'success' })
    } catch (err) {
      console.error('[stats] 导出失败', err)
      const msg = (err && (err.errMsg || err.message)) || ''
      if (/auth deny|auth denied|authorize/i.test(msg)) {
        wx.showModal({
          title: '需要相册权限',
          content: '请到设置中允许保存到相册后重新导出',
          confirmText: '去设置',
          success: r => { if (r.confirm) wx.openSetting() }
        })
      } else {
        wx.showToast({ title: '导出失败，请重试', icon: 'none' })
      }
    } finally {
      this.setData({ exporting: false })
    }
  },

  getPixelRatio() {
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      return (info && info.pixelRatio) || 2
    } catch (e) {
      return 2
    }
  },
})
