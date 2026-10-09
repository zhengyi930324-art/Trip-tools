// cloudfunctions/getStats/index.js
// 统计聚合：总花销、分类占比、每人已付/应付/差额
//
// 入参：无
// 出参：{
//   total, count, memberCount,
//   byCategory: { traffic: 1234, ... },
//   balances: [{ memberId, name, paid, owed, balance }]
// }

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID

  // 鉴权
  const memberRes = await db.collection('members').where({ openId }).limit(1).get()
  if (!memberRes.data[0]) {
    return { error: '未注册', code: 'NOT_REGISTERED' }
  }

  try {
    // 拉取所有 records 和 members
    const [recordsRes, membersRes] = await Promise.all([
      db.collection('records').limit(1000).get(),
      db.collection('members').orderBy('createdAt', 'asc').limit(100).get()
    ])

    const records = recordsRes.data
    const members = membersRes.data

    // 总花销
    const total = records.reduce((sum, r) => sum + (r.amount || 0), 0)

    // 按分类汇总
    const byCategory = {}
    records.forEach(r => {
      if (!r.category) return
      byCategory[r.category] = (byCategory[r.category] || 0) + (r.amount || 0)
    })

    // 每人已付（按付款人）
    const byPayer = {}
    members.forEach(m => { byPayer[m._id] = 0 })
    records.forEach(r => {
      if (byPayer[r.payerId] !== undefined) {
        byPayer[r.payerId] += r.amount || 0
      }
    })

    // 每人应付（按参与人分摊，余数分给前几个人）
    const byParticipant = {}
    members.forEach(m => { byParticipant[m._id] = 0 })
    records.forEach(r => {
      const participants = r.participantIds || []
      if (participants.length === 0) return
      const amount = r.amount || 0
      const share = Math.floor(amount / participants.length)
      const remainder = amount - share * participants.length
      participants.forEach((pid, idx) => {
        if (byParticipant[pid] !== undefined) {
          byParticipant[pid] += share + (idx < remainder ? 1 : 0)
        }
      })
    })

    // 每人差额
    const balances = members.map(m => {
      const paid = byPayer[m._id] || 0
      const owed = byParticipant[m._id] || 0
      return {
        memberId: m._id,
        name: m.name,
        avatarFileID: m.avatarFileID || '',
        paid,
        owed,
        balance: paid - owed
      }
    })

    return {
      total,
      count: records.length,
      memberCount: members.length,
      byCategory,
      balances
    }
  } catch (e) {
    console.error('[getStats] 失败', e)
    return { error: e.message || '统计失败', code: 'INTERNAL_ERROR' }
  }
}
