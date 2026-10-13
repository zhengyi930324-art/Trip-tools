# AI 接入说明（Agent Handoff）

> 给接管/协作开发本项目的 AI（GPT、Claude 等）快速上手用。人类owner的产品口味和红线也在本文里，改代码前必读。

## 1. 项目一句话

微信小程序「出去撒欢」：朋友结伴旅行的共同记录工具——每日行程时间轴、多人记账、全员可见明细、分类统计、每人收支差额、待办/备忘/附件、导出长图。微信原生小程序（WXML/WXSS/JS）+ 微信云开发 CloudBase（云函数/云数据库/云存储），**无任何 npm 依赖、无构建步骤**。

## 2. 关键标识

| 项 | 值 |
|---|---|
| AppID | `wx40d71c41c744853b` |
| 云环境 ID | `cloud1-d2gttkgdgd065942b`（`miniprogram/app.js` 的 `wx.cloud.init`） |
| 仓库 | `https://github.com/zhengyi930324-art/Trip-tools.git`，分支 `main` |
| 基线 tag | `v1.0`（国庆川西行版全功能封存；新功能在 main 上继续） |
| 项目根 | 本目录；`miniprogramRoot=miniprogram/`、`cloudfunctionRoot=cloudfunctions/` |

AppID/环境 ID 是项目标识（小程序包内本来就内嵌），非密钥；仓库内**没有任何密钥/令牌**。

## 3. 目录结构

```
├── miniprogram/
│   ├── app.js / app.json / app.wxss     启动登录、页面路由、TabBar、全局样式
│   ├── utils/  auth.js(ensureLogin) format.js(日期/分元) constants.js(分类/行程类型) cache.js(页面缓存)
│   ├── assets/  路线地图 jpg + tabBar png
│   └── pages/
│       ├── trip/          Tab1 行程时间轴（待办直勾、准备进度卡、附件预览眼睛按钮、左滑删除）
│       ├── ledger/        Tab2 账单流水（分类筛选 chips）
│       ├── stats/         Tab3 统计（饼图 canvas 2d、每人收支可展开明细、导出长图）
│       ├── mine/          Tab4 我的（头像 chooseAvatar 换头像、旅程设置入口）
│       ├── login/         起名页（type="nickname" 一键填昵称 + chooseAvatar；已注册自动跳走）
│       ├── record-edit/   记一笔/编辑账目（多图上传）
│       ├── schedule-edit/ 行程项编辑（picker 选天/地图选点/待办@人/关联账目 picker/多图）
│       └── trip-setting/  旅程设置（名字/起止日期）
├── cloudfunctions/
│   ├── login/    查/建 member + 确保 4 集合与 trip 存在（注册与自动登录）
│   ├── db/       唯一数据网关：13 个 action（见下）
│   ├── getStats/ 聚合统计（无入参 action）
│   └── settle/   AA 最少转账贪心（UI 已下线，函数保留）
├── .check.js  结构校验（JSON/JS 语法、wxml 闭合、bind 事件有定义、data 变量有来源、云函数 action 对齐）
├── .test.js   单元测试（纯函数/算法，约 3500 断言）
└── .e2e.js    端到端（mock 小程序运行时驱动真实页面代码 + 真实云函数逻辑，222 断言/13 场景）
```

## 4. 架构与数据流

- **所有数据库读写只走云函数**（集合权限收紧），`db` 云函数按 `event.action` 分发，13 个 action：
  `listRecords addRecord updateRecord deleteRecord getRecord` /
  `listSchedule addSchedule updateSchedule deleteSchedule` /
  `getTrip updateTrip` / `listMembers updateMember`。
  云函数内校验 `openId ∈ members`；新增 action 要同时改 `db/index.js` 的 switch 与调用页。
- **金额一律整数分**存储与传输，展示用 `fenToYuan`；日期一律 `YYYY-MM-DD` 字符串；`schedule.day` 是「第几天」的序号（1 起），由 `date` 相对旅程出发日推算。
- 登录态：`app.js onLaunch` 调 login 云函数 → `globalData.currentMember/currentTrip`；页面统一 `await ensureLogin()`，未注册 reLaunch 到 login 页。**启动页是 trip Tab**（app.json pages[0]），login 页 onLoad 发现已注册会自动 switchTab 走。
- 性能三件套：启动时 `prewarm()` 后台暖云函数；三个 Tab **缓存优先**（`utils/cache.js`，进页先铺本地缓存再静默刷新）；loading 遮罩只在无缓存首进出现。

## 5. 数据模型（4 集合）

```
trips    { _id, name, startDate, endDate, createdAt, updatedAt }        // 单旅程
members  { _id, openId, name, avatarFileID, createdAt }
schedule { _id, day, startTime, endTime, type, title, location,
           latitude, longitude,          // 仅微信 chooseLocation 选点产生，未选为 null
           note,                         // 备忘
           todos: [{id,text,done,ownerId,ownerName}],   // 待办+@负责人
           costRecordId,                 // 关联账目（可选）
           imageFileID, imageFileIDs: [],// 附件（新数组+旧单图兼容）
           createdByOpenId, createdAt }
records  { _id, date, day, category, amount(分), payerId, participantIds[],
           note, imageFileID, imageFileIDs: [], createdByOpenId, createdAt, updatedAt }
```

分类 key 见 `utils/constants.js`（traffic/hotel/food/ticket/other；遗留 entertainment/shopping 读取时归入 other）。

## 6. 已定案的产品规则（owner 拍过板，别擅自改回）

- UI 日期**直接显示具体日期+星期**，禁止「Day N」文案（picker 选项、准备清单、导出图同）。
- 选择类交互一律 **picker 选择器**，不平铺列表（关联账目、天数）。
- 行程地点**只能地图选点**（wx.chooseLocation），列表上地点仅显示图标。
- 行程页「当日花费」= **关联账目口径**（该天行程项 costRecordId 挂的账之和），不是当天全部账。
- 统计页**没有 AA 结算建议 UI**（settle 云函数保留但页面不用）。
- 准备进度展开清单**只读**，不响应点击勾选（勾选在行程项待办行）。
- 附件预览图标用**线框 SVG（base64 内联）**，禁用 emoji 图标。
- 账单/行程的无效图片引用（非 `cloud://`）打开时**自动删除**并轻提示，不做失效标记等兜底。
- 微信拿不到真昵称/头像（2022-10 政策）：昵称用 `input type="nickname"` 一键填充，头像用 `button open-type="chooseAvatar"`；**不要**再尝试 getUserProfile/getUserInfo。
- 待办 @人 的来源是成员表（listMembers），actionSheet 最多 6 项（微信限制），成员>5 时截断。

## 7. 验证三件套（改完必跑，全绿才算完）

```bash
node .check.js   # 结构校验：0 问题
node .test.js    # 单元：0 失败
node .e2e.js     # 端到端：222 断言 0 失败
```

- 三者都是**纯 node 脚本、零依赖**，直接跑。
- `.e2e.js` 机制：文件内 mock 了 `wx/App/Page/getCurrentPages`（`NAV_STACK/PAGE_STACK/STORAGE/PREVIEWED/SAVED/CANVAS/TOASTS/MODAL_ANSWER`），`loadPage(name)` 加载真实页面代码，`CF.db/CF.login...` 直调真实云函数代码（Module._load 拦截 wx-server-sdk，内存集合 `CURRENT.collections`）。
- **产品行为变更时同步修正 e2e 旧断言**（本仓库惯例）；只加功能不破坏行为时不必动断言。
- mock 缺某个 wx API 会直接 TypeError，按需在 mock 对象里补（如当年补 storage/previewImage/saveImageToPhotosAlbum/chooseLocation）。

## 8. 开发红线与惯例

- **不引入任何 npm 依赖**、不建构建配置；根目录没有 package.json 是故意的。
- 小范围改动严格限定需求涉及的文件；改完即停，不产额外交付物（报告/canvas/文档），除非 owner 要。
- 微信主包 ≤2MB：图片资源要压缩；tabBar 图标改动后 DevTools 需清缓存/重启才刷新。
- `.DS_Store`、`project.private.config.json` 已在 .gitignore，别提交；Finder 浏览目录会再生 .DS_Store（.check.js 已忽略点文件）。
- 新增页面：app.json pages 注册 + 页面四件套；`.check.js` 会自动校验 wxml 绑定事件/变量是否都有定义。
- 云函数改动后**必须提醒 owner 重新部署**：DevTools 里右键对应云函数目录 →「上传并部署：云端安装依赖」。小程序侧改动编译即生效。

## 9. 部署与分发（owner 侧操作）

- 体验版：DevTools「上传」→ mp.weixin.qq.com 后台「版本管理 → 开发版本 → 选为体验版」；**体验版二维码永久有效**，更新后朋友冷启动重进即拉新包。
- 朋友需先加为「成员管理 → 体验成员」；首次进小程序起名即加入同一旅程。
- 模拟器与真机 openId 可能不同（DevTools 未登录时），会产生重复成员记录，属环境现象。

## 10. Git 约定

- `main` 为开发分支；`v1.0` = 国庆版封存基线（回看：`git show v1.0:<path>`；基于它修：`git checkout -b hotfix-v1 v1.0`）。
- 提交信息中文简述即可；推送前 owner 习惯先确认（曾启用 L3 安全审查流程）。

## 11. 接手 AI 快速开始清单

1. 读本文 + `miniprogram/app.js`、`cloudfunctions/db/index.js` 头部注释。
2. 跑验证三件套确认基线全绿（不绿先报告，别盲改）。
3. 小步改动 → 再跑三件套 → 汇报「改了什么 + 验证结果 + 是否需要部署云函数」。
4. 涉及产品口径拿不准时，对照第 6 节已定案规则；规则之外的新口径先问 owner。
