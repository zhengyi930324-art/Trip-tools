// 按行程统计总花销、分类占比、每人已付/应付/差额。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event = {}) => {
  const openId = cloud.getWXContext().OPENID
  const memberRes = await db.collection('members').where({ openId }).limit(1).get()
  const currentMember = memberRes.data[0]
  if (!currentMember) return { error: '未注册', code: 'NOT_REGISTERED' }
  const { tripId } = event
  if (!tripId) return { error: '缺少 tripId', code: 'INVALID_TRIP' }
  const access = await db.collection('tripMembers').where({ tripId, memberId: currentMember._id }).limit(1).get()
  if (!access.data[0]) return { error: '无权访问该行程', code: 'NOT_TRIP_MEMBER' }

  try {
    const [recordsRes, relationsRes] = await Promise.all([
      db.collection('records').where({ tripId }).limit(1000).get(),
      db.collection('tripMembers').where({ tripId }).limit(100).get()
    ])
    const members = []
    for (const relation of relationsRes.data) {
      const result = await db.collection('members').where({ _id: relation.memberId }).limit(1).get()
      if (result.data[0]) members.push(result.data[0])
    }
    const records = recordsRes.data
    const total = records.reduce((sum, record) => sum + (record.amount || 0), 0)
    const byCategory = {}
    records.forEach(record => {
      if (record.category) byCategory[record.category] = (byCategory[record.category] || 0) + (record.amount || 0)
    })

    const byPayer = {}
    const byParticipant = {}
    members.forEach(member => { byPayer[member._id] = 0; byParticipant[member._id] = 0 })
    records.forEach(record => {
      if (byPayer[record.payerId] !== undefined) byPayer[record.payerId] += record.amount || 0
      const participants = record.participantIds || []
      if (!participants.length) return
      const share = Math.floor((record.amount || 0) / participants.length)
      const remainder = (record.amount || 0) - share * participants.length
      participants.forEach((id, index) => {
        if (byParticipant[id] !== undefined) byParticipant[id] += share + (index < remainder ? 1 : 0)
      })
    })
    const balances = members.map(member => {
      const paid = byPayer[member._id] || 0
      const owed = byParticipant[member._id] || 0
      return {
        memberId: member._id,
        name: member.name,
        avatarFileID: member.avatarFileID || '',
        paid,
        owed,
        balance: paid - owed
      }
    })
    return { total, count: records.length, memberCount: members.length, byCategory, balances }
  } catch (e) {
    console.error('[getStats] 失败', e)
    return { error: e.message || '统计失败', code: 'INTERNAL_ERROR' }
  }
}
