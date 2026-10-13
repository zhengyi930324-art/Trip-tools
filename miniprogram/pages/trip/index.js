// pages/trip/index.js · Tab 1 行程
const { ensureLogin } = require('../../utils/auth')
const { formatDate, daysBetween, today, parseDate, weekday, relativeDay, fenToYuan } = require('../../utils/format')
const { getScheduleType } = require('../../utils/constants')
const cache = require('../../utils/cache')

const app = getApp()

Page({
  data: {
    trip: null,
    member: null,
    days: [],           // 按 day 分组后的行程
    loading: true,
    countdown: null,    // { value, unit, text, mode }
    scrollToDay: 1,
    totalItemCount: 0,  // 行程项总数，用于空态判断
    openSwipeId: '',    // 当前左滑展开的行程项 _id
    prepTotal: 0,       // 全部待办数
    prepDone: 0,        // 已完成待办数
    prepPercent: 0,
    prepAll: [],        // 展开清单：全部待办（未完成在前，带所属行程项信息）
    prepOpen: false,    // 准备进度卡片是否展开
    inviteReady: false,
    fabX: 0,
    fabY: 0
  },

  async onLoad() {
    const { windowWidth, windowHeight } = wx.getSystemInfoSync()
    const rpx = windowWidth / 750
    this.setData({ fabX: windowWidth - 140 * rpx, fabY: windowHeight - 220 * rpx })
    const data = await ensureLogin()
    if (!data) return
    this._tripId = data.currentTrip._id
    this.setData({
      trip: data.currentTrip,
      member: data.currentMember
    })
    // 有本地缓存先铺出来，不用盯着 loading 等云端
    const cached = cache.read(`trip:${this._tripId}:trip`)
    if (cached) this.setData({ ...cached, loading: false })
    // 首次进入需要定位到当日；后续刷新不再抢滚动位置
    await this.loadData({ position: true, silent: !!cached })
    await this.prepareInvite()
  },

  async onShow() {
    if (app.globalData.currentMember && app.globalData.currentTrip && this._tripId !== app.globalData.currentTrip._id) {
      this._tripId = app.globalData.currentTrip._id
      this.setData({ trip: app.globalData.currentTrip, member: app.globalData.currentMember, days: [], totalItemCount: 0, loading: true })
      await this.loadData({ position: true })
      await this.prepareInvite()
    } else if (app.globalData.currentMember && !this.data.loading) {
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
      const [scheduleRes, recordsRes, tripRes] = await Promise.all([
        wx.cloud.callFunction({ name: 'db', data: { action: 'listSchedule', data: { tripId: this._tripId } } }),
        wx.cloud.callFunction({ name: 'db', data: { action: 'listRecords', data: { tripId: this._tripId, limit: 500 } } }),
        wx.cloud.callFunction({ name: 'db', data: { action: 'getTrip', data: { tripId: this._tripId } } })
      ])

      const schedule = (scheduleRes.result && scheduleRes.result.list) || []
      const records = (recordsRes.result && recordsRes.result.list) || []

      // 旅程信息（名字/日期）每次刷新都回读云端，避免设置页保存后这里还是旧值
      const trip = (tripRes.result && tripRes.result.trip) || null
      if (trip) {
        this.setData({ trip })
        app.globalData.currentTrip = trip
      }

      const days = this.groupByDay(schedule, records)
      const { countdown, scrollToDay } = this.computeCountdown()
      const payload = {
        days,
        totalItemCount: schedule.length,
        countdown,
        scrollToDay,
        ...this.computePrep(days)
      }

      this.setData({ ...payload, openSwipeId: '', loading: false })
      cache.write(`trip:${this._tripId}:trip`, payload)

      if (opts.position) this.positionToCurrentDay(countdown)
    } catch (err) {
      console.error('[trip] 加载失败', err)
      wx.showToast({ title: '加载失败', icon: 'none' })
      this.setData({ loading: false })
    }
  },

  // 首屏定位：旅行中滚到今天；未出发 / 已结束停在顶部看倒计时卡片
  positionToCurrentDay(countdown) {
    if (!countdown || countdown.mode !== 'during') return
    wx.nextTick(() => {
      wx.pageScrollTo({
        selector: `#day-${this.data.scrollToDay}`,
        offsetTop: -12,
        duration: 300,
        fail: () => wx.pageScrollTo({ scrollTop: 0, duration: 0 })
      })
    })
  },

  // 按 day 分组行程，并关联当日账目
  groupByDay(schedule, records) {
    const trip = this.data.trip
    if (!trip || !trip.startDate || !trip.endDate) return []

    const startDate = parseDate(trip.startDate)
    const endDate = parseDate(trip.endDate)
    const totalDays = Math.max(1, daysBetween(startDate, endDate) + 1)

    const days = []
    for (let i = 1; i <= totalDays; i++) {
      const date = new Date(startDate)
      date.setDate(startDate.getDate() + i - 1)
      const dateStr = formatDate(date)

      const items = schedule
        .filter(s => s.day === i)
        .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''))
        .map(s => {
          const typeInfo = getScheduleType(s.type)
          const cost = records.find(r => r._id === s.costRecordId)
          // 附件：优先新数组字段，兼容旧单图字段
          const images = Array.isArray(s.imageFileIDs) && s.imageFileIDs.length
            ? s.imageFileIDs.slice()
            : (s.imageFileID ? [s.imageFileID] : [])
          const todos = (Array.isArray(s.todos) ? s.todos : [])
            .filter(t => t && t.id)
            .map(t => ({ id: t.id, text: t.text || '', done: !!t.done, ownerId: t.ownerId || '', ownerName: t.ownerName || '' }))
          return {
            ...s,
            typeName: typeInfo.name,
            typeColor: typeInfo.color,
            typeIcon: typeInfo.icon,
            // 有选点坐标才显示地图入口
            hasCoord: typeof s.latitude === 'number' && typeof s.longitude === 'number',
            costAmount: cost ? cost.amount : null,
            costYuan: cost ? fenToYuan(cost.amount) : null,
            todos,
            todoTotal: todos.length,
            todoDone: todos.filter(t => t.done).length,
            images,
            imageCount: images.length
          }
        })

      // 当日账单合计：只统计当天行程项关联的账单，删除行程项后动态减少；未关联账单不计入
      const dayCost = items.reduce((sum, s) => sum + (s.costAmount || 0), 0)

      days.push({
        day: i,
        date: dateStr,
        dateShort: formatDate(date, 'MM-DD'),
        weekday: weekday(date),
        relative: relativeDay(dateStr),
        items,
        dayCost,
        dayCostYuan: fenToYuan(dayCost)
      })
    }

    return days
  },

  // 计算倒计时与首屏定位
  computeCountdown() {
    const trip = this.data.trip
    if (!trip || !trip.startDate) {
      return { countdown: null, scrollToDay: 1 }
    }

    const todayStr = today()
    const { startDate, endDate } = trip

    // 旅行未开始
    if (todayStr < startDate) {
      const days = daysBetween(todayStr, startDate)
      return {
        countdown: { value: days, unit: '天', text: '距离出发还有', mode: 'before' },
        scrollToDay: 1
      }
    }

    // 旅行已结束
    if (todayStr > endDate) {
      const days = daysBetween(endDate, todayStr)
      const totalDays = daysBetween(startDate, endDate) + 1
      return {
        countdown: { value: days, unit: '天', text: '旅行已结束', mode: 'after' },
        scrollToDay: totalDays
      }
    }

    // 旅行中：直接展示今天日期，不用第几天（容易和几号看混）
    const currentDay = daysBetween(startDate, todayStr) + 1
    const todayDate = parseDate(todayStr)
    return {
      countdown: { value: formatDate(todayDate, 'MM-DD'), unit: weekday(todayDate), text: '旅行进行中 · 今天', mode: 'during' },
      scrollToDay: currentDay
    }
  },

  // 汇总全部行程项的待办，算出准备进度与未完成清单
  computePrep(days) {
    const all = []
    days.forEach(d => {
      d.items.forEach(s => {
        s.todos.forEach(t => {
          all.push({
            key: `${s._id}_${t.id}`,
            sid: s._id,
            tid: t.id,
            text: t.text,
            done: t.done,
            ownerName: t.ownerName,
            dateShort: d.dateShort,
            weekday: d.weekday,
            title: s.title
          })
        })
      })
    })
    const prepTotal = all.length
    const prepDone = all.filter(t => t.done).length
    return {
      prepTotal,
      prepDone,
      prepPercent: prepTotal ? Math.round((prepDone / prepTotal) * 100) : 0,
      // 已完成的也展示，排在未完成后面
      prepAll: all.filter(t => !t.done).concat(all.filter(t => t.done))
    }
  },

  onPrepToggle() {
    this.setData({ prepOpen: !this.data.prepOpen })
  },

  // 行程页直接勾选待办：先乐观更新，失败再回滚
  async onTodoTap(e) {
    const { sid, tid } = e.currentTarget.dataset

    let dayIdx = -1, itemIdx = -1, todoIdx = -1
    for (let d = 0; d < this.data.days.length && dayIdx < 0; d++) {
      const items = this.data.days[d].items
      for (let i = 0; i < items.length; i++) {
        if (items[i]._id !== sid) continue
        const ti = items[i].todos.findIndex(t => t.id === tid)
        if (ti >= 0) { dayIdx = d; itemIdx = i; todoIdx = ti }
        break
      }
    }
    if (dayIdx < 0) return

    const nextDone = !this.data.days[dayIdx].items[itemIdx].todos[todoIdx].done
    this.patchTodo(dayIdx, itemIdx, todoIdx, nextDone)

    try {
      const todos = this.data.days[dayIdx].items[itemIdx].todos.map(t => ({
        id: t.id, text: t.text, done: t.done, ownerId: t.ownerId, ownerName: t.ownerName
      }))
      const res = await wx.cloud.callFunction({
        name: 'db',
        data: { action: 'updateSchedule', data: { tripId: this._tripId, _id: sid, todos } }
      })
      if (res.result && res.result.error) throw new Error(res.result.error)
    } catch (err) {
      console.error('[trip] 待办更新失败', err)
      this.patchTodo(dayIdx, itemIdx, todoIdx, !nextDone)
      wx.showToast({ title: err.message || '更新失败', icon: 'none' })
    }
  },

  // 局部改写一条待办的完成态，并同步重算进度
  patchTodo(dayIdx, itemIdx, todoIdx, done) {
    const days = this.data.days.map((d, di) => {
      if (di !== dayIdx) return d
      return {
        ...d,
        items: d.items.map((s, ii) => {
          if (ii !== itemIdx) return s
          const todos = s.todos.map((t, ti) => (ti === todoIdx ? { ...t, done } : t))
          return { ...s, todos, todoDone: todos.filter(t => t.done).length }
        })
      }
    })
    this.setData({ days, ...this.computePrep(days) })
  },

  // 行程项地图 icon：直接查看选点定位（可导航），不进详情页
  onItemMapTap(e) {
    const { lat, lng, title, loc } = e.currentTarget.dataset
    wx.openLocation({
      latitude: Number(lat),
      longitude: Number(lng),
      name: title || '',
      address: loc || '',
      fail: () => wx.showToast({ title: '打开地图失败', icon: 'none' })
    })
  },

  onAddTap() {
    wx.navigateTo({ url: '/pages/schedule-edit/index' })
  },

  // 眼睛按钮：预览当前节点的全部附件，多张在预览器里左右滑动查看
  onPreviewImages(e) {
    const { id } = e.currentTarget.dataset
    for (const d of this.data.days) {
      const item = d.items.find(s => s._id === id)
      if (item && item.images.length) {
        wx.previewImage({ urls: item.images, current: item.images[0] })
        return
      }
    }
  },

  onItemTap(e) {
    // 左滑展开时，点击先收起，不跳编辑页
    if (this.data.openSwipeId) {
      this.setData({ openSwipeId: '' })
      return
    }
    const { id } = e.currentTarget.dataset
    wx.navigateTo({ url: `/pages/schedule-edit/index?id=${id}` })
  },

  // ===== 左滑删除 =====
  onTouchStart(e) {
    this._touchX = e.touches[0].clientX
    this._touchY = e.touches[0].clientY
    this._swiped = false
  },

  onTouchMove(e) {
    const dx = e.touches[0].clientX - this._touchX
    const dy = e.touches[0].clientY - this._touchY
    // 横向位移明显大于纵向，才认定为左滑手势（避开页面竖向滚动）
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 12) this._swiped = true
  },

  onTouchEnd(e) {
    if (!this._swiped) return
    const dx = e.changedTouches[0].clientX - this._touchX
    const id = e.currentTarget.dataset.id
    if (dx < -40) {
      this.setData({ openSwipeId: id })
    } else if (dx > 40) {
      this.setData({ openSwipeId: '' })
    }
  },

  async onDeleteTap(e) {
    const { id, title } = e.currentTarget.dataset
    this.setData({ openSwipeId: '' })

    const confirm = await new Promise(resolve => {
      wx.showModal({
        title: '删除行程',
        content: `确定删除“${title || '该行程'}”？`,
        confirmColor: '#FF3B30',
        success: res => resolve(res.confirm),
        fail: () => resolve(false)
      })
    })
    if (!confirm) return

    try {
      const res = await wx.cloud.callFunction({
        name: 'db',
        data: { action: 'deleteSchedule', data: { tripId: this._tripId, _id: id } }
      })
      if (res.result && res.result.error) throw new Error(res.result.error)
      wx.showToast({ title: '已删除', icon: 'success' })
      await this.loadData({ silent: true })
    } catch (err) {
      console.error('[trip] 删除失败', err)
      wx.showToast({ title: err.message || '删除失败', icon: 'none' })
    }
  },

  onTripSettingTap() {
    if (!this.data.trip || this.data.trip.role !== 'creator') return
    wx.navigateTo({ url: '/pages/trip-setting/index' })
  },

  onTripSelectTap() {
    wx.navigateTo({ url: '/pages/trip-select/index?choose=1' })
  },

  async prepareInvite() {
    if (!this.data.trip || this.data.trip.role !== 'creator') return
    try {
      const res = await wx.cloud.callFunction({
        name: 'db', data: { action: 'createInvite', data: { tripId: this._tripId } }
      })
      if (res.result && res.result.error) throw new Error(res.result.error)
      this._inviteToken = res.result.token
      this.setData({ inviteReady: true })
    } catch (err) {
      console.error('[trip] 生成邀请失败', err)
    }
  },

  onShareAppMessage() {
    const token = this._inviteToken
    this._inviteToken = ''
    this.setData({ inviteReady: false })
    this.prepareInvite()
    return {
      title: `邀请你加入「${this.data.trip.name}」`,
      path: `/pages/trip-invite/index?token=${token || ''}`
    }
  },

  // 路线海报大图：自建查看页（真机 previewImage 不支持包内路径）
  onMapTap() {
    wx.navigateTo({ url: '/pages/route-map/index' })
  },

  // 行程地图总览页
  onMapPageTap() {
    wx.navigateTo({ url: '/pages/trip-map/index' })
  }
})
