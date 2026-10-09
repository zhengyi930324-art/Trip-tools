// cloudfunctions/db/index.js
// 统一 CRUD 云函数
//
// 入参：{ action, data }
// 出参：{ ... } 或 { error, code }
//
// 支持的 action：
//   records  : listRecords / addRecord / updateRecord / deleteRecord / getRecord
//   schedule : listSchedule / addSchedule / updateSchedule / deleteSchedule
//   trip     : getTrip / updateTrip
//   members  : listMembers / updateMember

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 与前端 utils/constants.js 保持一致
const CATEGORIES = ['traffic', 'hotel', 'food', 'ticket', 'other']
// 已并入「其他」的遗留分类，仅过滤旧数据时兼容用
const LEGACY_OTHER_CATEGORIES = ['fun', 'shopping']

// 附件图片兼容：优先新字段 imageFileIDs 数组，缺失时回退旧单图 imageFileID
function normalizeImageIDs(ids, legacy) {
  const list = Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && id) : []
  if (list.length === 0 && legacy) list.push(legacy)
  return list.slice(0, 9)
}
const SCHEDULE_TYPES = ['traffic', 'scenic', 'food', 'hotel', 'other']

// 单个行程项的待办上限
const MAX_TODOS = 30
const MAX_TODO_TEXT = 60

// 待办清单校验：统一裁剪为 { id, text, done }，非法则返回错误
function normalizeTodos(todos) {
  if (todos === undefined || todos === null) return { ok: true, value: [] }
  if (!Array.isArray(todos)) return { ok: false, error: '待办格式无效', code: 'INVALID_TODOS' }
  if (todos.length > MAX_TODOS) {
    return { ok: false, error: `待办最多 ${MAX_TODOS} 条`, code: 'INVALID_TODOS' }
  }

  const value = []
  const seen = new Set()
  for (const raw of todos) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: '待办格式无效', code: 'INVALID_TODOS' }
    }
    const id = String(raw.id || '').trim().slice(0, 40)
    if (!id) return { ok: false, error: '待办缺少 id', code: 'INVALID_TODOS' }
    if (seen.has(id)) return { ok: false, error: '待办 id 重复', code: 'INVALID_TODOS' }
    const text = String(raw.text || '').trim()
    if (!text) return { ok: false, error: '待办内容不能为空', code: 'INVALID_TODOS' }
    seen.add(id)
    const ownerId = String(raw.ownerId || '').trim().slice(0, 40)
    const ownerName = String(raw.ownerName || '').trim().slice(0, 20)
    value.push({ id, text: text.slice(0, MAX_TODO_TEXT), done: !!raw.done, ownerId, ownerName })
  }
  return { ok: true, value }
}

exports.main = async (event, context) => {
  const { action, data = {} } = event
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID

  if (!openId) return { error: '无法获取 openId', code: 'NO_OPENID' }

  // 鉴权：必须已注册
  const memberRes = await db.collection('members').where({ openId }).limit(1).get()
  const member = memberRes.data[0]
  if (!member) return { error: '未注册', code: 'NOT_REGISTERED' }

  try {
    switch (action) {
      case 'listRecords':   return await listRecords(data, member)
      case 'addRecord':     return await addRecord(data, member)
      case 'updateRecord':  return await updateRecord(data, member)
      case 'deleteRecord':  return await deleteRecord(data, member)
      case 'getRecord':     return await getRecord(data, member)

      case 'listSchedule':  return await listSchedule(data, member)
      case 'addSchedule':   return await addSchedule(data, member)
      case 'updateSchedule':return await updateSchedule(data, member)
      case 'deleteSchedule':return await deleteSchedule(data, member)

      case 'getTrip':       return await getTrip(data, member)
      case 'updateTrip':    return await updateTrip(data, member)

      case 'listMembers':   return await listMembers(data, member)
      case 'updateMember':  return await updateMember(data, member)

      default:
        return { error: '未知操作: ' + action, code: 'UNKNOWN_ACTION' }
    }
  } catch (e) {
    console.error(`[db] ${action} 失败`, e)
    return { error: e.message || '操作失败', code: 'INTERNAL_ERROR' }
  }
}

// ============ records（账目） ============

async function listRecords(data, member) {
  const { category, startDate, endDate, limit = 200, skip = 0 } = data
  const where = {}
  // 按「其他」过滤时，带上已并入其中的遗留分类（娱乐/购物）
  if (category && category !== 'all') {
    where.category = category === 'other'
      ? _.in(['other'].concat(LEGACY_OTHER_CATEGORIES))
      : category
  }

  if (startDate && endDate) {
    where.date = _.gte(startDate).and(_.lte(endDate))
  } else if (startDate) {
    where.date = _.gte(startDate)
  } else if (endDate) {
    where.date = _.lte(endDate)
  }

  const res = await db.collection('records')
    .where(where)
    .orderBy('date', 'desc')
    .orderBy('createdAt', 'desc')
    .skip(skip)
    .limit(limit)
    .get()

  return { list: res.data }
}

async function addRecord(data, member) {
  const { date, category, amount, payerId, participantIds = [], note = '', imageFileID = '', imageFileIDs, day = null } = data
  const images = normalizeImageIDs(imageFileIDs, imageFileID)

  if (!date) return { error: '日期必填', code: 'INVALID_DATE' }
  if (!CATEGORIES.includes(category)) return { error: '分类无效', code: 'INVALID_CATEGORY' }
  if (!amount || amount <= 0 || !Number.isInteger(amount)) {
    return { error: '金额必须为正整数（分）', code: 'INVALID_AMOUNT' }
  }
  if (!payerId) return { error: '付款人必填', code: 'INVALID_PAYER' }

  // 校验成员 ID 有效性
  const allMembers = await db.collection('members').limit(100).get()
  const memberIds = allMembers.data.map(m => m._id)
  if (!memberIds.includes(payerId)) return { error: '付款人无效', code: 'INVALID_PAYER' }

  const validParticipants = participantIds.filter(id => memberIds.includes(id))
  if (validParticipants.length === 0) {
    return { error: '至少选择一个参与人', code: 'INVALID_PARTICIPANTS' }
  }

  const now = db.serverDate()
  const record = {
    date, day, category, amount,
    payerId,
    participantIds: validParticipants,
    note: String(note || '').slice(0, 200),
    imageFileID: images[0] || '',
    imageFileIDs: images,
    createdByOpenId: member.openId,
    createdAt: now,
    updatedAt: now
  }

  const res = await db.collection('records').add({ data: record })
  return { _id: res._id, record }
}

async function updateRecord(data, member) {
  const { _id, ...updates } = data
  if (!_id) return { error: '缺少 _id', code: 'INVALID_ID' }

  if (updates.category && !CATEGORIES.includes(updates.category)) {
    return { error: '分类无效', code: 'INVALID_CATEGORY' }
  }
  if (updates.amount !== undefined) {
    if (!updates.amount || updates.amount <= 0 || !Number.isInteger(updates.amount)) {
      return { error: '金额必须为正整数（分）', code: 'INVALID_AMOUNT' }
    }
  }
  if (updates.participantIds && updates.participantIds.length === 0) {
    return { error: '至少选择一个参与人', code: 'INVALID_PARTICIPANTS' }
  }

  // 移除不可改字段
  delete updates.createdByOpenId
  delete updates.createdAt
  updates.updatedAt = db.serverDate()

  await db.collection('records').doc(_id).update({ data: updates })
  return { success: true }
}

async function deleteRecord(data, member) {
  const { _id } = data
  if (!_id) return { error: '缺少 _id', code: 'INVALID_ID' }
  await db.collection('records').doc(_id).remove()
  return { success: true }
}

async function getRecord(data, member) {
  const { _id } = data
  if (!_id) return { error: '缺少 _id', code: 'INVALID_ID' }
  const res = await db.collection('records').doc(_id).get()
  return { record: res.data }
}

// ============ schedule（行程） ============

async function listSchedule(data, member) {
  const { day } = data
  const where = {}
  if (day !== undefined && day !== null) where.day = day

  const res = await db.collection('schedule')
    .where(where)
    .orderBy('day', 'asc')
    .orderBy('startTime', 'asc')
    .limit(500)
    .get()

  return { list: res.data }
}

async function addSchedule(data, member) {
  const { day, startTime = '', endTime = '', type, title, location = '', note = '', costRecordId = null, todos, imageFileID = '', imageFileIDs, latitude = null, longitude = null } = data
  const images = normalizeImageIDs(imageFileIDs, imageFileID)

  if (!day || day < 1 || !Number.isInteger(day)) return { error: 'day 无效', code: 'INVALID_DAY' }
  if (!SCHEDULE_TYPES.includes(type)) return { error: '类型无效', code: 'INVALID_TYPE' }
  if (!title || !String(title).trim()) return { error: '标题必填', code: 'INVALID_TITLE' }

  const normalized = normalizeTodos(todos)
  if (!normalized.ok) return { error: normalized.error, code: normalized.code }

  const now = db.serverDate()
  const item = {
    day,
    startTime: String(startTime || ''),
    endTime: String(endTime || ''),
    type,
    title: String(title).trim().slice(0, 50),
    location: String(location || '').slice(0, 100),
    note: String(note || '').slice(0, 200),
    costRecordId,
    imageFileID: images[0] || '',
    imageFileIDs: images,
    // 地图选点坐标（未选点为 null，不上地图）
    latitude: typeof latitude === 'number' ? latitude : null,
    longitude: typeof longitude === 'number' ? longitude : null,
    todos: normalized.value,
    createdByOpenId: member.openId,
    createdAt: now
  }

  const res = await db.collection('schedule').add({ data: item })
  return { _id: res._id, item }
}

async function updateSchedule(data, member) {
  const { _id, ...updates } = data
  if (!_id) return { error: '缺少 _id', code: 'INVALID_ID' }

  if (updates.type && !SCHEDULE_TYPES.includes(updates.type)) {
    return { error: '类型无效', code: 'INVALID_TYPE' }
  }

  if (updates.todos !== undefined) {
    const normalized = normalizeTodos(updates.todos)
    if (!normalized.ok) return { error: normalized.error, code: normalized.code }
    updates.todos = normalized.value
  }

  delete updates.createdByOpenId
  delete updates.createdAt

  await db.collection('schedule').doc(_id).update({ data: updates })
  return { success: true }
}

async function deleteSchedule(data, member) {
  const { _id } = data
  if (!_id) return { error: '缺少 _id', code: 'INVALID_ID' }
  await db.collection('schedule').doc(_id).remove()
  return { success: true }
}

// ============ trip（旅程） ============

async function getTrip(data, member) {
  const res = await db.collection('trips').limit(1).get()
  return { trip: res.data[0] || null }
}

async function updateTrip(data, member) {
  const { name, startDate, endDate } = data

  const tripsCol = db.collection('trips')
  const res = await tripsCol.limit(1).get()
  if (!res.data[0]) return { error: '旅程不存在', code: 'TRIP_NOT_FOUND' }
  const tripId = res.data[0]._id

  const updates = { updatedAt: db.serverDate() }
  if (name !== undefined) updates.name = String(name).trim().slice(0, 30)
  if (startDate !== undefined) updates.startDate = startDate
  if (endDate !== undefined) updates.endDate = endDate

  await tripsCol.doc(tripId).update({ data: updates })
  return { success: true }
}

// ============ members（成员） ============

async function listMembers(data, member) {
  const res = await db.collection('members')
    .orderBy('createdAt', 'asc')
    .limit(100)
    .get()
  return { list: res.data }
}

async function updateMember(data, member) {
  const { name, avatarFileID } = data

  const updates = {}
  if (name !== undefined) {
    const trimmed = String(name).trim().slice(0, 20)
    if (!trimmed) return { error: '名字不能为空', code: 'INVALID_NAME' }
    updates.name = trimmed
  }
  if (avatarFileID !== undefined) updates.avatarFileID = avatarFileID

  if (Object.keys(updates).length === 0) {
    return { error: '无更新内容', code: 'NO_UPDATES' }
  }

  await db.collection('members').doc(member._id).update({ data: updates })
  return { success: true, member: { ...member, ...updates } }
}
