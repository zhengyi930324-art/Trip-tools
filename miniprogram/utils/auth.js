// utils/auth.js · 登录态检查

/**
 * 等待 app.js 的 login 完成，并确保已注册。
 * 未注册时自动跳转 login 页，返回 null；已注册返回 globalData。
 *
 * 用法：
 *   const data = await ensureLogin()
 *   if (!data) return
 *   // 正常加载页面
 */
async function ensureLogin() {
  const app = getApp()
  if (app.globalData.loginReady) {
    try {
      await app.globalData.loginReady
    } catch (e) {
      console.error('[auth] loginReady 失败', e)
    }
  }

  if (!app.globalData.currentMember) {
    // 避免在 login 页自己又触发跳转
    const pages = getCurrentPages()
    const current = pages[pages.length - 1]
    const route = current && current.route
    if (route !== 'pages/login/index') {
      wx.reLaunch({ url: '/pages/login/index' })
    }
    return null
  }

  return app.globalData
}

/**
 * 获取当前成员 ID
 */
function getMemberId() {
  const app = getApp()
  return app.globalData.currentMember && app.globalData.currentMember._id
}

/**
 * 获取当前旅程 ID
 */
function getTripId() {
  const app = getApp()
  return app.globalData.currentTrip && app.globalData.currentTrip._id
}

module.exports = {
  ensureLogin,
  getMemberId,
  getTripId
}
