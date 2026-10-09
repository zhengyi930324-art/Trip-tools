// cloudfunctions/login/index.js
// 登录与注册云函数
//
// 入参：
//   - 无 name：查询模式，返回当前 openId 对应的 member 和 trip
//   - 有 name：注册模式，创建 member（如不存在）并确保 trip 存在
//
// 出参：{ openId, member, trip }
//   - member 为 null 表示未注册，前端应跳转 login 页

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 确保 4 个集合存在（首次调用时创建，已存在则忽略）
async function ensureCollections() {
  const names = ['trips', 'members', 'schedule', 'records']
  for (const name of names) {
    try {
      await db.createCollection(name)
    } catch (e) {
      // -501001 表示集合已存在，忽略
      if (e.errCode !== -501001 && e.code !== 'DATABASE_COLLECTION_ALREADY_EXIST') {
        console.warn(`[login] createCollection(${name}) 失败`, e.errCode || e.code, e.errMsg || e.message)
      }
    }
  }
}

// 查或创建默认旅程
async function ensureTrip() {
  const tripsCol = db.collection('trips')
  const res = await tripsCol.limit(1).get()
  if (res.data && res.data[0]) return res.data[0]

  const now = db.serverDate()
  const newTrip = {
    name: '国庆川西行',
    startDate: '2026-10-01',
    endDate: '2026-10-07',
    createdAt: now,
    updatedAt: now
  }
  const addRes = await tripsCol.add({ data: newTrip })
  return { _id: addRes._id, ...newTrip }
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID

  if (!openId) {
    return { error: '无法获取 openId', openId: null, member: null, trip: null }
  }

  await ensureCollections()

  const membersCol = db.collection('members')
  let member = null

  // 查 member
  try {
    const memberRes = await membersCol.where({ openId }).limit(1).get()
    member = memberRes.data[0] || null
  } catch (e) {
    console.error('[login] 查 member 失败', e)
  }

  // 注册模式：提供了 name 且 member 不存在
  if (!member && event.name && String(event.name).trim()) {
    const name = String(event.name).trim().slice(0, 20)
    const now = db.serverDate()
    const newMember = {
      openId,
      name,
      avatarFileID: String(event.avatarFileID || '').slice(0, 200),
      createdAt: now
    }
    try {
      const addRes = await membersCol.add({ data: newMember })
      member = { _id: addRes._id, ...newMember }
    } catch (e) {
      console.error('[login] 创建 member 失败', e)
      return { error: '创建成员失败', openId, member: null, trip: null }
    }
  }

  // 未注册且未提供 name：直接返回
  if (!member) {
    return { openId, member: null, trip: null }
  }

  // 查/创建 trip
  let trip = null
  try {
    trip = await ensureTrip()
  } catch (e) {
    console.error('[login] ensureTrip 失败', e)
  }

  return { openId, member, trip }
}
