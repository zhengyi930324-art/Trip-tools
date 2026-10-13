/* 临时单测：mock wx-server-sdk，真实调用云函数 exports.main */
const Module = require('module')
const path = require('path')

// ---------- 可链式调用的 DB mock ----------
// 注意：云函数在模块加载时就 const db = cloud.database()，
// 所以所有集合访问必须惰性读 CURRENT.collections，不能在构造时快照。
let CURRENT = { collections: {}, openId: 'o_alice' }

function makeDb() {
  const cols = () => CURRENT.collections
  const mk = (name) => {
    const q = {
      _where: null,
      _orderBy: [],
      _limit: 20,
      _skip: 0,
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
              if (v.__op === 'in') return v.val.includes(r[k])
              if (v.__op === 'exists') return v.val ? r[k] !== undefined : r[k] === undefined
              return true
            }
            return r[k] === v
          }))
        }
        for (const [f, d] of q._orderBy.slice().reverse()) {
          rows.sort((a, b) => {
            const x = a[f], y = b[f]
            const c = x < y ? -1 : x > y ? 1 : 0
            return d === 'desc' ? -c : c
          })
        }
        return { data: rows.slice(q._skip, q._skip + q._limit) }
      },
      doc(id) {
        return {
          async get() {
            const data = (cols()[name] || []).find(r => r._id === id)
            if (!data) throw new Error(`document with _id ${id} does not exist`)
            return { data }
          },
          async update({ data }) {
            const row = (cols()[name] || []).find(r => r._id === id)
            Object.assign(row, data); return { stats: { updated: 1 } }
          },
          async set({ data }) {
            if (!cols()[name]) cols()[name] = []
            const rows = cols()[name]
            const row = rows.find(r => r._id === id)
            if (row) Object.assign(row, data)
            else rows.push({ _id: id, ...data })
            return { _id: id }
          },
          async remove() {
            const arr = cols()[name] || []
            const i = arr.findIndex(r => r._id === id)
            if (i >= 0) arr.splice(i, 1)
            return { stats: { removed: 1 } }
          }
        }
      },
      async update({ data }) {
        const rows = (cols()[name] || []).filter(r => !q._where || Object.keys(q._where).every(k => {
          const value = q._where[k]
          if (value && value.__op === 'exists') return value.val ? r[k] !== undefined : r[k] === undefined
          return r[k] === value
        }))
        rows.forEach(row => Object.assign(row, data))
        return { stats: { updated: rows.length }, updated: rows.length }
      },
      async remove() {
        const rows = cols()[name] || []
        const matches = rows.filter(r => !q._where || Object.keys(q._where).every(k => r[k] === q._where[k]))
        cols()[name] = rows.filter(r => !matches.includes(r))
        return { stats: { removed: matches.length }, deleted: matches.length }
      },
      async count() {
        const rows = (cols()[name] || []).filter(r => !q._where || Object.keys(q._where).every(k => r[k] === q._where[k]))
        return { total: rows.length }
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
  const cmp = () => ({
    gte: (v) => ({ __op: 'gte', val: v, and: (b) => ({ __op: 'range', gte: v, lte: b.val }) }),
    lte: (v) => ({ __op: 'lte', val: v }),
    in: (v) => ({ __op: 'in', val: v }),
    exists: (v) => ({ __op: 'exists', val: v })
  })
  return {
    collection: mk,
    command: cmp(),
    serverDate: () => new Date(),
    async createCollection(name) {
      if (!cols()[name]) { cols()[name] = []; return { errMsg: 'ok' } }
      const e = new Error('already exist'); e.errCode = -501001; throw e
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

const settleMain = require(path.join(__dirname, 'cloudfunctions/settle/index.js')).main
const statsMain = require(path.join(__dirname, 'cloudfunctions/getStats/index.js')).main
const loginFn = require(path.join(__dirname, 'cloudfunctions/login/index.js')).main
const dbMain = require(path.join(__dirname, 'cloudfunctions/db/index.js')).main
const dbFn = event => dbMain({ ...event, data: { tripId: 't1', ...(event.data || {}) } })
const settleFn = event => settleMain({ ...event, tripId: 't1' })
const statsFn = event => statsMain({ ...event, tripId: 't1' })

// ---------- 断言工具 ----------
let pass = 0, fail = 0
const fails = []
const ok = []
function assert(cond, msg) {
  if (cond) { pass++ } else { fail++; fails.push(msg) }
}
function eq(a, b, msg) { assert(a === b, `${msg} (期望 ${b}，实际 ${a})`) }

function seed(members, records) {
  CURRENT = {
    collections: {
      members: members.map((m, i) => ({ _id: 'm' + i, openId: 'o' + i, name: m, avatarFileID: '', createdAt: new Date(2026, 0, i + 1) })),
      tripMembers: members.map((_, i) => ({ _id: `tm${i}`, tripId: 't1', memberId: `m${i}`, role: i === 0 ? 'creator' : 'member' })),
      records: records.map(record => ({ tripId: 't1', ...record })), schedule: [], trips: [{ _id: 't1', name: '国庆川西行', startDate: '2026-10-01', endDate: '2026-10-07', createdByMemberId: 'm0', createdAt: new Date(), updatedAt: new Date() }]
    },
    openId: 'o0'
  }
}
function rec(payerIdx, participantIdxs, amount, category, date) {
  return {
    _id: 'r_' + Math.random().toString(36).slice(2, 8),
    date, day: 1, category, amount,
    payerId: 'm' + payerIdx,
    participantIds: participantIdxs.map(i => 'm' + i),
    note: '', imageFileID: '', createdByOpenId: 'o0', createdAt: new Date(), updatedAt: new Date()
  }
}

;(async () => {
  // ===== 用例 1：4 人 AA，整除 =====
  seed(['小明', '小红', '小美', '小刚'], [
    rec(0, [0, 1, 2, 3], 40000, 'hotel', '2026-10-01'),   // 小明付 400，4 人均摊 → 每人 100
    rec(1, [0, 1, 2, 3], 20000, 'food', '2026-10-01'),    // 小红付 200
    rec(2, [0, 1, 2, 3], 12000, 'traffic', '2026-10-02')  // 小美付 120
  ])
  let s = await statsFn({})
  if (s.error) throw new Error('用例1 getStats 意外报错: ' + s.error)
  eq(s.total, 72000, '用例1 总花销')
  eq(s.count, 3, '用例1 笔数')
  eq(s.memberCount, 4, '用例1 人数')
  eq(s.byCategory.hotel, 40000, '用例1 住宿分类')
  eq(s.byCategory.food, 20000, '用例1 餐饮分类')
  const paidSum = s.balances.reduce((a, b) => a + b.paid, 0)
  const owedSum = s.balances.reduce((a, b) => a + b.owed, 0)
  eq(paidSum, 72000, '用例1 已付合计=总花销')
  eq(owedSum, 72000, '用例1 应付合计=总花销（无余数丢失）')
  eq(s.balances.reduce((a, b) => a + b.balance, 0), 0, '用例1 差额合计为 0')
  eq(s.balances[0].balance, 40000 - 18000, '用例1 小明差额')

  let st = await settleFn({})
  eq(st.transfers.length, 3, '用例1 最少转账次数=3（3 个欠款人各转 1 次）')
  const inSum = {}, outSum = {}
  st.transfers.forEach(t => {
    outSum[t.fromName] = (outSum[t.fromName] || 0) + t.amount
    inSum[t.toName] = (inSum[t.toName] || 0) + t.amount
    assert(t.amount > 0, '用例1 转账金额为正')
    assert(t.fromId !== t.toId, '用例1 不存在自己转自己')
  })
  s.balances.forEach(b => {
    if (b.balance < 0) eq(outSum[b.name] || 0, -b.balance, `用例1 ${b.name} 转出=欠款`)
    if (b.balance > 0) eq(inSum[b.name] || 0, b.balance, `用例1 ${b.name} 转入=应收`)
    if (b.balance === 0) eq(outSum[b.name] || 0, 0, `用例1 ${b.name} 不参与转账`)
  })
  // 余额：小明 +22000、小红 +2000、小美 -6000、小刚 -18000 → 转账总额 = 6000+18000
  eq(st.transfers.reduce((a, t) => a + t.amount, 0), 24000, '用例1 转账总额平衡')

  // ===== 用例 2：不能整除，验证余数分配不丢分 =====
  seed(['A', 'B', 'C'], [rec(0, [0, 1, 2], 10000, 'food', '2026-10-01')]) // 100 元 3 人分
  s = await statsFn({})
  eq(s.balances.reduce((a, b) => a + b.owed, 0), 10000, '用例2 应付合计=10000 分（3333+3333+3334）')
  eq(s.balances[0].owed, 3334, '用例2 首个参与人多摊 1 分')
  eq(s.balances[1].owed, 3333, '用例2 第二个参与人')
  eq(s.balances[2].owed, 3333, '用例2 第三个参与人')
  eq(s.balances.reduce((a, b) => a + b.balance, 0), 0, '用例2 差额合计为 0')
  st = await settleFn({})
  eq(st.transfers.length, 2, '用例2 两次转账')
  eq(st.transfers.reduce((a, t) => a + t.amount, 0), 6666, '用例2 转账总额=6666')

  // ===== 用例 3：部分参与（非全员分摊） =====
  seed(['甲', '乙', '丙', '丁'], [
    rec(0, [0, 1], 6000, 'ticket', '2026-10-03'),   // 甲付 60，只甲乙参与
    rec(3, [2, 3], 4000, 'food', '2026-10-03')      // 丁付 40，只丙丁参与
  ])
  s = await statsFn({})
  eq(s.balances[0].balance, 6000 - 3000, '用例3 甲应收 3000')
  eq(s.balances[1].balance, -3000, '用例3 乙欠 3000')
  eq(s.balances[2].balance, -2000, '用例3 丙欠 2000')
  eq(s.balances[3].balance, 2000, '用例3 丁应收 2000')
  st = await settleFn({})
  eq(st.transfers.length, 2, '用例3 两笔转账')
  const names = st.transfers.map(t => `${t.fromName}->${t.toName}:${t.amount}`).sort()
  eq(names.join(' | '), ['乙->甲:3000', '丙->丁:2000'].sort().join(' | '), '用例3 转账方案精确匹配')

  // ===== 用例 4：无账目 =====
  seed(['独行者'], [])
  s = await statsFn({})
  eq(s.total, 0, '用例4 总花销 0')
  eq(s.balances[0].balance, 0, '用例4 差额 0')
  st = await settleFn({})
  eq(st.transfers.length, 0, '用例4 无转账')

  // ===== 用例 5：已完全平衡，无需转账 =====
  seed(['X', 'Y'], [
    rec(0, [0, 1], 2000, 'food', '2026-10-01'),
    rec(1, [0, 1], 2000, 'food', '2026-10-02')
  ])
  st = await settleFn({})
  eq(st.transfers.length, 0, '用例5 已平衡 → 0 笔转账')

  // ===== 用例 6：鉴权 —— 未注册 openId =====
  CURRENT.openId = 'o_stranger'
  s = await statsFn({})
  eq(s.code, 'NOT_REGISTERED', '用例6 getStats 拒绝未注册')
  st = await settleFn({})
  eq(st.code, 'NOT_REGISTERED', '用例6 settle 拒绝未注册')
  let d = await dbFn({ action: 'listRecords', data: {} })
  eq(d.code, 'NOT_REGISTERED', '用例6 db 拒绝未注册')
  CURRENT.openId = 'o0'

  // ===== 用例 7：db 云函数 CRUD 全流程 =====
  seed(['小明', '小红'], [])
  // 7.1 新增：金额非整数分应被拒
  d = await dbFn({ action: 'addRecord', data: { date: '2026-10-01', category: 'food', amount: 12.5, payerId: 'm0', participantIds: ['m0', 'm1'] } })
  eq(d.code, 'INVALID_AMOUNT', '用例7 拒绝浮点金额')
  // 7.2 非法分类
  d = await dbFn({ action: 'addRecord', data: { date: '2026-10-01', category: 'xxx', amount: 100, payerId: 'm0', participantIds: ['m0'] } })
  eq(d.code, 'INVALID_CATEGORY', '用例7 拒绝非法分类')
  // 7.3 非法付款人
  d = await dbFn({ action: 'addRecord', data: { date: '2026-10-01', category: 'food', amount: 100, payerId: 'ghost', participantIds: ['m0'] } })
  eq(d.code, 'INVALID_PAYER', '用例7 拒绝非成员付款人')
  // 7.4 参与人为空
  d = await dbFn({ action: 'addRecord', data: { date: '2026-10-01', category: 'food', amount: 100, payerId: 'm0', participantIds: [] } })
  eq(d.code, 'INVALID_PARTICIPANTS', '用例7 拒绝空参与人')
  // 7.5 正常新增
  d = await dbFn({ action: 'addRecord', data: { date: '2026-10-01', category: 'food', amount: 8888, payerId: 'm0', participantIds: ['m0', 'm1'], note: '火锅' } })
  assert(d._id, '用例7 addRecord 返回 _id')
  const rid = d._id
  // 7.6 读取
  d = await dbFn({ action: 'getRecord', data: { _id: rid } })
  eq(d.record.amount, 8888, '用例7 getRecord 金额一致')
  eq(d.record.note, '火锅', '用例7 getRecord 备注一致')
  eq(d.record.createdByOpenId, 'o0', '用例7 记录创建者 openId')
  // 7.7 列表 + 分类筛选
  d = await dbFn({ action: 'listRecords', data: { category: 'food' } })
  eq(d.list.length, 1, '用例7 分类筛选命中 1 条')
  d = await dbFn({ action: 'listRecords', data: { category: 'hotel' } })
  eq(d.list.length, 0, '用例7 分类筛选无命中')
  d = await dbFn({ action: 'listRecords', data: { category: 'all' } })
  eq(d.list.length, 1, "用例7 category='all' 不过滤")
  // 7.8 更新 + 保护字段
  d = await dbFn({ action: 'updateRecord', data: { _id: rid, amount: 9999, createdByOpenId: 'hacker', createdAt: new Date(1999) } })
  eq(d.success, true, '用例7 updateRecord 成功')
  d = await dbFn({ action: 'getRecord', data: { _id: rid } })
  eq(d.record.amount, 9999, '用例7 金额已更新')
  eq(d.record.createdByOpenId, 'o0', '用例7 createdByOpenId 不可被篡改')
  // 7.9 删除
  d = await dbFn({ action: 'deleteRecord', data: { _id: rid } })
  eq(d.success, true, '用例7 deleteRecord 成功')
  d = await dbFn({ action: 'listRecords', data: {} })
  eq(d.list.length, 0, '用例7 删除后列表为空')
  // 7.10 行程 CRUD
  d = await dbFn({ action: 'addSchedule', data: { day: 1, startTime: '08:00', type: 'traffic', title: '高铁出发', location: '成都东' } })
  assert(d._id, '用例7 addSchedule 返回 _id')
  const sid = d._id
  d = await dbFn({ action: 'addSchedule', data: { day: 0, type: 'traffic', title: 'x' } })
  eq(d.code, 'INVALID_DAY', '用例7 拒绝 day<1')
  d = await dbFn({ action: 'addSchedule', data: { day: 1, type: 'nope', title: 'x' } })
  eq(d.code, 'INVALID_TYPE', '用例7 拒绝非法行程类型')
  d = await dbFn({ action: 'addSchedule', data: { day: 1, type: 'food', title: '  ' } })
  eq(d.code, 'INVALID_TITLE', '用例7 拒绝空标题')
  d = await dbFn({ action: 'listSchedule', data: {} })
  eq(d.list.length, 1, '用例7 行程列表 1 条')
  d = await dbFn({ action: 'updateSchedule', data: { _id: sid, title: '飞机出发' } })
  eq(d.success, true, '用例7 updateSchedule 成功')
  d = await dbFn({ action: 'deleteSchedule', data: { _id: sid } })
  eq(d.success, true, '用例7 deleteSchedule 成功')
  // 7.11 trip
  d = await dbFn({ action: 'getTrip', data: {} })
  eq(d.trip.name, '国庆川西行', '用例7 getTrip 返回默认旅程')
  d = await dbFn({ action: 'updateTrip', data: { name: '稻城亚丁', startDate: '2026-09-30', endDate: '2026-10-08' } })
  eq(d.success, true, '用例7 updateTrip 成功')
  d = await dbFn({ action: 'getTrip', data: {} })
  eq(d.trip.name, '稻城亚丁', '用例7 旅程名已更新')
  eq(d.trip.startDate, '2026-09-30', '用例7 出发日已更新')
  // 7.12 members
  d = await dbFn({ action: 'listMembers', data: {} })
  eq(d.list.length, 2, '用例7 成员列表 2 人')
  eq(d.list[0].name, '小明', '用例7 按 createdAt 升序')
  d = await dbFn({ action: 'updateMember', data: { name: '  ' } })
  eq(d.code, 'INVALID_NAME', '用例7 拒绝空白名字')
  d = await dbFn({ action: 'updateMember', data: { name: '明哥' } })
  eq(d.success, true, '用例7 updateMember 成功')
  // 7.13 未知 action
  d = await dbFn({ action: 'dropDatabase', data: {} })
  eq(d.code, 'UNKNOWN_ACTION', '用例7 拒绝未知 action')
  CURRENT.openId = 'o1'
  d = await dbFn({ action: 'updateTrip', data: { name: '成员不应修改' } })
  eq(d.code, 'CREATOR_REQUIRED', '用例7 普通成员不能修改旅程设置')
  d = await dbFn({ action: 'createInvite', data: { tripId: 't1' } })
  eq(d.code, 'CREATOR_REQUIRED', '用例7 普通成员不能创建邀请')
  CURRENT.openId = 'o0'
  d = await dbMain({ action: 'listRecords', data: { tripId: 'other-trip' } })
  eq(d.code, 'NOT_TRIP_MEMBER', '用例7 非成员不能读取其他旅程')

  // ===== 用例 8：login 云函数 —— 查询 / 注册 / 幂等 =====
  CURRENT.collections = { members: [], records: [], schedule: [], trips: [] }
  CURRENT.openId = 'o_new'
  let l = await loginFn({})
  eq(l.member, null, '用例8 新用户 member=null（前端应跳起名页）')
  eq(l.trips.length, 0, '用例8 新用户没有已加入旅程')
  eq(l.openId, 'o_new', '用例8 返回 openId')
  l = await loginFn({ name: '小明' })
  eq(l.member.name, '小明', '用例8 注册成功返回 member')
  eq(l.member.openId, 'o_new', '用例8 member 绑定 openId')
  eq(l.trips.length, 0, '用例8 注册不会自动创建默认旅程')
  const createdTrip = await dbFn({ action: 'createTrip', data: { name: '周末旅行', startDate: '2026-10-01', endDate: '2026-10-02' } })
  const firstTripId = createdTrip.trip._id
  // 再登录（已注册，不带 name）
  l = await loginFn({})
  assert(l.member, '用例8 二次登录自动返回 member')
  eq(l.member.name, '小明', '用例8 二次登录返回同一 member')
  eq(l.trips[0]._id, firstTripId, '用例8 登录返回已加入旅程')
  // 第二个人注册 → 尚未加入创建人的旅程
  CURRENT.openId = 'o_friend'
  l = await loginFn({ name: '小红' })
  eq(l.trips.length, 0, '用例8 新成员不会自动加入其他旅程')
  CURRENT.openId = 'o_new'
  const invite = await dbFn({ action: 'createInvite', data: { tripId: firstTripId } })
  CURRENT.openId = 'o_friend'
  const joined = await dbFn({ action: 'joinTrip', data: { token: invite.token } })
  eq(joined.success, true, '用例8 邀请加入旅程')
  const secondJoin = await dbFn({ action: 'joinTrip', data: { token: invite.token } })
  eq(secondJoin.alreadyMember, true, '用例8 已是成员重复进入保持成功')
  CURRENT.openId = 'o_new2'
  await loginFn({ name: '小周' })
  const usedInvite = await dbFn({ action: 'joinTrip', data: { token: invite.token } })
  eq(usedInvite.code, 'INVITE_USED', '用例8 邀请只允许一位新成员使用')
  CURRENT.openId = 'o_new'
  eq(CURRENT.collections.members.length, 3, '用例8 注册成员数=3')
  eq(CURRENT.collections.trips.length, 1, '用例8 旅程数仍为 1')
  // 空白名字注册 → 不应创建 member
  const before = CURRENT.collections.members.length
  CURRENT.openId = 'o_x'
  l = await loginFn({ name: '   ' })
  eq(l.member, null, '用例8 空白名字不创建 member')
  eq(CURRENT.collections.members.length, before, '用例8 空白名字未污染 members 集合')
  // 超长名字被截断到 20 字
  CURRENT.openId = 'o_long'
  l = await loginFn({ name: '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十' })
  eq(l.member.name.length, 20, '用例8 名字截断到 20 字')

  // ===== 用例 8b：旧旅程数据迁移可重复执行且保留已有数据 =====
  CURRENT = {
    collections: {
      members: [{ _id: 'old-member', openId: 'o_old', name: '旧成员', createdAt: new Date() }],
      trips: [{ _id: 'legacy', name: '贵州广西游', startDate: '2026-10-01', endDate: '2026-10-07' }],
      records: [{ _id: 'old-record', amount: 1200, note: '已存在账目' }],
      schedule: [{ _id: 'old-schedule', title: '已存在行程' }]
    },
    openId: 'o_migrator'
  }
  l = await loginFn({ name: '旅程创建人' })
  const migratedTripId = l.trips[0]._id
  eq(migratedTripId, 'legacy', '用例8b 沿用现有旅程 ID')
  eq(CURRENT.collections.records[0].tripId, 'legacy', '用例8b 旧账目关联到现有旅程')
  eq(CURRENT.collections.records[0].note, '已存在账目', '用例8b 旧账目内容保留')
  eq(CURRENT.collections.schedule[0].tripId, 'legacy', '用例8b 旧行程项关联到现有旅程')
  eq(CURRENT.collections.tripMembers.length, 2, '用例8b 创建人和旧成员都保留为旅程成员')
  eq(CURRENT.collections.tripMembers.find(m => m.memberId === 'old-member').role, 'member', '用例8b 旧成员保留普通成员身份')
  await loginFn({})
  eq(CURRENT.collections.tripMembers.length, 2, '用例8b 重复登录不产生重复成员关系')
  eq(CURRENT.collections.records.length, 1, '用例8b 重复迁移不复制旧账目')

  // ===== 用例 9：随机化不变量 —— AA 算法在任意场景下均平衡 =====
  let rndChecked = 0
  for (let t = 0; t < 200; t++) {
    const n = 2 + Math.floor(Math.random() * 6)               // 2~7 人
    const names = Array.from({ length: n }, (_, i) => 'P' + i)
    const recs = []
    const m = Math.floor(Math.random() * 8)                    // 0~7 笔账
    for (let k = 0; k < m; k++) {
      const payer = Math.floor(Math.random() * n)
      const size = 1 + Math.floor(Math.random() * n)
      const pool = names.map((_, i) => i).sort(() => Math.random() - 0.5).slice(0, size)
      recs.push(rec(payer, pool, 1 + Math.floor(Math.random() * 50000), 'food', '2026-10-01'))
    }
    seed(names, recs)
    const rs = await statsFn({})
    const rt = await settleFn({})
    if (rs.error || rt.error) { fails.push(`用例9 第${t}轮云函数报错`); fail++; continue }

    // 不变量 A：已付合计 = 应付合计 = 总花销（分账不丢分、不多分）
    const sumPaid = rs.balances.reduce((a, b) => a + b.paid, 0)
    const sumOwed = rs.balances.reduce((a, b) => a + b.owed, 0)
    assert(sumPaid === rs.total && sumOwed === rs.total, `用例9 第${t}轮 已付/应付合计≠总花销 (${sumPaid}/${sumOwed}/${rs.total})`)
    // 不变量 B：差额总和 = 0
    assert(rs.balances.reduce((a, b) => a + b.balance, 0) === 0, `用例9 第${t}轮 差额总和≠0`)
    // 不变量 C：settle 的转账恰好清零每个人的差额
    const net = {}
    rs.balances.forEach(b => { net[b.memberId] = b.balance })
    rt.transfers.forEach(x => { net[x.fromId] += x.amount; net[x.toId] -= x.amount })
    Object.keys(net).forEach(id => {
      assert(net[id] === 0, `用例9 第${t}轮 转账后 ${id} 余额未归零（${net[id]}）`)
    })
    // 不变量 D：无 0 元转账、无自转、fromId/toId 均为真实成员
    const ids = new Set(rs.balances.map(b => b.memberId))
    rt.transfers.forEach(x => {
      assert(x.amount > 0, `用例9 第${t}轮 存在 0 元转账`)
      assert(x.fromId !== x.toId, `用例9 第${t}轮 存在自己转自己`)
      assert(ids.has(x.fromId) && ids.has(x.toId), `用例9 第${t}轮 转账人不在成员列表`)
    })
    // 不变量 E：转账次数符合贪心算法的理论上界 T ≤ C + D - 1 ≤ n - 1
    const nCred = rs.balances.filter(b => b.balance > 0).length
    const nDebt = rs.balances.filter(b => b.balance < 0).length
    const upperBound = (nCred > 0 && nDebt > 0) ? (nCred + nDebt - 1) : 0
    assert(rt.transfers.length <= upperBound, `用例9 第${t}轮 转账次数 ${rt.transfers.length} 超过贪心上界 C+D-1=${upperBound}`)
    assert(rt.transfers.length <= n - 1, `用例9 第${t}轮 转账次数 ${rt.transfers.length} 超过 n-1=${n - 1}`)
    rndChecked++
  }
  ok.push(`用例9 随机化不变量：${rndChecked} 轮全部通过`)

  // ===== 用例 10：方案文档里的示例 —— “小红 → 小明 ¥150 / 小美 → 小刚 ¥50” =====
  seed(['小明', '小红', '小美', '小刚'], [
    rec(0, [0, 1], 30000, 'hotel', '2026-10-01'),  // 小明付 300，小明/小红 分摊 → 小红欠小明 150
    rec(3, [2, 3], 10000, 'food', '2026-10-02')    // 小刚付 100，小美/小刚 分摊 → 小美欠小刚 50
  ])
  st = await settleFn({})
  eq(st.transfers.length, 2, '用例10 两笔转账')
  const plan10 = st.transfers.map(t => `${t.fromName} → ${t.toName} ¥${(t.amount / 100).toFixed(2)}`).sort()
  eq(plan10.join(' / '), ['小红 → 小明 ¥150.00', '小美 → 小刚 ¥50.00'].sort().join(' / '), '用例10 转账方案与文档示例一致')

  // ===== 用例 11：utils/format 与 utils/constants =====
  const fmt = require(path.join(__dirname, 'miniprogram/utils/format.js'))
  const cst = require(path.join(__dirname, 'miniprogram/utils/constants.js'))

  // 11.1 金额：元 → 分，经典浮点陷阱
  eq(fmt.yuanToFen('0.1') + fmt.yuanToFen('0.2'), 30, '用例11 0.1+0.2 元 = 30 分（无浮点误差）')
  eq(fmt.yuanToFen('19.99'), 1999, '用例11 19.99 元 = 1999 分')
  eq(fmt.yuanToFen('0.07'), 7, '用例11 0.07 元 = 7 分')
  eq(fmt.yuanToFen(1.005), 101, '用例11 1.005 元四舍五入到分')
  eq(fmt.yuanToFen(''), 0, '用例11 空字符串 = 0 分')
  eq(fmt.yuanToFen('abc'), 0, '用例11 非数字 = 0 分')
  eq(fmt.yuanToFen('12.'), 1200, '用例11 "12." = 1200 分')
  // 四舍五入与边界（input type="digit" 允许用户输入任意小数位）
  eq(fmt.yuanToFen('1.004'), 100, '用例11 1.004 → 100 分（向下）')
  eq(fmt.yuanToFen('1.006'), 101, '用例11 1.006 → 101 分（向上）')
  eq(fmt.yuanToFen('2.675'), 268, '用例11 2.675 → 268 分（经典浮点陷阱，必须进位）')
  eq(fmt.yuanToFen('.5'), 50, '用例11 ".5" = 50 分')
  eq(fmt.yuanToFen('0.001'), 0, '用例11 不足半分 → 0')
  eq(fmt.yuanToFen('0.009'), 1, '用例11 0.009 → 1 分')
  eq(fmt.yuanToFen('-19.99'), -1999, '用例11 负数保留符号')
  eq(fmt.yuanToFen('1234567.89'), 123456789, '用例11 大金额不丢精度')
  eq(fmt.yuanToFen('  88.80  '), 8880, '用例11 自动 trim 空格')
  eq(fmt.yuanToFen('1e3'), 100000, '用例11 科学计数法退回 parseFloat 分支')
  eq(fmt.yuanToFen(0), 0, '用例11 数字 0')
  eq(fmt.yuanToFen(null), 0, '用例11 null = 0')
  eq(fmt.yuanToFen(undefined), 0, '用例11 undefined = 0')
  // 11.2 分 → 元，永远两位小数
  eq(fmt.fenToYuan(1), '0.01', '用例11 1 分 = 0.01')
  eq(fmt.fenToYuan(100), '1.00', '用例11 100 分 = 1.00')
  eq(fmt.fenToYuan(1999), '19.99', '用例11 1999 分 = 19.99')
  eq(fmt.fenToYuan(0), '0.00', '用例11 0 分 = 0.00')
  eq(fmt.fenToYuan(null), '0.00', '用例11 null 降级为 0.00')
  eq(fmt.fenToYuan(undefined), '0.00', '用例11 undefined 降级为 0.00')
  eq(fmt.formatMoney(123456), '¥1234.56', '用例11 formatMoney 带 ¥ 号')
  // 11.3 分↔元 全量往返（这是“金额展示无浮点误差”的核心保证）
  let roundTripBad = 0
  for (let fen = 0; fen <= 200000; fen += 7) {
    if (fmt.yuanToFen(fmt.fenToYuan(fen)) !== fen) roundTripBad++
  }
  eq(roundTripBad, 0, '用例11 分→元→分 全量往返无损')
  // 11.4 日期格式化
  eq(fmt.formatDate(new Date(2026, 9, 1), 'YYYY-MM-DD'), '2026-10-01', '用例11 formatDate 补零')
  eq(fmt.formatDate(new Date(2026, 0, 5), 'MM-DD'), '01-05', '用例11 formatDate MM-DD')
  eq(fmt.formatDate(new Date(2026, 9, 1, 9, 5), 'HH:mm'), '09:05', '用例11 formatDate HH:mm')
  eq(typeof fmt.today(), 'string', '用例11 today() 返回字符串')
  assert(/^\d{4}-\d{2}-\d{2}$/.test(fmt.today()), '用例11 today() 格式为 YYYY-MM-DD')
  // 11.5 天数差（倒计时 / day 换算的基础）
  eq(fmt.daysBetween('2026-10-01', '2026-10-07'), 6, '用例11 10-01 → 10-07 相差 6 天')
  eq(fmt.daysBetween('2026-10-01', '2026-10-01'), 0, '用例11 同一天相差 0')
  eq(fmt.daysBetween('2026-10-07', '2026-10-01'), -6, '用例11 反向为负')
  eq(fmt.daysBetween('2026-09-30', '2026-10-01'), 1, '用例11 跳月边界')
  eq(fmt.daysBetween('2026-12-31', '2027-01-01'), 1, '用例11 跳年边界')
  eq(fmt.daysBetween('2028-02-28', '2028-03-01'), 2, '用例11 闰年 2 月 29 天')
  eq(fmt.daysBetween('2026-02-28', '2026-03-01'), 1, '用例11 平年 2 月 28 天')
  // 11.6 星期
  eq(fmt.weekday('2026-10-01'), '周四', '用例11 2026-10-01 是周四')
  eq(fmt.weekday('2026-10-07'), '周三', '用例11 2026-10-07 是周三')
  // 11.7 相对日期
  const dayOffset = (offset) => {
    const t = new Date(); t.setHours(0, 0, 0, 0); t.setDate(t.getDate() + offset)
    return fmt.formatDate(t)
  }
  eq(fmt.relativeDay(dayOffset(0)), '今天', '用例11 relativeDay 今天')
  eq(fmt.relativeDay(dayOffset(1)), '明天', '用例11 relativeDay 明天')
  eq(fmt.relativeDay(dayOffset(-1)), '昨天', '用例11 relativeDay 昨天')
  eq(fmt.relativeDay(dayOffset(5)), fmt.formatDate(fmt.parseDate(dayOffset(5)), 'MM-DD'), '用例11 relativeDay 其他日期回落 MM-DD')
  // 11.8 常量：前端分类与 db 云函数白名单必须一致
  const dbSrc2 = require('fs').readFileSync(path.join(__dirname, 'cloudfunctions/db/index.js'), 'utf8')
  const feCats = cst.CATEGORIES.map(c => c.key).join("', '")
  assert(dbSrc2.includes(`['${feCats}']`), `用例11 constants.CATEGORIES 与 db 云函数白名单不一致: ${feCats}`)
  const feTypes = cst.SCHEDULE_TYPES.map(t => t.key).join("', '")
  assert(dbSrc2.includes(`['${feTypes}']`), `用例11 constants.SCHEDULE_TYPES 与 db 云函数白名单不一致: ${feTypes}`)
  eq(cst.CATEGORIES.length, 5, '用例11 账目分类 5 个（当前产品分类）')
  // 11.9 getCategory / getScheduleType 容错
  eq(cst.getCategory('food').name, '餐饮', '用例11 getCategory 命中')
  eq(cst.getCategory('nope').key, 'other', '用例11 getCategory 未知 key 降级为 other')
  eq(cst.getScheduleType('scenic').name, '景点', '用例11 getScheduleType 命中')
  eq(cst.getScheduleType('nope').key, 'other', '用例11 getScheduleType 未知 key 降级')
  // 11.10 默认旅程与方案一致
  eq(cst.DEFAULT_TRIP, undefined, '用例11 不再提供写死的默认旅程')
  ok.push('用例11 utils/format + utils/constants 全部通过')

  // ===== 用例 12：record-edit 的 day 推算逻辑（行程页每日花费依赖它） =====
  // 与 pages/record-edit/index.js 的 computeDay 等价实现
  const trip12 = { startDate: '2026-10-01', endDate: '2026-10-07' }
  const computeDay = (dateStr) => {
    if (!trip12.startDate || !trip12.endDate || !dateStr) return null
    const day = fmt.daysBetween(trip12.startDate, dateStr) + 1
    const totalDays = fmt.daysBetween(trip12.startDate, trip12.endDate) + 1
    if (day < 1 || day > totalDays) return null
    return day
  }
  eq(computeDay('2026-10-01'), 1, '用例12 出发日 = Day 1')
  eq(computeDay('2026-10-04'), 4, '用例12 10-04 = Day 4')
  eq(computeDay('2026-10-07'), 7, '用例12 返回日 = Day 7')
  eq(computeDay('2026-09-30'), null, '用例12 旅程前的账目 day=null')
  eq(computeDay('2026-10-08'), null, '用例12 旅程后的账目 day=null')
  eq(computeDay(''), null, '用例12 空日期 day=null')

  // 带 day 的账目能被行程页按天汇总（复现 trip 页 groupByDay 的过滤条件）
  seed(['小明', '小红'], [
    rec(0, [0, 1], 5000, 'food', '2026-10-01'),
    rec(1, [0, 1], 7000, 'traffic', '2026-10-01'),
    rec(0, [0, 1], 3000, 'ticket', '2026-10-03')
  ])
  CURRENT.collections.records[0].day = computeDay('2026-10-01')
  CURRENT.collections.records[1].day = computeDay('2026-10-01')
  CURRENT.collections.records[2].day = computeDay('2026-10-03')
  const allRecs = CURRENT.collections.records
  const day1Cost = allRecs.filter(r => r.day === 1).reduce((a, b) => a + b.amount, 0)
  const day3Cost = allRecs.filter(r => r.day === 3).reduce((a, b) => a + b.amount, 0)
  eq(day1Cost, 12000, '用例12 Day 1 花费汇总 = 12000 分')
  eq(day3Cost, 3000, '用例12 Day 3 花费汇总 = 3000 分')
  eq(allRecs.filter(r => r.day === 2).length, 0, '用例12 Day 2 无账目')
  ok.push('用例12 records.day 推算 + 行程页按天汇总 全部通过')

  // ===== 汇总 =====
  console.log('')
  ok.forEach(o => console.log('  ✓ ' + o))
  if (fail === 0) {
    console.log(`==== 单测全部通过：${pass} 条断言 / 0 失败 ====`)
  } else {
    console.log(`==== 单测 ${fail} 条失败（通过 ${pass}）====`)
    fails.forEach(f => console.log('  ✗ ' + f))
    process.exitCode = 1
  }
})().catch(e => { console.error('测试异常', e); process.exitCode = 1 })
