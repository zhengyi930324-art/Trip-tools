// 登录、注册以及首次多行程数据迁移
const crypto = require('crypto')
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

async function ensureCollections() {
  for (const name of ['trips', 'members', 'schedule', 'records', 'tripMembers', 'tripInvites']) {
    try {
      await db.createCollection(name)
    } catch (e) {
      if (e.errCode !== -501001 && e.code !== 'DATABASE_COLLECTION_ALREADY_EXIST') {
        console.warn(`[login] createCollection(${name}) 失败`, e.errCode || e.code)
      }
    }
  }
}

function membershipId(tripId, memberId) {
  return crypto.createHash('md5').update(`${tripId}:${memberId}`).digest('hex')
}

async function ensureMembership(tripId, memberId, role) {
  const id = membershipId(tripId, memberId)
  const ref = db.collection('tripMembers').doc(id)
  const current = await db.collection('tripMembers').where({ tripId, memberId }).limit(1).get()
  if (!current.data[0]) await ref.set({ data: { tripId, memberId, role, createdAt: db.serverDate() } })
}

async function migrateLegacyData(member) {
  const tripsRes = await db.collection('trips').limit(1).get()
  const trip = tripsRes.data[0]
  if (!trip || trip.multiTripReady) return

  const trips = db.collection('trips')
  if (!trip.createdByMemberId) {
    await trips.where({ _id: trip._id, createdByMemberId: _.exists(false) }).update({ data: {
      createdByMemberId: member._id, createdByOpenId: member.openId
    } })
  }
  const currentTrip = await trips.where({ _id: trip._id }).limit(1).get()
  const creatorId = currentTrip.data[0].createdByMemberId
  const membersRes = await db.collection('members').limit(100).get()
  for (const existingMember of membersRes.data) {
    await ensureMembership(trip._id, existingMember._id, existingMember._id === creatorId ? 'creator' : 'member')
  }

  for (const collectionName of ['records', 'schedule']) {
    const collection = db.collection(collectionName)
    let skip = 0
    while (true) {
      const page = await collection.skip(skip).limit(100).get()
      for (const row of page.data) {
        if (!row.tripId) {
          await collection.doc(row._id).update({ data: { tripId: trip._id } })
        }
      }
      if (page.data.length < 100) break
      skip += page.data.length
    }
  }

  await trips.doc(trip._id).update({ data: { multiTripReady: true } })
}

async function listMemberTrips(memberId) {
  const memberships = await db.collection('tripMembers').where({ memberId }).limit(100).get()
  const trips = []
  for (const relation of memberships.data) {
    const result = await db.collection('trips').where({ _id: relation.tripId }).limit(1).get()
    if (result.data[0]) trips.push({ ...result.data[0], role: relation.role })
  }
  return trips.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
}

exports.main = async (event = {}) => {
  const { OPENID: openId } = cloud.getWXContext()
  if (!openId) return { error: '无法获取 openId', openId: null, member: null, trips: [] }

  await ensureCollections()
  const members = db.collection('members')
  const result = await members.where({ openId }).limit(1).get()
  let member = result.data[0] || null

  if (!member && event.name && String(event.name).trim()) {
    const data = {
      openId,
      name: String(event.name).trim().slice(0, 20),
      avatarFileID: String(event.avatarFileID || '').slice(0, 200),
      createdAt: db.serverDate()
    }
    const added = await members.add({ data })
    member = { _id: added._id, ...data }
  }

  if (!member) return { openId, member: null, trips: [] }

  await migrateLegacyData(member)
  const trips = await listMemberTrips(member._id)
  return { openId, member, trips }
}
