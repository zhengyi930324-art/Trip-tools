// 统一 CRUD 云函数，所有行程数据均按 tripId 隔离。
const crypto = require('crypto')
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const CATEGORIES = ['traffic', 'hotel', 'food', 'ticket', 'other']
const LEGACY_OTHER_CATEGORIES = ['fun', 'shopping']
const SCHEDULE_TYPES = ['traffic', 'scenic', 'food', 'hotel', 'other']
const MAX_TODOS = 30
const MAX_TODO_TEXT = 60

function normalizeImageIDs(ids, legacy) {
  const list = Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && id) : []
  if (list.length === 0 && legacy) list.push(legacy)
  return list.slice(0, 9)
}

function normalizeTodos(todos) {
  if (todos === undefined || todos === null) return { ok: true, value: [] }
  if (!Array.isArray(todos)) return { ok: false, error: '待办格式无效', code: 'INVALID_TODOS' }
  if (todos.length > MAX_TODOS) return { ok: false, error: `待办最多 ${MAX_TODOS} 条`, code: 'INVALID_TODOS' }
  const value = []
  const seen = new Set()
  for (const raw of todos) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: '待办格式无效', code: 'INVALID_TODOS' }
    const id = String(raw.id || '').trim().slice(0, 40)
    const text = String(raw.text || '').trim()
    if (!id) return { ok: false, error: '待办缺少 id', code: 'INVALID_TODOS' }
    if (seen.has(id)) return { ok: false, error: '待办 id 重复', code: 'INVALID_TODOS' }
    if (!text) return { ok: false, error: '待办内容不能为空', code: 'INVALID_TODOS' }
    seen.add(id)
    value.push({
      id,
      text: text.slice(0, MAX_TODO_TEXT),
      done: !!raw.done,
      ownerId: String(raw.ownerId || '').trim().slice(0, 40),
      ownerName: String(raw.ownerName || '').trim().slice(0, 20)
    })
  }
  return { ok: true, value }
}

function membershipId(tripId, memberId) {
  return crypto.createHash('md5').update(`${tripId}:${memberId}`).digest('hex')
}

async function getMembership(tripId, member) {
  if (!tripId) return null
  const res = await db.collection('tripMembers').where({ tripId, memberId: member._id }).limit(1).get()
  return res.data[0] || null
}

async function requireTrip(data, member) {
  const tripId = data.tripId
  const relation = await getMembership(tripId, member)
  if (!relation) return { error: '无权访问该行程', code: 'NOT_TRIP_MEMBER' }
  const result = await db.collection('trips').where({ _id: tripId }).limit(1).get()
  if (!result.data[0]) return { error: '旅程不存在', code: 'TRIP_NOT_FOUND' }
  return { trip: result.data[0], relation }
}

async function isCreator(tripId, member) {
  const relation = await getMembership(tripId, member)
  return !!relation && relation.role === 'creator'
}

async function ensureMembership(tripId, memberId, role = 'member') {
  const id = membershipId(tripId, memberId)
  const ref = db.collection('tripMembers').doc(id)
  const result = await db.collection('tripMembers').where({ tripId, memberId }).limit(1).get()
  if (!result.data[0]) await ref.set({ data: { tripId, memberId, role, createdAt: db.serverDate() } })
}

async function listTrips(member) {
  const relations = await db.collection('tripMembers').where({ memberId: member._id }).limit(100).get()
  const result = []
  for (const relation of relations.data) {
    const trip = await db.collection('trips').where({ _id: relation.tripId }).limit(1).get()
    if (trip.data[0]) result.push({ ...trip.data[0], role: relation.role })
  }
  return { list: result }
}

async function createTrip(data, member) {
  const name = String(data.name || '').trim()
  const { startDate, endDate } = data
  if (!name) return { error: '请输入旅程名字', code: 'INVALID_NAME' }
  if (name.length > 30) return { error: '旅程名字最多 30 个字', code: 'INVALID_NAME' }
  if (!startDate || !endDate || startDate > endDate) return { error: '请选择有效的旅程日期', code: 'INVALID_DATE' }
  const now = db.serverDate()
  const added = await db.collection('trips').add({ data: {
    name, startDate, endDate,
    createdByMemberId: member._id,
    createdByOpenId: member.openId,
    multiTripReady: true,
    createdAt: now,
    updatedAt: now
  } })
  await ensureMembership(added._id, member._id, 'creator')
  return { trip: { _id: added._id, name, startDate, endDate, createdByMemberId: member._id, role: 'creator' } }
}

async function createInvite(data, member) {
  const { tripId } = data
  const access = await requireTrip(data, member)
  if (access.error) return access
  if (access.relation.role !== 'creator') return { error: '只有创建人可以邀请成员', code: 'CREATOR_REQUIRED' }
  const token = crypto.randomBytes(16).toString('hex')
  await db.collection('tripInvites').doc(token).set({ data: {
    tripId,
    createdByMemberId: member._id,
    usedByMemberId: '',
    createdAt: db.serverDate()
  } })
  return { token }
}

async function getInvite(data, member) {
  const { token } = data
  if (!token) return { error: '邀请链接无效', code: 'INVALID_INVITE' }
  const inviteRes = await db.collection('tripInvites').where({ _id: token }).limit(1).get()
  const invite = inviteRes.data[0]
  if (!invite) return { error: '邀请链接无效', code: 'INVALID_INVITE' }
  const membership = await getMembership(invite.tripId, member)
  if (invite.usedByMemberId && !membership) return { error: '邀请链接已失效', code: 'INVITE_USED' }
  const tripRes = await db.collection('trips').where({ _id: invite.tripId }).limit(1).get()
  const trip = tripRes.data[0]
  if (!trip) return { error: '旅程不存在', code: 'TRIP_NOT_FOUND' }
  const members = await db.collection('tripMembers').where({ tripId: invite.tripId }).count()
  return { invite: { token, tripId: invite.tripId }, trip, memberCount: members.total, alreadyMember: !!membership }
}

async function joinTrip(data, member) {
  const { token } = data
  if (!token) return { error: '邀请链接无效', code: 'INVALID_INVITE' }
  const ref = db.collection('tripInvites').doc(token)
  const inviteRes = await db.collection('tripInvites').where({ _id: token }).limit(1).get()
  const invite = inviteRes.data[0]
  if (!invite) return { error: '邀请链接无效', code: 'INVALID_INVITE' }
  const { tripId } = invite
  if (await getMembership(tripId, member)) return { success: true, tripId, alreadyMember: true }
  if (invite.usedByMemberId) return { error: '邀请链接已被使用', code: 'INVITE_USED' }

  const claim = await db.collection('tripInvites')
    .where({ _id: token, usedByMemberId: '' })
    .update({ data: { usedByMemberId: member._id } })
  const updated = claim.stats ? claim.stats.updated : claim.updated
  if (!updated) return { error: '邀请链接已被使用', code: 'INVITE_USED' }

  try {
    await ensureMembership(tripId, member._id)
  } catch (e) {
    await db.collection('tripInvites').where({ _id: token, usedByMemberId: member._id })
      .update({ data: { usedByMemberId: '' } })
    throw e
  }
  return { success: true, tripId, alreadyMember: false }
}

exports.main = async (event = {}) => {
  const { action, data = {} } = event
  const openId = cloud.getWXContext().OPENID
  if (!openId) return { error: '无法获取 openId', code: 'NO_OPENID' }
  const memberRes = await db.collection('members').where({ openId }).limit(1).get()
  const member = memberRes.data[0]
  if (!member) return { error: '未注册', code: 'NOT_REGISTERED' }

  try {
    switch (action) {
      case 'listTrips': return await listTrips(member)
      case 'createTrip': return await createTrip(data, member)
      case 'createInvite': return await createInvite(data, member)
      case 'getInvite': return await getInvite(data, member)
      case 'joinTrip': return await joinTrip(data, member)
      case 'updateMember': return await updateMember(data, member)
      default: {
        const access = await requireTrip(data, member)
        if (access.error) return access
        switch (action) {
          case 'listRecords': return await listRecords(data)
          case 'addRecord': return await addRecord(data, member)
          case 'updateRecord': return await updateRecord(data)
          case 'deleteRecord': return await deleteRecord(data)
          case 'getRecord': return await getRecord(data)
          case 'listSchedule': return await listSchedule(data)
          case 'addSchedule': return await addSchedule(data, member)
          case 'updateSchedule': return await updateSchedule(data)
          case 'deleteSchedule': return await deleteSchedule(data)
          case 'getTrip': return { trip: { ...access.trip, role: access.relation.role } }
          case 'updateTrip':
            if (access.relation.role !== 'creator') return { error: '只有创建人可以修改旅程', code: 'CREATOR_REQUIRED' }
            return await updateTrip(data)
          case 'listMembers': return await listMembers(data)
          case 'removeTripMember':
            if (access.relation.role !== 'creator') return { error: '只有创建人可以移除成员', code: 'CREATOR_REQUIRED' }
            return await removeTripMember(data, member)
          default: return { error: '未知操作: ' + action, code: 'UNKNOWN_ACTION' }
        }
      }
    }
  } catch (e) {
    console.error(`[db] ${action} 失败`, e)
    return { error: e.message || '操作失败', code: 'INTERNAL_ERROR' }
  }
}

async function listRecords(data) {
  const { tripId, category, startDate, endDate, limit = 200, skip = 0 } = data
  const where = { tripId }
  if (category && category !== 'all') {
    where.category = category === 'other' ? _.in(['other'].concat(LEGACY_OTHER_CATEGORIES)) : category
  }
  if (startDate && endDate) where.date = _.gte(startDate).and(_.lte(endDate))
  else if (startDate) where.date = _.gte(startDate)
  else if (endDate) where.date = _.lte(endDate)
  const res = await db.collection('records').where(where)
    .orderBy('date', 'asc').orderBy('createdAt', 'asc').skip(skip).limit(limit).get()
  return { list: res.data }
}

async function getTripMemberIds(tripId) {
  const relations = await db.collection('tripMembers').where({ tripId }).limit(100).get()
  return relations.data.map(relation => relation.memberId)
}

async function isTripMember(tripId, memberId) {
  return !!(await getMembership(tripId, { _id: memberId }))
}

async function hasTripRecord(tripId, recordId) {
  if (!recordId) return true
  const record = await db.collection('records').where({ _id: recordId, tripId }).limit(1).get()
  return !!record.data[0]
}

async function addRecord(data, member) {
  const { tripId, date, category, amount, payerId, participantIds = [], note = '', imageFileID = '', imageFileIDs, day = null } = data
  const images = normalizeImageIDs(imageFileIDs, imageFileID)
  if (!date) return { error: '日期必填', code: 'INVALID_DATE' }
  if (!CATEGORIES.includes(category)) return { error: '分类无效', code: 'INVALID_CATEGORY' }
  if (!amount || amount <= 0 || !Number.isInteger(amount)) return { error: '金额必须为正整数（分）', code: 'INVALID_AMOUNT' }
  const memberIds = await getTripMemberIds(tripId)
  if (!memberIds.includes(payerId)) return { error: '付款人无效', code: 'INVALID_PAYER' }
  const validParticipants = participantIds.filter(id => memberIds.includes(id))
  if (!validParticipants.length) return { error: '至少选择一个参与人', code: 'INVALID_PARTICIPANTS' }
  const now = db.serverDate()
  const record = {
    tripId, date, day, category, amount, payerId,
    participantIds: validParticipants,
    note: String(note || '').slice(0, 200),
    imageFileID: images[0] || '', imageFileIDs: images,
    createdByOpenId: member.openId, createdAt: now, updatedAt: now
  }
  const res = await db.collection('records').add({ data: record })
  return { _id: res._id, record }
}

async function updateRecord(data) {
  const { _id, tripId, ...updates } = data
  if (!_id) return { error: '缺少 _id', code: 'INVALID_ID' }
  if (updates.category && !CATEGORIES.includes(updates.category)) return { error: '分类无效', code: 'INVALID_CATEGORY' }
  if (updates.amount !== undefined && (!updates.amount || updates.amount <= 0 || !Number.isInteger(updates.amount))) {
    return { error: '金额必须为正整数（分）', code: 'INVALID_AMOUNT' }
  }
  if (updates.participantIds && updates.participantIds.length === 0) return { error: '至少选择一个参与人', code: 'INVALID_PARTICIPANTS' }
  if (updates.payerId && !(await isTripMember(tripId, updates.payerId))) return { error: '付款人无效', code: 'INVALID_PAYER' }
  if (updates.participantIds) {
    const memberIds = await getTripMemberIds(tripId)
    if (updates.participantIds.some(id => !memberIds.includes(id))) return { error: '参与人无效', code: 'INVALID_PARTICIPANTS' }
  }
  delete updates.createdByOpenId
  delete updates.createdAt
  delete updates.tripId
  updates.updatedAt = db.serverDate()
  const res = await db.collection('records').where({ _id, tripId }).update({ data: updates })
  if (!(res.stats ? res.stats.updated : res.updated)) return { error: '账目不存在', code: 'RECORD_NOT_FOUND' }
  return { success: true }
}

async function deleteRecord(data) {
  const { _id, tripId } = data
  if (!_id) return { error: '缺少 _id', code: 'INVALID_ID' }
  const res = await db.collection('records').where({ _id, tripId }).remove()
  if (!(res.stats ? res.stats.removed : res.deleted)) return { error: '账目不存在', code: 'RECORD_NOT_FOUND' }
  return { success: true }
}

async function getRecord(data) {
  const res = await db.collection('records').where({ _id: data._id, tripId: data.tripId }).limit(1).get()
  if (!res.data[0]) return { error: '账目不存在', code: 'RECORD_NOT_FOUND' }
  return { record: res.data[0] }
}

async function listSchedule(data) {
  const where = { tripId: data.tripId }
  if (data.day !== undefined && data.day !== null) where.day = data.day
  const res = await db.collection('schedule').where(where)
    .orderBy('day', 'asc').orderBy('startTime', 'asc').limit(500).get()
  return { list: res.data }
}

async function addSchedule(data, member) {
  const { tripId, day, startTime = '', endTime = '', type, title, location = '', note = '', costRecordId = null,
    todos, imageFileID = '', imageFileIDs, latitude = null, longitude = null } = data
  const images = normalizeImageIDs(imageFileIDs, imageFileID)
  if (!day || day < 1 || !Number.isInteger(day)) return { error: 'day 无效', code: 'INVALID_DAY' }
  if (!SCHEDULE_TYPES.includes(type)) return { error: '类型无效', code: 'INVALID_TYPE' }
  if (!title || !String(title).trim()) return { error: '标题必填', code: 'INVALID_TITLE' }
  const normalized = normalizeTodos(todos)
  if (!normalized.ok) return { error: normalized.error, code: normalized.code }
  const memberIds = await getTripMemberIds(tripId)
  if (normalized.value.some(todo => todo.ownerId && !memberIds.includes(todo.ownerId))) {
    return { error: '待办负责人无效', code: 'INVALID_TODOS' }
  }
  if (!(await hasTripRecord(tripId, costRecordId))) return { error: '关联账目无效', code: 'INVALID_RECORD' }
  const item = {
    tripId, day,
    startTime: String(startTime || ''), endTime: String(endTime || ''), type,
    title: String(title).trim().slice(0, 50),
    location: String(location || '').slice(0, 100), note: String(note || '').slice(0, 200), costRecordId,
    imageFileID: images[0] || '', imageFileIDs: images,
    latitude: typeof latitude === 'number' ? latitude : null,
    longitude: typeof longitude === 'number' ? longitude : null,
    todos: normalized.value, createdByOpenId: member.openId, createdAt: db.serverDate()
  }
  const res = await db.collection('schedule').add({ data: item })
  return { _id: res._id, item }
}

async function updateSchedule(data) {
  const { _id, tripId, ...updates } = data
  if (!_id) return { error: '缺少 _id', code: 'INVALID_ID' }
  if (updates.type && !SCHEDULE_TYPES.includes(updates.type)) return { error: '类型无效', code: 'INVALID_TYPE' }
  if (updates.todos !== undefined) {
    const normalized = normalizeTodos(updates.todos)
    if (!normalized.ok) return { error: normalized.error, code: normalized.code }
    const memberIds = await getTripMemberIds(tripId)
    if (normalized.value.some(todo => todo.ownerId && !memberIds.includes(todo.ownerId))) {
      return { error: '待办负责人无效', code: 'INVALID_TODOS' }
    }
    updates.todos = normalized.value
  }
  if (updates.costRecordId !== undefined && !(await hasTripRecord(tripId, updates.costRecordId))) {
    return { error: '关联账目无效', code: 'INVALID_RECORD' }
  }
  delete updates.createdByOpenId
  delete updates.createdAt
  delete updates.tripId
  const res = await db.collection('schedule').where({ _id, tripId }).update({ data: updates })
  if (!(res.stats ? res.stats.updated : res.updated)) return { error: '行程项不存在', code: 'SCHEDULE_NOT_FOUND' }
  return { success: true }
}

async function deleteSchedule(data) {
  const res = await db.collection('schedule').where({ _id: data._id, tripId: data.tripId }).remove()
  if (!(res.stats ? res.stats.removed : res.deleted)) return { error: '行程项不存在', code: 'SCHEDULE_NOT_FOUND' }
  return { success: true }
}

async function updateTrip(data) {
  const { tripId, name, startDate, endDate } = data
  const updates = { updatedAt: db.serverDate() }
  if (name !== undefined) updates.name = String(name).trim().slice(0, 30)
  if (startDate !== undefined) updates.startDate = startDate
  if (endDate !== undefined) updates.endDate = endDate
  await db.collection('trips').doc(tripId).update({ data: updates })
  return { success: true }
}

async function listMembers(data) {
  const relations = await db.collection('tripMembers').where({ tripId: data.tripId }).limit(100).get()
  const list = []
  for (const relation of relations.data) {
    const member = await db.collection('members').where({ _id: relation.memberId }).limit(1).get()
    if (member.data[0]) list.push({ ...member.data[0], role: relation.role })
  }
  return { list }
}

async function removeTripMember(data, member) {
  const { tripId, memberId } = data
  if (!memberId) return { error: '缺少成员信息', code: 'INVALID_MEMBER' }
  if (memberId === member._id) return { error: '不能移除创建人自己', code: 'INVALID_MEMBER' }
  const relation = await getMembership(tripId, { _id: memberId })
  if (!relation || relation.role === 'creator') return { error: '成员不存在', code: 'MEMBER_NOT_FOUND' }
  await db.collection('tripMembers').where({ tripId, memberId }).remove()
  return { success: true }
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
  if (!Object.keys(updates).length) return { error: '无更新内容', code: 'NO_UPDATES' }
  await db.collection('members').doc(member._id).update({ data: updates })
  return { success: true, member: { ...member, ...updates } }
}
