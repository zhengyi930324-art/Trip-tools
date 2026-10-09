/* 临时校验脚本：跑完即删 */
const fs = require('fs')
const path = require('path')
const cp = require('child_process')

const ROOT = __dirname
const problems = []
const ok = []

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const files = walk(ROOT).filter(f => !/[.](check|test|e2e)[.]js$/.test(f))

// 1. JSON 合法性
for (const f of files.filter(f => f.endsWith('.json'))) {
  try {
    JSON.parse(fs.readFileSync(f, 'utf8'))
    ok.push(`JSON  ${path.relative(ROOT, f)}`)
  } catch (e) {
    problems.push(`[JSON 解析失败] ${path.relative(ROOT, f)}: ${e.message}`)
  }
}

// 2. JS 语法
for (const f of files.filter(f => f.endsWith('.js'))) {
  const r = cp.spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' })
  if (r.status === 0) ok.push(`JS    ${path.relative(ROOT, f)}`)
  else problems.push(`[JS 语法错误] ${path.relative(ROOT, f)}: ${(r.stderr || '').trim().split('\n').slice(0, 4).join(' | ')}`)
}

// 3. wxml 事件绑定 vs js 方法
const pagesDir = path.join(ROOT, 'miniprogram/pages')
for (const page of fs.readdirSync(pagesDir)) {
  const wxml = path.join(pagesDir, page, 'index.wxml')
  const js = path.join(pagesDir, page, 'index.js')
  if (!fs.existsSync(wxml) || !fs.existsSync(js)) {
    problems.push(`[缺文件] pages/${page} 缺少 index.wxml 或 index.js`)
    continue
  }
  const w = fs.readFileSync(wxml, 'utf8')
  const j = fs.readFileSync(js, 'utf8')
  const handlers = new Set()
  const re = /(?:bind|catch|capture-bind|capture-catch|mut-bind)[:]?([a-zA-Z]+)\s*=\s*"([^"{}]+)"/g
  let m
  while ((m = re.exec(w))) handlers.add(m[2].trim())
  for (const h of handlers) {
    const defined = new RegExp(`(^|[\\s,{])${h}\\s*[(:]`).test(j) || new RegExp(`\\b${h}\\s*\\(`).test(j)
    if (!defined) problems.push(`[事件未定义] pages/${page}: wxml 绑定 ${h} 但 index.js 中找不到`)
  }
  if (handlers.size) ok.push(`BIND  pages/${page} (${handlers.size} 个事件全部有定义)`)
}

// 4. 页面调用的 db action 是否都在云函数里实现
const dbSrc = fs.readFileSync(path.join(ROOT, 'cloudfunctions/db/index.js'), 'utf8')
const implActions = new Set()
let m2
const reCase = /case\s+'([A-Za-z]+)'/g
while ((m2 = reCase.exec(dbSrc))) implActions.add(m2[1])
const usedActions = new Set()
for (const f of files.filter(f => f.startsWith(path.join(ROOT, 'miniprogram')))) {
  const s = fs.readFileSync(f, 'utf8')
  const re = /action\s*:\s*'([A-Za-z]+)'/g
  let mm
  while ((mm = re.exec(s))) usedActions.add(mm[1])
}
for (const a of usedActions) {
  if (!implActions.has(a)) problems.push(`[action 缺失] 页面调用 '${a}'，但 cloudfunctions/db 未实现`)
}
ok.push(`ACT   云函数实现 ${implActions.size} 个 action，页面用到 ${usedActions.size} 个：${[...usedActions].join(', ')}`)

// 5. 云函数是否被 wx.cloud.callFunction 正确引用
const fnNames = fs.readdirSync(path.join(ROOT, 'cloudfunctions')).filter(n => !n.startsWith('.'))
const calledFns = new Set()
for (const f of files.filter(f => f.startsWith(path.join(ROOT, 'miniprogram')))) {
  const s = fs.readFileSync(f, 'utf8')
  const re = /name\s*:\s*'([A-Za-z]+)'/g
  let mm
  while ((mm = re.exec(s))) calledFns.add(mm[1])
}
for (const fn of fnNames) {
  if (!calledFns.has(fn)) problems.push(`[云函数未被调用] cloudfunctions/${fn}`)
}
ok.push(`FN    云函数 ${fnNames.join(', ')}；页面调用 ${[...calledFns].join(', ')}`)

// 6. app.json 页面路由 vs 实际文件
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram/app.json'), 'utf8'))
for (const p of appJson.pages) {
  for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
    const fp = path.join(ROOT, 'miniprogram', p + ext)
    if (!fs.existsSync(fp)) problems.push(`[路由缺文件] ${p}${ext}`)
  }
}
for (const t of appJson.tabBar.list) {
  if (!appJson.pages.includes(t.pagePath)) problems.push(`[tabBar 路由未注册] ${t.pagePath}`)
  if (t.iconPath && !fs.existsSync(path.join(ROOT, 'miniprogram', t.iconPath))) problems.push(`[tabBar 图标缺失] ${t.iconPath}`)
}
ok.push(`ROUTE app.json ${appJson.pages.length} 个页面 + ${appJson.tabBar.list.length} 个 tab 全部齐备`)

// 7. 每个页面 index.json 的 usingComponents 是否存在
for (const page of fs.readdirSync(pagesDir)) {
  const jp = path.join(pagesDir, page, 'index.json')
  const cfg = JSON.parse(fs.readFileSync(jp, 'utf8'))
  for (const [k, v] of Object.entries(cfg.usingComponents || {})) {
    const base = v.startsWith('/') ? path.join(ROOT, 'miniprogram', v) : path.join(pagesDir, page, v)
    if (!fs.existsSync(base + '.js')) problems.push(`[组件缺失] pages/${page} 的 ${k} -> ${v}`)
  }
}

// 8. 金额是否用整数分（不应出现 toFixed 直接对 amount 运算后存库）
for (const f of files.filter(f => f.startsWith(path.join(ROOT, 'miniprogram')) && f.endsWith('.js'))) {
  const s = fs.readFileSync(f, 'utf8')
  if (/parseFloat\(.*amount/.test(s) && !/yuanToFen/.test(s)) {
    problems.push(`[金额精度可疑] ${path.relative(ROOT, f)} 直接 parseFloat(amount) 未经 yuanToFen`)
  }
}

// 9. 动态 action（如 const action = isEdit ? 'updateRecord' : 'addRecord'）
//    扫所有看起来像 CRUD 动作的字符串字面量，逐个核对是否已实现
//    注：跳过云函数名（如 'getStats'），它们形似 action 但不是 db 的 case
const skipNames = new Set(fnNames)
const crudLitRe = /'(?:list|add|update|delete|get)[A-Z][A-Za-z]*'/g
const dynUsed = new Set()
for (const f of files.filter(f => f.startsWith(path.join(ROOT, 'miniprogram')) && f.endsWith('.js'))) {
  const lits = fs.readFileSync(f, 'utf8').match(crudLitRe) || []
  for (const lit of lits) {
    const name = lit.slice(1, -1)
    if (skipNames.has(name)) continue
    dynUsed.add(name)
    if (!implActions.has(name)) {
      problems.push(`[action 未实现] ${path.relative(ROOT, f)} 引用 '${name}'，但 cloudfunctions/db 无此 case`)
    }
  }
}
const unusedImpl = [...implActions].filter(a => !dynUsed.has(a))
ok.push(`DYN   页面共引用 ${dynUsed.size} 个 db action（含三元动态选择），全部已实现`)
if (unusedImpl.length) ok.push(`      云函数额外提供但页面未用：${unusedImpl.join(', ')}`)

// 10. wxml 的 {{}} 绑定变量是否在页面 js 里定义过
//     （防止 scrollTarget / scrollToDay 这类拼写不一致导致页面空白）
const JS_KEYWORDS = new Set(['true', 'false', 'null', 'undefined', 'in', 'of', 'typeof', 'instanceof',
  'new', 'this', 'Math', 'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON', 'Date',
  'if', 'else', 'return', 'length', 'toString', 'indexOf', 'includes'])
const bindingReport = []
for (const page of fs.readdirSync(pagesDir)) {
  const wxml = path.join(pagesDir, page, 'index.wxml')
  const jsf = path.join(pagesDir, page, 'index.js')
  if (!fs.existsSync(wxml)) continue
  const w = fs.readFileSync(wxml, 'utf8')
  const j = fs.existsSync(jsf) ? fs.readFileSync(jsf, 'utf8') : ''

  // wx:for 的循环别名（默认 item / index）
  const aliases = new Set(['item', 'index'])
  const aliasRe = /wx:for-(?:item|index)\s*=\s*"([A-Za-z0-9_$]+)"/g
  let am
  while ((am = aliasRe.exec(w))) aliases.add(am[1])

  // <wxs module="xxx"> 声明的模块名（在 {{}} 里当全局用）
  const wxsRe = /<wxs[^>]+module\s*=\s*"([A-Za-z0-9_$]+)"/g
  let wm
  while ((wm = wxsRe.exec(w))) aliases.add(wm[1])

  // 取出所有 {{ ... }} 里的表达式
  const idents = new Set()
  const exprRe = /\{\{([\s\S]*?)\}\}/g
  let em
  while ((em = exprRe.exec(w))) {
    // 先剥掉引号内的字符串，避开 'chip-active' 这种被拆成 active
    const expr = em[1].replace(/'[^']*'|"[^"]*"/g, " '' ")
    const idRe = /(^|[^.\w$-])([A-Za-z_$][A-Za-z0-9_$]*)/g
    let im
    while ((im = idRe.exec(expr))) {
      const name = im[2]
      if (JS_KEYWORDS.has(name) || aliases.has(name)) continue
      idents.add(name)
    }
  }

  const missing = []
  for (const name of idents) {
    // 在 js 中作为 data 字段、setData 键、或 this.data.x 出现过即视为已定义
    const defined = new RegExp(`(?:^|[\\s{,(])${name}\\s*:`).test(j) ||
                    new RegExp(`this\\.data\\.${name}\\b`).test(j) ||
                    new RegExp(`\\b${name}\\s*\\}`).test(j)
    if (!defined) missing.push(name)
  }
  if (missing.length) {
    problems.push(`[绑定变量未定义] pages/${page}/index.wxml 使用了 ${missing.join(', ')}，但 index.js 未定义`)
  } else {
    bindingReport.push(`DATA  pages/${page} (${idents.size} 个绑定变量均有定义)`)
  }
}

// 11. WXML 标签闭合与嵌套校验
const VOID_TAGS = new Set(['input', 'image', 'icon', 'progress', 'switch', 'slider', 'audio', 'video', 'camera', 'live-player', 'live-pusher', 'import', 'include', 'wxs', 'br', 'hr', 'img'])
for (const page of fs.readdirSync(pagesDir)) {
  const wxml = path.join(pagesDir, page, 'index.wxml')
  if (!fs.existsSync(wxml)) continue
  const src = fs.readFileSync(wxml, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')          // 去注释
    .replace(/<wxs[\s\S]*?<\/wxs>/g, '<wxs/>') // wxs 内含 JS，不当标签树看
  const stack = []
  // 属性值里可能包含 > （如 wx:if="{{a > 0}}"），所以引号内的 > 不能当标签结束
  const tagRe = /<(\/?)([a-zA-Z][-a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g
  let tm
  let bad = null
  while ((tm = tagRe.exec(src))) {
    const [, closing, tag, attrs, selfClose] = tm
    if (closing) {
      const top = stack.pop()
      if (top !== tag) { bad = `</${tag}> 与未闭合的 <${top || '无'}> 不匹配`; break }
    } else if (!selfClose && !VOID_TAGS.has(tag)) {
      stack.push(tag)
    }
  }
  if (!bad && stack.length) bad = `标签未闭合: ${stack.join(' > ')}`
  if (bad) problems.push(`[WXML 结构错误] pages/${page}/index.wxml ${bad}`)
  else ok.push(`WXML  pages/${page} 标签树完整闭合`)

  // {{ }} 必须成对
  const open = (src.match(/\{\{/g) || []).length
  const close = (src.match(/\}\}/g) || []).length
  if (open !== close) problems.push(`[WXML 插值不配对] pages/${page}/index.wxml {{ x${open} 对 }} x${close}`)
}

console.log('---- 通过项 ----')
ok.push(...bindingReport)

for (const o of ok) console.log('  ✓ ' + o)
console.log('')
if (problems.length === 0) {
  console.log('==== 全部校验通过，0 问题 ====')
} else {
  console.log(`==== 发现 ${problems.length} 个问题 ====`)
  for (const p of problems) console.log('  ✗ ' + p)
  process.exitCode = 1
}
