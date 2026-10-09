// utils/constants.js · 全局常量

// 账目分类
const CATEGORIES = [
  { key: 'traffic',  name: '交通', color: '#4A90E2', icon: '交' },
  { key: 'hotel',    name: '住宿', color: '#9B59B6', icon: '住' },
  { key: 'food',     name: '餐饮', color: '#FF6B35', icon: '餐' },
  { key: 'ticket',   name: '门票', color: '#16A085', icon: '票' },
  { key: 'other',    name: '其他', color: '#95A5A6', icon: '其' }
]

// 行程类型
const SCHEDULE_TYPES = [
  { key: 'traffic', name: '交通', color: '#4A90E2', icon: '交' },
  { key: 'scenic',  name: '景点', color: '#16A085', icon: '景' },
  { key: 'food',    name: '餐饮', color: '#FF6B35', icon: '餐' },
  { key: 'hotel',   name: '住宿', color: '#9B59B6', icon: '住' },
  { key: 'other',   name: '其他', color: '#95A5A6', icon: '其' }
]

// 默认旅程
const DEFAULT_TRIP = {
  name: '国庆川西行',
  startDate: '2026-10-01',
  endDate: '2026-10-07'
}

// 根据 key 查分类
function getCategory(key) {
  return CATEGORIES.find(c => c.key === key) || CATEGORIES[CATEGORIES.length - 1]
}

function getScheduleType(key) {
  return SCHEDULE_TYPES.find(t => t.key === key) || SCHEDULE_TYPES[SCHEDULE_TYPES.length - 1]
}

module.exports = {
  CATEGORIES,
  SCHEDULE_TYPES,
  DEFAULT_TRIP,
  getCategory,
  getScheduleType
}
