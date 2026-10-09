/* 临时 E2E：mock 小程序运行时，驱动真实页面代码 + 真实云函数 */
const Module = require('module')
const path = require('path')
const { getCategory } = require('./miniprogram/utils/constants')

// ==================== 内存 DB（惰性读取，云函数在加载时就拿了 db 句柄）====================
let CURRENT = { collections: {}, openId: 'o_alice' }

function makeDb() {
  const cols = () => CURRENT.collections
  const mk = (name) => {
    const q = {
      _where: null, _orderBy: [], _limit: 20, _skip: 0,
      where(w) { q._where = w; return q },
      orderBy(f, d) { q._orderBy.push([f, d]); return q },
      limit(n) { q._limit = n; return q },
      skip(n) { q._skip = n; return q },
      async get() {
        let rows = (cols()[name] || []).slice()
        if (q._where) {
          rows = rows.filter(r => Object.keys(q._where).every(k => {
            const v = q._where[k]
            if (v && typeof v === 'object' && v.__op) {
              if (v.__op === 'range') return r[k] >= v.gte && r[k] <= v.lte
              if (v.__op === 'gte') return r[k] >= v.val
              if (v.__op === 'lte') return r[k] <= v.val
              return true
            }
            return r[k] === v
          }))
        }
        for (const [f, d] of q._orderBy.slice().reverse()) {
          rows.sort((a, b) => { const x = a[f], y = b[f]; const c = x < y ? -1 : x > y ? 1 : 0; return d === 'desc' ? -c : c })
        }
        return { data: rows.slice(q._skip, q._skip + q._limit) }
      },
      doc(id) {
        return {
          async get() { return { data: (cols()[name] || []).find(r => r._id === id) } },
          async update({ data }) { Object.assign((cols()[name] || []).find(r => r._id === id), data); return { stats: { updated: 1 } } },
          async remove() { const a = cols()[name] || []; const i = a.findIndex(r => r._id === id); if (i >= 0) a.splice(i, 1); return { stats: { removed: 1 } } }
        }
      },
      async add({ data }) {
        const _id = 'id_' + Math.random().toString(36).slice(2, 9)
        if (!cols()[name]) cols()[name] = []
        cols()[name].push({ _id, ...data })
        return { _id }
      }
    }
    return q
  }
  return {
    collection: mk,
    command: {
      gte: (v) => ({ __op: 'gte', val: v, and: (b) => ({ __op: 'range', gte: v, lte: b.val }) }),
      lte: (v) => ({ __op: 'lte', val: v })
    },
    serverDate: () => new Date(),
    async createCollection(name) {
      if (!cols()[name]) { cols()[name] = []; return { errMsg: 'ok' } }
      const e = new Error('exist'); e.errCode = -501001; throw e
    }
  }
}

const mockSdk = {
  DYNAMIC_CURRENT_ENV: Symbol('dyn'),
  init() {},
  getWXContext: () => ({ OPENID: CURRENT.openId }),
  database: () => makeDb()
}
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return mockSdk
  return origLoad.apply(this, arguments)
}

const CF = {
  login: require(path.join(__dirname, 'cloudfunctions/login/index.js')).main,
  db: require(path.join(__dirname, 'cloudfunctions/db/index.js')).main,
  getStats: require(path.join(__dirname, 'cloudfunctions/getStats/index.js')).main,
  settle: require(path.join(__dirname, 'cloudfunctions/settle/index.js')).main
}

// ==================== 断言 ====================
let pass = 0, fail = 0
const fails = [], oks = []
function assert(c, m) { if (c) pass++; else { fail++; fails.push(m) } }
function eq(a, b, m) { assert(a === b, `${m}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`) }
function step(m) { oks.push(m) }

// ==================== wx / App / Page 运行时 mock ====================
const NAV_STACK = []
const TOASTS = []
const STORAGE = {}
const PREVIEWED = []
const SAVED = []
let MODAL_ANSWER = true
let SCROLLED_TO = null
const CANVAS = { arcs: [], fills: [], cleared: 0, texts: [] }

function makeCtx() {
  const ctx = {
    fillStyle: null,
    font: '',
    beginPath() {}, moveTo() {}, closePath() {}, lineTo() {}, stroke() {},
    scale() {},
    fillText(t) { CANVAS.texts.push(String(t)) },
    measureText(t) { return { width: String(t).length * 12 } },
    fillRect() {},
    clearRect() { CANVAS.cleared++ },
    // 只记几何；fillStyle 在 fill() 时才读（drawPie 是先 arc 后赋 fillStyle）
    arc(cx, cy, r, s, e) { CANVAS.arcs.push({ cx, cy, r, start: s, end: e, fillStyle: null }) },
    fill() {
      const last = CANVAS.arcs[CANVAS.arcs.length - 1]
      if (last) last.fillStyle = ctx.fillStyle
      CANVAS.fills.push(ctx.fillStyle)
    }
  }
  return ctx
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let BACK_COUNT = 0

global.wx = {
  cloud: {
    init() {},
    async callFunction({ name, data }) {
      const fn = CF[name]
      if (!fn) throw new Error('未知云函数 ' + name)
      return { result: await fn(data || {}) }
    },
    async uploadFile({ cloudPath }) { return { fileID: 'cloud://mock/' + cloudPath } }
  },
  showToast(o) { TOASTS.push(o.title) },
  previewImage(o) { PREVIEWED.push(o) },
  getStorageSync(k) { return STORAGE[k] === undefined ? '' : STORAGE[k] },
  setStorageSync(k, v) { STORAGE[k] = v },
  showLoading() {}, hideLoading() {},
  showModal(o) { if (o.success) o.success({ confirm: MODAL_ANSWER, cancel: !MODAL_ANSWER }) },
  navigateTo(o) { NAV_STACK.push(o.url) },
  // 不碰 NAV_STACK：页面里有很多 setTimeout(navigateBack, 600)，会干扰后续路由断言
  navigateBack() { BACK_COUNT++ },
  reLaunch(o) { NAV_STACK.length = 0; NAV_STACK.push('RELAYOUT:' + o.url) },
  switchTab(o) { NAV_STACK.length = 0; NAV_STACK.push('TAB:' + o.url) },
  setNavigationBarTitle() {},
  stopPullDownRefresh() {},
  pageScrollTo(o) { SCROLLED_TO = o.selector || ('scrollTop:' + o.scrollTop) },
  nextTick(cb) { cb && cb() },
  setClipboardData(o) { o.success && o.success() },
  getWindowInfo: () => ({ pixelRatio: 3 }),
  getSystemInfoSync: () => ({ pixelRatio: 3 }),
  createSelectorQuery() {
    return { select() { return { fields() { return { exec: (cb) => cb([{ node: { getContext: () => makeCtx(), width: 0, height: 0 }, width: 180, height: 180 }]) } } } } }
  },
  async chooseImage() { return { tempFilePaths: ['/tmp/mock.jpg'] } },
  canvasToTempFilePath(o) { o.success && o.success({ tempFilePath: '/tmp/export.jpg' }) },
  saveImageToPhotosAlbum(o) { SAVED.push(o.filePath); o.success && o.success({}) },
  openSetting(o) { o.success && o.success({}) },
  chooseLocation(o) { o.success && o.success({ name: '亚丁景区', address: '亚丁', latitude: 28.5, longitude: 100.3 }) },
  openLocation(o) { o.success && o.success({}) }
}

let APP_INSTANCE = null
global.App = function (cfg) {
  APP_INSTANCE = cfg
  for (const k of Object.keys(cfg)) if (typeof cfg[k] === 'function') cfg[k] = cfg[k].bind(cfg)
}
global.getApp = () => APP_INSTANCE
const PAGE_STACK = []
global.getCurrentPages = () => PAGE_STACK

let PAGE_CFG = null
global.Page = function (cfg) { PAGE_CFG = cfg }

function loadPage(name) {
  const file = path.join(__dirname, 'miniprogram/pages', name, 'index.js')
  delete require.cache[require.resolve(file)]
  PAGE_CFG = null
  require(file)
  const cfg = PAGE_CFG
  const inst = Object.assign({}, cfg)
  inst.data = JSON.parse(JSON.stringify(cfg.data || {}))
  inst.setData = function (patch) { Object.assign(this.data, patch) }
  inst.route = 'pages/' + name + '/index'
  PAGE_STACK.push(inst)
  return inst
}

// ==================== 走一遍真实用户流程 ====================
;(async () => {
  // ---- 场景 0：干净的云环境 ----
  CURRENT = { collections: {}, openId: 'o_zheng' }

  // ---- 场景 1：首次打开 → app.js onLaunch → login 云函数 ----
  delete require.cache[require.resolve(path.join(__dirname, 'miniprogram/app.js'))]
  require(path.join(__dirname, 'miniprogram/app.js'))
  APP_INSTANCE.onLaunch()
  await APP_INSTANCE.globalData.loginReady
  eq(APP_INSTANCE.globalData.openId, 'o_zheng', 'E2E-1 onLaunch 拿到 openId')
  eq(APP_INSTANCE.globalData.currentMember, null, 'E2E-1 首次打开未注册 → currentMember=null')

  // ---- 场景 2：login 页起名注册 ----
  const loginPage = loadPage('login')
  if (loginPage.onLoad) await loginPage.onLoad()
  loginPage.onInput({ detail: { value: '  小郑  ' } })
  eq(loginPage.data.name, '  小郑  ', 'E2E-2 输入框双向绑定')
  await loginPage.onSubmit()
  // login 页注册成功后延时 600ms 才 switchTab，必须等定时器跑完再断言路由
  await sleep(750)
  eq(APP_INSTANCE.globalData.currentMember.name, '小郑', 'E2E-2 注册后名字已 trim 并写入全局')
  eq(NAV_STACK[0], 'TAB:/pages/trip/index', 'E2E-2 注册成功跳行程 Tab')
  eq(APP_INSTANCE.globalData.currentTrip.name, '国庆川西行', 'E2E-2 自动创建默认旅程')
  step('E2E-2 首次起名 → 自动建旅程 → 跳 Tab1')

  // 空名字被拦
  NAV_STACK.length = 0; TOASTS.length = 0
  const loginPage2 = loadPage('login')
  loginPage2.onInput({ detail: { value: '   ' } })
  await loginPage2.onSubmit()
  assert(loginPage2.data.errMsg.includes('请先填个名字'), 'E2E-2b 空名字应在页面内提示')
  loginPage2.onInput({ detail: { value: '小明' } })
  eq(loginPage2.data.errMsg, '', 'E2E-2b 重新输入后错误提示清除')
  PAGE_STACK.pop()
  // 空名字走的是提前 return 分支，不会产生延时 switchTab 定时器
  eq(NAV_STACK.length, 0, 'E2E-2b 空名字不应发生任何跳转')

  // 报错要能看懂：常见部署问题翻译成可操作的话
  const loginPage3 = loadPage('login')
  eq(
    loginPage3.describeError({ errMsg: 'cloud.callFunction:fail Error: FunctionName parameter could not be found' }),
    '云函数 login 还没部署：在开发者工具里右键 cloudfunctions/login → 上传并部署',
    'E2E-2c 云函数未部署 → 提示去部署'
  )
  assert(
    loginPage3.describeError({ errMsg: 'request:fail timeout' }).includes('网络不通'),
    'E2E-2c 超时 → 提示网络问题'
  )
  assert(
    loginPage3.describeError(new Error('创建成员失败')).includes('创建成员失败'),
    'E2E-2c 云端返回的业务错误原样透出'
  )
  PAGE_STACK.pop()

  // 老用户再进来：login 页 onLoad 应自动跳走，不再要求输名字
  const loginPage4 = loadPage('login')
  NAV_STACK.length = 0
  await loginPage4.onLoad()
  eq(NAV_STACK[0], 'TAB:/pages/trip/index', 'E2E-2d 已注册用户进 login 页自动跳行程')
  PAGE_STACK.pop()

  // ---- 场景 3：朋友加入同一旅程 ----
  const savedOpenId = CURRENT.openId
  CURRENT.openId = 'o_friend'
  const tripCountBefore = CURRENT.collections.trips.length
  const res3 = await CF.login({ name: '小万' })
  eq(res3.trip._id, APP_INSTANCE.globalData.currentTrip._id, 'E2E-3 朋友加入同一旅程（trip._id 一致）')
  eq(CURRENT.collections.trips.length, tripCountBefore, 'E2E-3 未重复创建旅程')
  eq(CURRENT.collections.members.length, 2, 'E2E-3 成员数 = 2')
  CURRENT.openId = savedOpenId
  step('E2E-3 第二个用户注册 → 复用同一旅程，成员 2 人')

  const me = APP_INSTANCE.globalData.currentMember
  const friend = CURRENT.collections.members.find(m => m.openId === 'o_friend')

  // ---- 场景 4：记一笔（record-edit 页）----
  const recPage = loadPage('record-edit')
  await recPage.onLoad({})
  eq(recPage.data.payerId, me._id, 'E2E-4 付款人默认自己')
  eq(recPage.data.participantIds.length, 2, 'E2E-4 参与人默认全选（2 人）')
  eq(recPage.data.date.length, 10, 'E2E-4 日期默认今天')

  // 改成旅程内的日期，验证 day 被正确推算
  recPage.onAmountInput({ detail: { value: '388.50' } })
  recPage.onDateChange({ detail: { value: '2026-10-03' } })
  recPage.onCategoryTap({ currentTarget: { dataset: { key: 'hotel' } } })
  recPage.onNoteInput({ detail: { value: '稻城住宿' } })
  eq(recPage.computeDay('2026-10-03'), 3, 'E2E-4 computeDay 2026-10-03 → Day 3')
  eq(recPage.computeDay('2026-09-01'), null, 'E2E-4 旅程外日期 → day=null')
  await recPage.onSave()
  eq(CURRENT.collections.records.length, 1, 'E2E-4 账目已写入')
  const r1 = CURRENT.collections.records[0]
  eq(r1.amount, 38850, 'E2E-4 388.50 元 → 38850 分（整数分存储）')
  eq(r1.day, 3, 'E2E-4 day 字段已写入（行程页每日花费依赖它）')
  eq(r1.category, 'hotel', 'E2E-4 分类已保存')
  eq(r1.note, '稻城住宿', 'E2E-4 备注已保存')
  step('E2E-4 记一笔 → 金额转整数分 + day 自动推算')

  // 参与人取消到只剩 1 个时不允许再取消
  TOASTS.length = 0
  recPage.onParticipantTap({ currentTarget: { dataset: { id: friend._id } } })
  eq(recPage.data.participantIds.length, 1, 'E2E-4b 取消一个参与人')
  recPage.onParticipantTap({ currentTarget: { dataset: { id: me._id } } })
  eq(recPage.data.participantIds.length, 1, 'E2E-4b 最后一个参与人不可取消')
  assert(TOASTS.some(t => t.includes('至少选一个')), 'E2E-4b 应提示「至少选一个参与人」')
  recPage.onSelectAllParticipants()
  eq(recPage.data.participantIds.length, 2, 'E2E-4b 一键全选恢复 2 人')

  // 图片上传
  await recPage.onChooseImage()
  assert(recPage.data.imageFileIDs[0].startsWith('cloud://mock/records/'), 'E2E-4c 图片上传返回 fileID')

  // 空金额被拦
  TOASTS.length = 0
  const recPage2 = loadPage('record-edit')
  await recPage2.onLoad({})
  await recPage2.onSave()
  assert(TOASTS.some(t => t.includes('请输入金额')), 'E2E-4d 空金额应提示「请输入金额」')
  eq(CURRENT.collections.records.length, 1, 'E2E-4d 空金额不写库')
  PAGE_STACK.pop()

  // ---- 场景 5：再加几笔，让统计有意义 ----
  async function addRecord(payer, participants, yuan, category, date, note) {
    const fmt = require(path.join(__dirname, 'miniprogram/utils/format.js'))
    const day = fmt.daysBetween('2026-10-01', date) + 1
    const r = await CF.db({
      action: 'addRecord',
      data: {
        amount: fmt.yuanToFen(yuan), category, date,
        day: (day >= 1 && day <= 7) ? day : null,
        payerId: payer, participantIds: participants, note
      }
    })
    assert(r._id, 'E2E-5 写入账目 ' + note)
    return r._id
  }
  await addRecord(friend._id, [me._id, friend._id], '260.00', 'food', '2026-10-03', '午餐')
  await addRecord(me._id, [me._id, friend._id], '1200.00', 'traffic', '2026-10-01', '高铁票')
  await addRecord(me._id, [me._id], '80.00', 'ticket', '2026-10-04', '景区门票（只我一人）')

  // ---- 场景 6：账单页（ledger）----
  const ledgerPage = loadPage('ledger')
  await ledgerPage.onLoad()
  eq(ledgerPage.data.recordCount, 4, 'E2E-6 账单页共 4 笔')
  eq(ledgerPage.data.totalCostYuan, '1928.50', 'E2E-6 总支出 ¥1928.50')
  eq(ledgerPage.data.summaryLabel, '总支出', 'E2E-6 未筛选时标题为「总支出」')
  assert(ledgerPage.data.groupedRecords.length >= 3, 'E2E-6 按天分组')
  // 倒序：最新日期在最前
  const dates = ledgerPage.data.groupedRecords.map(g => g.date)
  eq(dates.join(','), dates.slice().sort((a, b) => b.localeCompare(a)).join(','), 'E2E-6 分组按日期倒序')
  // 每条都有分类图标 / 付款人名 / 参与人数
  const firstItem = ledgerPage.data.groupedRecords[0].items[0]
  assert(firstItem.categoryIcon && firstItem.payerName && typeof firstItem.participantCount === 'number',
    'E2E-6 每条含分类图标 + 付款人 + 参与人数')
  step('E2E-6 账单页：倒序按天分组 + 合计 + 付款人/参与人数')

  // 分类筛选
  await new Promise(r => { ledgerPage.onCategoryTap({ currentTarget: { dataset: { key: 'food' } } }); setTimeout(r, 30) })
  eq(ledgerPage.data.activeCategory, 'food', 'E2E-6b 筛选切到餐饮')
  eq(ledgerPage.data.recordCount, 1, 'E2E-6b 餐饮只 1 笔')
  eq(ledgerPage.data.totalCostYuan, '260.00', 'E2E-6b 合计随筛选变化')
  eq(ledgerPage.data.summaryLabel, '餐饮支出', 'E2E-6b 标题改为「餐饮支出」，不会被误读为全程总支出')

  await new Promise(r => { ledgerPage.onCategoryTap({ currentTarget: { dataset: { key: 'shopping' } } }); setTimeout(r, 30) })
  eq(ledgerPage.data.groupedRecords.length, 0, 'E2E-6c 购物分类无数据')

  await new Promise(r => { ledgerPage.onCategoryTap({ currentTarget: { dataset: { key: 'all' } } }); setTimeout(r, 30) })
  eq(ledgerPage.data.recordCount, 4, 'E2E-6d 切回全部恢复 4 笔')

  // 点击某条 → 跳编辑页
  NAV_STACK.length = 0
  ledgerPage.onRecordTap({ currentTarget: { dataset: { id: r1._id } } })
  eq(NAV_STACK[0], `/pages/record-edit/index?id=${r1._id}`, 'E2E-6e 点击账目跳编辑页并带 id')

  // ---- 场景 7：编辑 + 删除账目 ----
  const editPage = loadPage('record-edit')
  await editPage.onLoad({ id: r1._id })
  eq(editPage.data.isEdit, true, 'E2E-7 编辑模式')
  eq(editPage.data.amount, '388.50', 'E2E-7 金额回填为元（388.50）')
  eq(editPage.data.category, 'hotel', 'E2E-7 分类回填')
  eq(editPage.data.note, '稻城住宿', 'E2E-7 备注回填')
  editPage.onAmountInput({ detail: { value: '400.00' } })
  await editPage.onSave()
  eq(CURRENT.collections.records.find(x => x._id === r1._id).amount, 40000, 'E2E-7 修改后金额 = 40000 分')

  MODAL_ANSWER = true
  await editPage.onDelete()
  eq(CURRENT.collections.records.length, 3, 'E2E-7 确认后删除，剩 3 笔')
  MODAL_ANSWER = false
  await editPage.onDelete()
  eq(CURRENT.collections.records.length, 3, 'E2E-7 取消删除则数据不变')
  MODAL_ANSWER = true
  step('E2E-7 账目编辑 / 删除（含二次确认）')

  // ---- 场景 8：行程编辑页 ----
  const schPage = loadPage('schedule-edit')
  await schPage.onLoad({})
  eq(schPage.data.dayRange.length, 7, 'E2E-8 旅程 7 天 → 7 个可选项')
  eq(schPage.data.dayRange[0], '10-01 周四', 'E2E-8 选项文案直接展示日期和星期')
  schPage.onDayChange({ detail: { value: '2' } })
  eq(schPage.data.day, 3, 'E2E-8 picker index 2 → Day 3')
  schPage.onStartTimeChange({ detail: { value: '09:30' } })
  schPage.onTypeTap({ currentTarget: { dataset: { key: 'scenic' } } })
  schPage.onTitleInput({ detail: { value: '  牛奶海徒步  ' } })
  schPage.onChooseLocation()
  eq(schPage.data.location, '亚丁景区', 'E2E-8 地图选点写入地点')
  eq(schPage.data.latitude, 28.5, 'E2E-8 选点坐标已记录')
  TOASTS.length = 0
  await schPage.onSave()
  eq(CURRENT.collections.schedule.length, 1, 'E2E-8 行程已写入')
  const s1 = CURRENT.collections.schedule[0]
  eq(s1.title, '牛奶海徒步', 'E2E-8 标题已 trim')
  eq(s1.day, 3, 'E2E-8 day = 3')
  eq(s1.type, 'scenic', 'E2E-8 类型 = 景点')
  eq(s1.startTime, '09:30', 'E2E-8 开始时间已存')

  // 空标题被拦
  TOASTS.length = 0
  const schPage2 = loadPage('schedule-edit')
  await schPage2.onLoad({})
  await schPage2.onSave()
  assert(TOASTS.some(t => t.includes('请输入标题')), 'E2E-8b 空标题应提示')
  eq(CURRENT.collections.schedule.length, 1, 'E2E-8b 空标题不写库')
  PAGE_STACK.pop()

  // 再加两天行程，让时间轴有多天数据
  await CF.db({ action: 'addSchedule', data: { day: 1, startTime: '08:00', type: 'traffic', title: '成都东站集合', location: '成都东' } })
  await CF.db({ action: 'addSchedule', data: { day: 1, startTime: '07:00', type: 'food', title: '早餐', location: '酒店' } })
  await CF.db({ action: 'addSchedule', data: { day: 5, startTime: '14:00', type: 'hotel', title: '入住稻城酒店', costRecordId: null } })
  eq(CURRENT.collections.schedule.length, 4, 'E2E-8c 共 4 个行程项')

  // 从行程页点进来 → 带上 day 预选
  const schPage3 = loadPage('schedule-edit')
  await schPage3.onLoad({ day: '5' })
  eq(schPage3.data.day, 5, 'E2E-8d 带 day 参数进入时预选 Day 5')
  eq(schPage3.data.dayIndex, 4, 'E2E-8d picker 索引 = 4')
  PAGE_STACK.pop()

  // 关联账目：把 Day 3 的行程项挂到 Day 3 的那笔账上（复用 s1，不改变行程项总数）
  const day3Record = CURRENT.collections.records.find(r => r.day === 3)
  assert(day3Record, 'E2E-8e Day 3 存在可关联账目')
  const schPage4 = loadPage('schedule-edit')
  const schCountBefore = CURRENT.collections.schedule.length
  await schPage4.onLoad({ id: s1._id })
  eq(schPage4.data.title, '牛奶海徒步', 'E2E-8e 编辑态回填标题')
  eq(schPage4.data.costRecordId, null, 'E2E-8e 初始未关联')
  assert(schPage4.data.recordOptions.some(r => r._id === day3Record._id), 'E2E-8e 可关联列表含 Day 3 那笔')
  const optIdx = schPage4.data.recordOptions.findIndex(r => r._id === day3Record._id)
  eq(schPage4.data.recordOptions[optIdx].amountYuan, '260.00', 'E2E-8e 可关联金额展示 ¥260.00')
  eq(schPage4.data.recordOptions[optIdx].icon, getCategory(day3Record.category).icon, 'E2E-8e 关联项带分类图标')
  eq(schPage4.data.recordPickerRange.length, schPage4.data.recordOptions.length + 1, 'E2E-8e picker 末项为清除关联')
  eq(schPage4.data.recordPickerRange[schPage4.data.recordOptions.length], '清除关联', 'E2E-8e picker 末项文案')
  schPage4.onCostRecordChange({ detail: { value: String(optIdx) } })
  eq(schPage4.data.costRecordId, day3Record._id, 'E2E-8e 选择器建立关联')
  eq(schPage4.data.costRecordIndex, optIdx, 'E2E-8e 回显下标同步')
  assert(schPage4.data.costSummary.includes('260.00'), 'E2E-8e 摘要文案含金额')
  schPage4.onCostRecordChange({ detail: { value: String(schPage4.data.recordOptions.length) } })
  eq(schPage4.data.costRecordId, null, 'E2E-8e 选清除关联则取消')
  schPage4.onCostRecordChange({ detail: { value: String(optIdx) } })
  await schPage4.onSave()
  eq(CURRENT.collections.schedule.find(s => s._id === s1._id).costRecordId, day3Record._id, 'E2E-8e costRecordId 已落库')
  eq(CURRENT.collections.schedule.length, schCountBefore, 'E2E-8e 关联操作未新增行程项')
  PAGE_STACK.pop()

  // 编辑回显已关联账目；已被别的行程关联的账目从可关联列表排除
  const schPage5 = loadPage('schedule-edit')
  await schPage5.onLoad({ id: s1._id })
  eq(schPage5.data.costRecordId, day3Record._id, 'E2E-8f 编辑时回填已关联账目')
  eq(schPage5.data.costRecordIndex, schPage5.data.recordOptions.findIndex(r => r._id === day3Record._id), 'E2E-8f 回显下标与列表一致')
  PAGE_STACK.pop()
  const otherSch = CURRENT.collections.schedule.find(s => s._id !== s1._id)
  const schPage6 = loadPage('schedule-edit')
  await schPage6.onLoad({ id: otherSch._id })
  assert(!schPage6.data.recordOptions.some(r => r._id === day3Record._id), 'E2E-8f 已被别的行程关联的账目不再可选')
  PAGE_STACK.pop()

  step('E2E-8 行程编辑：天数选择 / 校验 / trim / day 预选 / 关联账目')

  // ---- 场景 9：行程页（trip）----
  const tripPage = loadPage('trip')
  SCROLLED_TO = null
  await tripPage.onLoad()
  eq(tripPage.data.days.length, 7, 'E2E-9 时间轴渲染 7 天')
  eq(tripPage.data.totalItemCount, 4, 'E2E-9 行程项总数 = 4')
  const day1 = tripPage.data.days[0]
  eq(day1.day, 1, 'E2E-9 Day 1')
  eq(day1.date, '2026-10-01', 'E2E-9 Day 1 日期 = 2026-10-01')
  eq(day1.weekday, '周四', 'E2E-9 Day 1 星期')
  eq(day1.items.length, 2, 'E2E-9 Day 1 有 2 项')
  eq(day1.items[0].title, '早餐', 'E2E-9 同一天内按 startTime 升序（07:00 早餐在前）')
  eq(day1.items[0].typeName, '餐饮', 'E2E-9 类型中文名已映射')
  eq(day1.items[0].typeIcon, '餐', 'E2E-9 类型图标已映射')
  eq(tripPage.data.days[2].items.length, 1, 'E2E-9 Day 3 有 1 项')
  eq(tripPage.data.days[2].items[0].costYuan, '260.00', 'E2E-9 行程项展示关联账目金额 ¥260.00')
  eq(tripPage.data.days[2].dayCostYuan, '260.00', 'E2E-9 Day 3 当日花费 = ¥260.00（依赖 records.day）')
  eq(tripPage.data.days[0].dayCostYuan, '0.00', 'E2E-9 Day 1 无关联账目 → 当日花费 0（关联口径）')
  assert(tripPage.data.countdown, 'E2E-9 倒计时卡片有数据')
  // 附件预览：眼睛按钮（多张可滑看 + 旧单图字段兼容）
  const imgSch = await CF.db({ action: 'addSchedule', data: { day: 2, type: 'scenic', title: '带附件的行程', imageFileIDs: ['cloud://a', 'cloud://b'] } })
  const legacySch = await CF.db({ action: 'addSchedule', data: { day: 2, type: 'other', title: '旧单图行程', imageFileID: 'cloud://old' } })
  const imgPage = loadPage('trip')
  await imgPage.onLoad()
  const findItem = (page, id) => page.data.days.reduce((acc, d) => acc || d.items.find(x => x._id === id), null)
  eq(findItem(imgPage, imgSch._id).imageCount, 2, 'E2E-9i imageFileIDs 两张 → imageCount 2')
  eq(findItem(imgPage, legacySch._id).imageCount, 1, 'E2E-9i 旧字段 imageFileID → imageCount 1')
  eq(findItem(imgPage, s1._id).imageCount, 0, 'E2E-9i 无附件 → imageCount 0')
  PREVIEWED.length = 0
  imgPage.onPreviewImages({ currentTarget: { dataset: { id: imgSch._id } } })
  eq(PREVIEWED.length, 1, 'E2E-9i 点眼睛触发预览')
  eq(PREVIEWED[0].urls.length, 2, 'E2E-9i 预览带上全部附件可滑动查看')
  PAGE_STACK.pop()

  step('E2E-9 行程页：7 天时间轴 + 当日花费 + 类型映射')

  // 倒计时三种状态
  const trip = APP_INSTANCE.globalData.currentTrip
  const realToday = require(path.join(__dirname, 'miniprogram/utils/format.js')).today
  const setTripDates = (s, e) => { tripPage.setData({ trip: { ...tripPage.data.trip, startDate: s, endDate: e } }) }

  setTripDates('2099-01-10', '2099-01-15')
  let c = tripPage.computeCountdown()
  eq(c.countdown.mode, 'before', 'E2E-9b 未来旅程 → mode=before')
  eq(c.countdown.text, '距离出发还有', 'E2E-9b 文案「距离出发还有」')
  eq(c.countdown.unit, '天', 'E2E-9b 单位「天」')
  assert(c.countdown.value > 20000, 'E2E-9b 倒计时天数 > 20000')
  eq(c.scrollToDay, 1, 'E2E-9b 未出发 → 定位 Day 1')
  SCROLLED_TO = null
  tripPage.positionToCurrentDay(c.countdown)
  eq(SCROLLED_TO, null, 'E2E-9b 未出发时不自动滚动（停在顶部看倒计时卡片）')

  setTripDates('2000-01-01', '2000-01-05')
  c = tripPage.computeCountdown()
  eq(c.countdown.mode, 'after', 'E2E-9c 过去旅程 → mode=after')
  eq(c.countdown.text, '旅行已结束', 'E2E-9c 文案「旅行已结束」')
  eq(c.scrollToDay, 5, 'E2E-9c 已结束 → 定位最后一天')

  const t = realToday()
  setTripDates(t, t)
  c = tripPage.computeCountdown()
  eq(c.countdown.mode, 'during', 'E2E-9d 今天在旅程内 → mode=during')
  eq(c.countdown.value, t.slice(5), 'E2E-9d 旅行中倒计时展示今天日期')
  SCROLLED_TO = null
  tripPage.setData({ scrollToDay: c.scrollToDay })
  tripPage.positionToCurrentDay(c.countdown)
  eq(SCROLLED_TO, '#day-1', 'E2E-9d 旅行中自动滚到当日锚点')

  // 恢复真实旅程日期
  setTripDates(trip.startDate, trip.endDate)

  // 左滑删除
  tripPage.setData({ openSwipeId: '' })
  tripPage.onTouchStart({ touches: [{ clientX: 300, clientY: 100 }] })
  tripPage.onTouchMove({ touches: [{ clientX: 250, clientY: 102 }] })
  tripPage.onTouchEnd({ changedTouches: [{ clientX: 200, clientY: 102 }], currentTarget: { dataset: { id: s1._id } } })
  eq(tripPage.data.openSwipeId, s1._id, 'E2E-9e 左滑 100px → 展开删除按钮')
  // 展开时点击只收起，不跳编辑页
  NAV_STACK.length = 0
  tripPage.onItemTap({ currentTarget: { dataset: { id: s1._id } } })
  eq(tripPage.data.openSwipeId, '', 'E2E-9e 展开时点击先收起')
  eq(NAV_STACK.length, 0, 'E2E-9e 收起时不跳编辑页')
  // 正常点击进入编辑
  tripPage.onItemTap({ currentTarget: { dataset: { id: s1._id } } })
  eq(NAV_STACK[0], `/pages/schedule-edit/index?id=${s1._id}`, 'E2E-9e 未展开时点击跳编辑页')
  // 竖向滚动不触发左滑
  tripPage.setData({ openSwipeId: '' })
  tripPage.onTouchStart({ touches: [{ clientX: 300, clientY: 100 }] })
  tripPage.onTouchMove({ touches: [{ clientX: 298, clientY: 260 }] })
  tripPage.onTouchEnd({ changedTouches: [{ clientX: 298, clientY: 260 }], currentTarget: { dataset: { id: s1._id } } })
  eq(tripPage.data.openSwipeId, '', 'E2E-9e 竖向滚动不误触左滑')
  // 真正删除
  const beforeDel = CURRENT.collections.schedule.length
  await tripPage.onDeleteTap({ currentTarget: { dataset: { id: s1._id, title: '牛奶海徒步' } } })
  eq(CURRENT.collections.schedule.length, beforeDel - 1, 'E2E-9f 左滑删除生效')
  eq(tripPage.data.totalItemCount, beforeDel - 1, 'E2E-9f 删除后列表已刷新')
  step('E2E-9 倒计时三态 + 当日定位 + 左滑删除')

  // 下拉刷新
  await tripPage.onPullDownRefresh()
  assert(tripPage.data.totalItemCount === CURRENT.collections.schedule.length, 'E2E-9g 下拉刷新后数据一致')

  // 顶部 + / 右下角 FAB 共用 onAddTap，都应跳新增行程页
  NAV_STACK.length = 0
  tripPage.onAddTap()
  eq(NAV_STACK[0], '/pages/schedule-edit/index', 'E2E-9h 顶部 + 新增跳行程编辑页（不带 id）')

  // ---- 场景 10：统计页（stats）+ 饼图 + AA ----
  CANVAS.arcs.length = 0; CANVAS.fills.length = 0
  const statsPage = loadPage('stats')
  await statsPage.onLoad()
  eq(statsPage.data.count, 3, 'E2E-10 统计 3 笔')
  eq(statsPage.data.memberCount, 2, 'E2E-10 2 人')
  eq(statsPage.data.totalYuan, '1540.00', 'E2E-10 总花销 ¥1540.00')
  eq(statsPage.data.avgYuan, '770.00', 'E2E-10 人均 ¥770.00')
  eq(statsPage.data.categoryList.length, 3, 'E2E-10 3 个有金额的分类')
  eq(statsPage.data.categoryList[0].key, 'traffic', 'E2E-10 分类按金额降序，交通最大')
  eq(statsPage.data.categoryList[0].amountYuan, '1200.00', 'E2E-10 交通 ¥1200.00')
  eq(statsPage.data.categoryList[0].percent, 77.9, 'E2E-10 交通占比 77.9%')
  const pctSum = statsPage.data.categoryList.reduce((a, c) => a + c.percent, 0)
  assert(Math.abs(pctSum - 100) < 0.5, `E2E-10 占比合计≈100%（实际 ${pctSum}）`)

  // 饼图真的画了
  assert(CANVAS.arcs.length >= 3, `E2E-10b 饼图绘制了 ${CANVAS.arcs.length} 个扇形（应 ≥3）`)
  eq(CANVAS.fills.filter(f => f === '#FFFFFF').length >= 1, true, 'E2E-10b 中心挖白成环形')
  const angles = CANVAS.arcs.filter(a => a.fillStyle !== '#FFFFFF')
  const totalAngle = angles.reduce((s, a) => s + (a.end - a.start), 0)
  assert(Math.abs(totalAngle - Math.PI * 2) < 1e-9, `E2E-10b 扇形角度合计 = 2π（实际 ${totalAngle}）`)
  eq(angles[0].start, -Math.PI / 2, 'E2E-10b 从 12 点方向起画')
  const colors = angles.map(a => a.fillStyle)
  assert(colors.includes('#4A90E2') && colors.includes('#FF6B35') && colors.includes('#16A085'),
    'E2E-10b 扇形使用分类配色')
  step('E2E-10 统计页：总额/人均/分类占比 + canvas 环形饼图（角度合计 2π）')

  // 每人已付 / 应付 / 差额
  const bal = statsPage.data.balances
  eq(bal.length, 2, 'E2E-10c 2 人余额')
  const zheng = bal.find(b => b.name === '小郑')
  const wan = bal.find(b => b.name === '小万')
  eq(zheng.paidYuan, '1280.00', 'E2E-10c 小郑已付 ¥1280（高铁1200 + 门票80）')
  eq(zheng.owedYuan, '810.00', 'E2E-10c 小郑应付 ¥810（午餐130 + 高铁600 + 门票80）')
  eq(wan.paidYuan, '260.00', 'E2E-10c 小万只付了午餐 ¥260')
  eq(wan.owedYuan, '730.00', 'E2E-10c 小万应付 ¥730（午餐130 + 高铁600）')
  eq(zheng.diffType, 'recv', 'E2E-10c 小郑标记为应收')
  eq(wan.diffType, 'pay', 'E2E-10c 小万标记为应付')
  eq(zheng.diffText, '应收 ¥470.00', 'E2E-10c 小郑应收 ¥470.00')
  eq(wan.diffText, '应付 ¥470.00', 'E2E-10c 小万应付 ¥470.00')
  // 每人收支行内展开本人付款明细
  assert(zheng.records.length > 0, 'E2E-10f 每人收支行带本人付款记录')
  const r0 = zheng.records[0]
  assert(r0.categoryName && r0.dateShort && r0.amountYuan && r0.icon, 'E2E-10f 明细含分类/日期/金额/图标')
  eq(statsPage.data.openMemberId, '', 'E2E-10f 明细默认收起')
  statsPage.onMemberTap({ currentTarget: { dataset: { id: zheng.memberId } } })
  eq(statsPage.data.openMemberId, zheng.memberId, 'E2E-10f 点击展开本人明细')
  statsPage.onMemberTap({ currentTarget: { dataset: { id: zheng.memberId } } })
  eq(statsPage.data.openMemberId, '', 'E2E-10f 再点收起')

  // 导出长图：画布内容 + 保存相册
  SAVED.length = 0
  CANVAS.texts.length = 0
  await statsPage.onExportTap()
  eq(SAVED.length, 1, 'E2E-10g 导出长图已保存到相册')
  assert(TOASTS.includes('已保存到相册'), 'E2E-10g 保存成功 toast')
  assert(CANVAS.texts.some(t => t.includes('分类统计')), 'E2E-10g 长图含分类统计')
  assert(CANVAS.texts.some(t => t.includes('每人收支')), 'E2E-10g 长图含每人收支')
  assert(CANVAS.texts.some(t => t.includes('账单明细')), 'E2E-10g 长图含账单明细')
  assert(CANVAS.texts.some(t => t.includes('高铁票')), 'E2E-10g 长图含明细备注')
  eq(statsPage.data.exporting, false, 'E2E-10g 导出结束复位 exporting')

  step('E2E-10 每人已付/应付/差额')

  // 下拉刷新
  await statsPage.onPullDownRefresh()
  eq(statsPage.data.count, 3, 'E2E-10f 下拉刷新后仍为 3 笔')

  // ---- 场景 11：我的页 + 旅程设置 ----
  const minePage = loadPage('mine')
  await minePage.onLoad()
  eq(minePage.data.member.name, '小郑', 'E2E-11 我的页显示名字')
  eq(minePage.data.avatarText, '小', 'E2E-11 头像取名字首字')
  eq(minePage.data.trip.name, '国庆川西行', 'E2E-11 显示旅程名')
  NAV_STACK.length = 0
  minePage.onTripSettingTap()
  eq(NAV_STACK[0], '/pages/trip-setting/index', 'E2E-11 点击进入旅程设置')

  const setPage = loadPage('trip-setting')
  await setPage.onLoad()
  eq(setPage.data.name, '国庆川西行', 'E2E-11b 旅程名回填')
  eq(setPage.data.startDate, '2026-10-01', 'E2E-11b 出发日回填')
  eq(setPage.data.endDate, '2026-10-07', 'E2E-11b 返回日回填')
  setPage.onNameInput({ detail: { value: '稻城亚丁环线' } })
  setPage.onStartDateChange({ detail: { value: '2026-09-30' } })
  setPage.onEndDateChange({ detail: { value: '2026-10-08' } })
  await setPage.onSave()
  eq(APP_INSTANCE.globalData.currentTrip.name, '稻城亚丁环线', 'E2E-11b 全局旅程名已更新')
  eq(CURRENT.collections.trips[0].startDate, '2026-09-30', 'E2E-11b 库里出发日已更新')
  eq(CURRENT.collections.trips[0].endDate, '2026-10-08', 'E2E-11b 库里返回日已更新')

  // 日期非法被拦
  TOASTS.length = 0
  const setPage2 = loadPage('trip-setting')
  await setPage2.onLoad()
  setPage2.onStartDateChange({ detail: { value: '2026-10-10' } })
  setPage2.onEndDateChange({ detail: { value: '2026-10-05' } })
  await setPage2.onSave()
  assert(TOASTS.some(t => t.includes('出发日不能晚于返回日')), 'E2E-11c 出发日晚于返回日被拦')
  PAGE_STACK.pop()

  // 旅程改期后，行程页天数自动跟着变（9 天）
  tripPage.setData({ trip: APP_INSTANCE.globalData.currentTrip })
  await tripPage.loadData()
  eq(tripPage.data.days.length, 9, 'E2E-11d 旅程改为 09-30~10-08 后时间轴变 9 天')
  eq(tripPage.data.days[0].date, '2026-09-30', 'E2E-11d Day 1 = 新的出发日')
  step('E2E-11 我的页 + 旅程设置（改期后行程天数自动调整）')

  // ---- 场景 12：未注册用户访问受保护页 → 跳起名页 ----
  CURRENT.openId = 'o_stranger'
  APP_INSTANCE.globalData.currentMember = null
  APP_INSTANCE.globalData.loginReady = Promise.resolve()
  NAV_STACK.length = 0
  const guarded = loadPage('stats')
  const { ensureLogin } = require(path.join(__dirname, 'miniprogram/utils/auth.js'))
  const authRes = await ensureLogin()
  eq(authRes, null, 'E2E-12 未注册 → ensureLogin 返回 null')
  eq(NAV_STACK[0], 'RELAYOUT:/pages/login/index', 'E2E-12 未注册 → reLaunch 到起名页')
  CURRENT.openId = 'o_zheng'
  APP_INSTANCE.globalData.currentMember = me
  step('E2E-12 未注册用户被拦回起名页')

  // ---- 场景 13：行程节点待办与备忘 ----
  const todoPage = loadPage('schedule-edit')
  await todoPage.onLoad({})
  todoPage.onDayChange({ detail: { value: '1' } })
  todoPage.onTypeTap({ currentTarget: { dataset: { key: 'traffic' } } })
  todoPage.onTitleInput({ detail: { value: '坐火车去成都' } })
  todoPage.onNoteInput({ detail: { value: '车次 G1234，二等座' } })
  todoPage.onTodoInput({ detail: { value: '  买火车票  ' } })
  todoPage.onTodoAdd()
  todoPage.onTodoInput({ detail: { value: '打印行程单' } })
  todoPage.onTodoAdd()
  todoPage.onTodoInput({ detail: { value: '误加的' } })
  todoPage.onTodoAdd()
  eq(todoPage.data.todos.length, 3, 'E2E-13 添加 3 条待办')
  eq(todoPage.data.todos[0].text, '买火车票', 'E2E-13 待办文字已 trim')
  eq(todoPage.data.todoInput, '', 'E2E-13 添加后输入框已清空')
  assert(todoPage.data.todos[0].id && todoPage.data.todos[0].id !== todoPage.data.todos[1].id, 'E2E-13 每条待办有唯一 id')
  TOASTS.length = 0
  todoPage.onTodoInput({ detail: { value: '   ' } })
  todoPage.onTodoAdd()
  assert(TOASTS.some(t => t.includes('请输入待办内容')), 'E2E-13 空待办被拦')
  eq(todoPage.data.todos.length, 3, 'E2E-13 空待办未入列')
  todoPage.onTodoDelete({ currentTarget: { dataset: { index: '2' } } })
  eq(todoPage.data.todos.length, 2, 'E2E-13 删除后剩 2 条')
  todoPage.onTodoToggle({ currentTarget: { dataset: { index: '0' } } })
  eq(todoPage.data.todos[0].done, true, 'E2E-13 编辑页勾选生效')
  eq(todoPage.data.todoDoneCount, 1, 'E2E-13 已完成计数 = 1')
  await todoPage.onSave()
  const todoItem = CURRENT.collections.schedule.find(s => s.title === '坐火车去成都')
  assert(todoItem, 'E2E-13 行程项已写入')
  eq(todoItem.day, 2, 'E2E-13 day = 2')
  eq(todoItem.todos.length, 2, 'E2E-13 待办已落库')
  eq(todoItem.todos[0].done, true, 'E2E-13 完成态已落库')
  eq(todoItem.note, '车次 G1234，二等座', 'E2E-13 备忘已落库')
  PAGE_STACK.pop()

  // 云函数拒绝非法待办
  const bad1 = await CF.db({ action: 'addSchedule', data: { day: 2, type: 'other', title: '非法待办', todos: [{ text: '没有 id' }] } })
  eq(bad1.code, 'INVALID_TODOS', 'E2E-13b 待办缺 id 被云函数拒绝')
  const bad2 = await CF.db({ action: 'addSchedule', data: { day: 2, type: 'other', title: '非法待办', todos: '不是数组' } })
  eq(bad2.code, 'INVALID_TODOS', 'E2E-13b todos 非数组被拒绝')
  const bad3 = await CF.db({ action: 'addSchedule', data: { day: 2, type: 'other', title: '非法待办', todos: [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }] } })
  eq(bad3.code, 'INVALID_TODOS', 'E2E-13b 待办 id 重复被拒绝')
  eq(CURRENT.collections.schedule.some(s => s.title === '非法待办'), false, 'E2E-13b 非法待办未写库')

  // 行程页：待办进度 + 准备进度汇总 + 直接勾选
  const todoTrip = loadPage('trip')
  SCROLLED_TO = null
  await todoTrip.onLoad()
  const linked = todoTrip.data.days[1].items.find(s => s.title === '坐火车去成都')
  assert(linked, 'E2E-13c Day 2 找到新行程项')
  eq(linked.todoTotal, 2, 'E2E-13c 行程项待办总数 = 2')
  eq(linked.todoDone, 1, 'E2E-13c 已完成 = 1')
  eq(linked.note, '车次 G1234，二等座', 'E2E-13c 备忘随行项带出')
  eq(todoTrip.data.prepTotal, 2, 'E2E-13c 准备进度总数 = 2')
  eq(todoTrip.data.prepDone, 1, 'E2E-13c 准备进度已完成 = 1')
  eq(todoTrip.data.prepPercent, 50, 'E2E-13c 准备进度 50%')
  eq(todoTrip.data.prepAll.length, 2, 'E2E-13c 展开清单含全部待办')
  eq(todoTrip.data.prepAll[0].text, '打印行程单', 'E2E-13c 未完成项排在最前')
  eq(todoTrip.data.prepAll[0].title, '坐火车去成都', 'E2E-13c 清单项带出所属行程标题')
  eq(todoTrip.data.prepAll[0].dateShort, todoTrip.data.days[1].dateShort, 'E2E-13c 清单项带出所属天日期')

  // 直接在行程页勾选 → 乐观更新 + 落库
  const tid2 = linked.todos[1].id
  await todoTrip.onTodoTap({ currentTarget: { dataset: { sid: linked._id, tid: tid2 } } })
  eq(todoTrip.data.days[1].items.find(s => s._id === linked._id).todoDone, 2, 'E2E-13d 勾选后已完成 = 2')
  eq(todoTrip.data.prepDone, 2, 'E2E-13d 准备进度已完成 = 2')
  eq(todoTrip.data.prepPercent, 100, 'E2E-13d 准备进度 100%')
  eq(todoTrip.data.prepAll.filter(t => !t.done).length, 0, 'E2E-13d 未完成清单已清空')
  eq(CURRENT.collections.schedule.find(s => s._id === linked._id).todos[1].done, true, 'E2E-13d 勾选已落库')

  // 取消勾选 → 回到未完成清单
  await todoTrip.onTodoTap({ currentTarget: { dataset: { sid: linked._id, tid: tid2 } } })
  eq(todoTrip.data.prepDone, 1, 'E2E-13e 取消勾选后已完成 = 1')
  eq(todoTrip.data.prepAll.filter(t => !t.done).length, 1, 'E2E-13e 未完成清单恢复 1 条')
  eq(CURRENT.collections.schedule.find(s => s._id === linked._id).todos[1].done, false, 'E2E-13e 取消勾选已落库')

  // 未知 id 静默忽略，不改数据
  const pendingSnapshot = JSON.stringify(todoTrip.data.prepAll)
  await todoTrip.onTodoTap({ currentTarget: { dataset: { sid: '不存在', tid: '不存在' } } })
  eq(JSON.stringify(todoTrip.data.prepAll), pendingSnapshot, 'E2E-13f 未知待办 id 静默忽略')

  // 准备卡片展开 / 收起
  eq(todoTrip.data.prepOpen, false, 'E2E-13g 准备卡片默认收起')
  todoTrip.onPrepToggle()
  eq(todoTrip.data.prepOpen, true, 'E2E-13g 点击展开')
  todoTrip.onPrepToggle()
  eq(todoTrip.data.prepOpen, false, 'E2E-13g 再点收起')

  // 下拉刷新后待办仍在（从云端重新读回）
  await todoTrip.onPullDownRefresh()
  eq(todoTrip.data.prepTotal, 2, 'E2E-13h 刷新后待办总数仍为 2')
  eq(todoTrip.data.prepDone, 1, 'E2E-13h 刷新后完成态与服务端一致')
  step('E2E-13 行程节点待办与备忘（编辑页增删勾选 + 行程页直接勾选 + 准备进度汇总）')

  // ==================== 汇总 ====================
  console.log('')
  oks.forEach(o => console.log('  ✓ ' + o))
  console.log('')
  if (fail === 0) {
    console.log(`==== E2E 全部通过：${pass} 条断言 / 0 失败（覆盖 13 个场景）====`)
  } else {
    console.log(`==== E2E ${fail} 条失败（通过 ${pass}）====`)
    fails.forEach(f => console.log('  ✗ ' + f))
    process.exitCode = 1
  }
})().catch(e => { console.error('E2E 异常', e); process.exitCode = 1 })
