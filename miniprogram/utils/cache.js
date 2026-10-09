// utils/cache.js · 页面数据本地缓存
// 用途：进 Tab 先把上次的渲染结果铺出来，云端数据后台静默刷新，
// 避免每次切 Tab 都白屏等云函数（冷启动时尤其慢）。
const PREFIX = 'pageCache:'

function read(key) {
  try {
    return wx.getStorageSync(PREFIX + key) || null
  } catch (e) {
    return null
  }
}

function write(key, payload) {
  try {
    wx.setStorageSync(PREFIX + key, payload)
  } catch (e) {
    // 写失败（如存储满）忽略，下次不用缓存即可
  }
}

module.exports = { read, write }
