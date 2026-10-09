// cloudfunctions/settle/index.js
// AA 结算：贪心算法计算最少转账方案
//
// 入参：无
// 出参：{ transfers: [{ fromId, fromName, toId, toName, amount }] }
//
// 算法：
//   1. 对每个 member 算 balance = 已付 - 应付
//   2. 分成 creditors（balance>0，应收）和 debtors（balance<0，应付）
//   3. 贪心：每次取最大 creditor 和最大 debtor，转账 min(|c|, |d|)
//   4. 直到所有 balance 归零
// 复杂度 O(n log n)

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
    const [recordsRes, membersRes] = await Promise.all([
      db.collection('records').limit(1000).get(),
      db.collection('members').limit(100).get()
    ])

    const records = recordsRes.data
    const members = membersRes.data

    // 计算每人 balance
    const balanceMap = {}
    members.forEach(m => {
      balanceMap[m._id] = { name: m.name, balance: 0 }
    })

    records.forEach(r => {
      const amount = r.amount || 0
      const participants = r.participantIds || []

      // 付款人 +amount
      if (balanceMap[r.payerId]) {
        balanceMap[r.payerId].balance += amount
      }

      // 参与人 -amount/n（余数分给前几个人）
      if (participants.length > 0) {
        const share = Math.floor(amount / participants.length)
        const remainder = amount - share * participants.length
        participants.forEach((pid, idx) => {
          if (balanceMap[pid]) {
            balanceMap[pid].balance -= share + (idx < remainder ? 1 : 0)
          }
        })
      }
    })

    // 分成 creditors 和 debtors
    const creditors = []
    const debtors = []

    Object.keys(balanceMap).forEach(memberId => {
      const { name, balance } = balanceMap[memberId]
      if (balance > 0) {
        creditors.push({ memberId, name, amount: balance })
      } else if (balance < 0) {
        debtors.push({ memberId, name, amount: -balance })
      }
    })

    // 按金额从大到小排序
    creditors.sort((a, b) => b.amount - a.amount)
    debtors.sort((a, b) => b.amount - a.amount)

    // 贪心匹配
    const transfers = []
    let i = 0
    let j = 0

    while (i < creditors.length && j < debtors.length) {
      const creditor = creditors[i]
      const debtor = debtors[j]
      const transferAmount = Math.min(creditor.amount, debtor.amount)

      if (transferAmount > 0) {
        transfers.push({
          fromId: debtor.memberId,
          fromName: debtor.name,
          toId: creditor.memberId,
          toName: creditor.name,
          amount: transferAmount
        })
      }

      creditor.amount -= transferAmount
      debtor.amount -= transferAmount

      if (creditor.amount === 0) i++
      if (debtor.amount === 0) j++
    }

    return { transfers }
  } catch (e) {
    console.error('[settle] 失败', e)
    return { error: e.message || '结算失败', code: 'INTERNAL_ERROR' }
  }
}
