// utils/format.js · 日期与金额格式化

// 金额：分 → 元字符串（保留 2 位小数）
function fenToYuan(fen) {
  if (fen === null || fen === undefined || isNaN(fen)) return '0.00'
  return (fen / 100).toFixed(2)
}

// 金额：元字符串 → 分（整数）
//
// 不用 Math.round(parseFloat(yuan) * 100)：
// 1.005 * 100 === 100.49999999999999，会得到 100 而不是 101。
// 这里改成对十进制字符串做移位，避开二进制浮点表示误差。
const YUAN_RE = /^(-?)(\d*)(?:\.(\d*))?$/

function yuanToFen(yuan) {
  if (yuan === null || yuan === undefined) return 0
  const s = String(yuan).trim()
  if (!s) return 0

  const n = parseFloat(s)
  if (isNaN(n)) return 0

  const m = s.match(YUAN_RE)
  if (m) {
    const sign = m[1] === '-' ? -1 : 1
    const intPart = m[2] || '0'
    // 补到 3 位小数：前 2 位是分，第 3 位用于四舍五入
    const dec = (m[3] || '').padEnd(3, '0')
    let fen = parseInt(intPart + dec.slice(0, 2), 10)
    if (parseInt(dec[2], 10) >= 5) fen += 1
    return sign * fen
  }

  // 科学计数法等非纯十进制写法，退回原算法
  return Math.round(n * 100)
}

// 金额展示：带 ¥ 符号
function formatMoney(fen) {
  return '¥' + fenToYuan(fen)
}

// 日期格式化：Date 或时间戳 → YYYY-MM-DD
function formatDate(date, fmt) {
  fmt = fmt || 'YYYY-MM-DD'
  const d = date instanceof Date ? date : new Date(date)
  if (isNaN(d.getTime())) return ''
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  return fmt
    .replace('YYYY', year)
    .replace('MM', month)
    .replace('DD', day)
    .replace('HH', hours)
    .replace('mm', minutes)
}

// 今天日期字符串 YYYY-MM-DD
function today() {
  return formatDate(new Date())
}

// 解析 YYYY-MM-DD 为 Date（本地时区 00:00）
function parseDate(str) {
  if (!str) return new Date()
  const parts = String(str).split('-').map(Number)
  if (parts.length !== 3 || parts.some(isNaN)) return new Date(str)
  return new Date(parts[0], parts[1] - 1, parts[2])
}

// 两个日期相差天数（d2 - d1）
function daysBetween(d1, d2) {
  const date1 = parseDate(d1)
  const date2 = parseDate(d2)
  const oneDay = 24 * 60 * 60 * 1000
  // 抹平时分秒，避免夏令时误差
  date1.setHours(0, 0, 0, 0)
  date2.setHours(0, 0, 0, 0)
  return Math.round((date2 - date1) / oneDay)
}

// 星期几（中文）
function weekday(date) {
  const d = date instanceof Date ? date : parseDate(date)
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return names[d.getDay()]
}

// 相对日期描述：今天 / 明天 / 昨天 / MM-DD
function relativeDay(dateStr) {
  const target = parseDate(dateStr)
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  target.setHours(0, 0, 0, 0)
  const diff = Math.round((target - now) / (24 * 60 * 60 * 1000))
  if (diff === 0) return '今天'
  if (diff === 1) return '明天'
  if (diff === -1) return '昨天'
  return formatDate(target, 'MM-DD')
}

module.exports = {
  fenToYuan,
  yuanToFen,
  formatMoney,
  formatDate,
  today,
  parseDate,
  daysBetween,
  weekday,
  relativeDay
}
