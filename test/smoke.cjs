// dsh-comments client.js 煙霧測試：模擬最小瀏覽器環境 + React shim，
// 物化工廠、調 apply 註冊槽位、渲染各組件的主要狀態分支。
const assert = (cond, msg) => { if (!cond) throw new Error('SMOKE FAIL: ' + msg) }

// ── 最小 DOM stub ─────────────────────────────────────────────
const listeners = []
global.window = {
	localStorage: {
		_mem: new Map(),
		setItem(k, v) { this._mem.set(k, v) },
		getItem(k) { return this._mem.has(k) ? this._mem.get(k) : null },
		removeItem(k) { this._mem.delete(k) },
	},
	innerWidth: 1440,
	innerHeight: 900,
	setTimeout: (fn) => { fn(); return 1 },
	setInterval: () => 1,
	clearInterval: () => {},
	clearTimeout: () => {},
	addEventListener: () => {},
	removeEventListener: () => {},
	Highlight: function () {},
}
global.document = {
	head: { appendChild: () => {} },
	createElement: () => ({ setAttribute: () => {}, set textContent(v) {}, style: {} }),
	createTextNode: (t) => ({ text: t }),
	createTreeWalker: () => ({ nextNode: () => null }),
	createRange: () => ({ setStart() {}, setEnd() {} }),
	querySelectorAll: () => [],
	addEventListener: (t, fn) => { listeners.push([t, fn]) },
	removeEventListener: () => {},
	body: {},
	caretRangeFromPoint: undefined,
}
global.NodeFilter = { SHOW_TEXT: 4 }
global.MutationObserver = class { observe() {} disconnect() {} }
global.CSS = { highlights: new Map() }

// ── React shim：只支援單次渲染（無狀態更新循環）────────────────
let hookIdx = 0
const Fragment = Symbol('fragment')
const createElement = (type, props, ...children) => ({ type, props: props || {}, children })
const React = {
	Fragment,
	createElement,
	useState: (init) => { hookIdx += 1; return [typeof init === 'function' ? init() : init, () => {}] },
	useEffect: () => { hookIdx += 1 },
	useReducer: (reducer, init) => { hookIdx += 1; return [init, () => {}] },
}

// ── 物化工廠 ──────────────────────────────────────────────────
let loaded = null
global.window.__ModuleLoader__ = { load: (spec) => { loaded = spec } }
// Pre-rename snapshot: the module must adopt it under the new key on load.
global.window.localStorage.setItem('dsh-markup/marks/v1', JSON.stringify({ 'legacy-sess': [{ id: 'legacy-mark' }] }))
const path = require('path')
const src = require('fs').readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8')
new Function('window', 'document', 'NodeFilter', 'MutationObserver', 'CSS', src)(global.window, global.document, global.NodeFilter, global.MutationObserver, global.CSS)
assert(loaded && loaded.id === 'dsh-comments', 'module registered')
assert(typeof loaded.factory === 'function', 'factory is function')

const pluginExports = loaded.factory((name) => { if (name === 'react') return React; throw new Error('unexpected require ' + name) })
const T = pluginExports.__test
assert(pluginExports.name === 'comments', 'exports.name')
assert(global.window.localStorage.getItem('dsh-comments/marks/v1') !== null, 'legacy localStorage adopted')
assert(global.window.localStorage.getItem('dsh-markup/marks/v1') !== null, 'legacy key left in place')
assert(Array.isArray(pluginExports.inject) && pluginExports.inject.includes('slots'), 'inject list')

// ── apply：槽位註冊 ────────────────────────────────────────────
const registrations = []
const ctx = {
	slots: {
		inject: (key, fn) => { const r = fn(); registrations.push({ key, r }) },
		register: (reg, comp) => ({ reg, comp }),
	},
	sessions: { scope: () => undefined },
}
pluginExports.apply(ctx)
const dock = registrations.find((x) => x.key === 'conversation.input.dock')
const overlay = registrations.find((x) => x.key === 'shell.overlay')
assert(dock, 'dock seat registered')
assert(overlay, 'overlay seat registered')
assert(dock.r.reg.id === 'comments-dock' && dock.r.reg.order === 26, 'dock registration fields')
assert(overlay.r.reg.id === 'comments-button', 'overlay registration fields')
assert(typeof dock.r.reg.inject === 'function', 'dock inject hook')
const injected = dock.r.reg.inject('sess-1')
assert(injected && typeof injected === 'object', 'inject hook tolerates missing scope')

const render = (comp, props) => { hookIdx = 0; return comp.type === Fragment ? null : comp(props) }
const CommentsDock = dock.r.comp
const CommentsOverlay = overlay.r.comp

// ── 各組件渲染分支 ────────────────────────────────────────────
// 1. 空 session：dock 不渲染
let out = render(CommentsDock, { sessionId: '' })
assert(out === null, 'dock empty session renders null')

// 2. 有標記的 session：dock 渲染完整面板
const mark = {
	id: 'm1', turn: 3, nodeKey: 'n1', quote: '建議採用 A 方案', quotePlain: '建議採用 A 方案',
	occ: 0, type: 'disagree', comment: '我不同意，B 更穩', created: 1,
}
global.window.localStorage.setItem('dsh-comments/marks/v1', JSON.stringify({ 'sess-1': [mark] }))
T.reseed()
out = render(CommentsDock, { sessionId: 'sess-1', input: { draft: '' }, inputActions: { setDraft: () => {}, submit: () => {} } })
assert(out !== null && out.type === 'div', 'dock renders with marks')
const texts = []
const walkText = (node) => {
  if (typeof node === 'string') { texts.push(node); return }
  if (Array.isArray(node)) { node.forEach(walkText); return }
  if (node && typeof node === 'object' && Array.isArray(node.children)) node.children.forEach(walkText)
}
walkText(out)
assert(texts.join('|').includes('1 處待發'), 'dock shows count: ' + texts.join('|').slice(0, 120))

// 3. overlay：無選區 → 只有空的 Fragment 內容
hookIdx = 0
let ov = CommentsOverlay({})
assert(ov !== null && ov !== undefined, 'overlay renders')

// 4. overlay：再次渲染
hookIdx = 0
const ov2 = CommentsOverlay({})
assert(ov2 !== null, 'overlay renders again')

// 5. 編輯面板（edit 模式）：側欄定位、可拖動頭、保存按鈕都渲染出來
T.setEditorState({ mode: 'edit', markId: mark.id, draft: { turn: 3, quote: '引用文字', quotePlain: '引用文字', occ: 0, x: 0, y: 0 }, type: 'suggest', comment: '意見', x: 0, y: 0 })
hookIdx = 0
const ov3 = CommentsOverlay({})
const texts3 = []
const walk3 = (node) => {
  if (typeof node === 'string') { texts3.push(node); return }
  if (Array.isArray(node)) { node.forEach(walk3); return }
  if (node && typeof node === 'object' && typeof node.type === 'function') { walk3(node.type(node.props || {})); return }
  if (node && typeof node === 'object' && Array.isArray(node.children)) node.children.forEach(walk3)
}
walk3(ov3)
const joined = texts3.join('|')
assert(joined.includes('可拖動'), 'editor has drag hint')
assert(joined.includes('保存標記'), 'editor has save button')
assert(joined.includes('指示') && joined.includes('評論'), 'editor has type chips')
// 面板根節點樣式：固定定位 + 344 寬
let panelNode = null
const findPanel = (node) => {
  if (node && typeof node === 'object' && typeof node.type === 'function') { findPanel(node.type(node.props || {})); return }
  if (node && typeof node === 'object' && node.type === 'div' && node.props && node.props.style && node.props.style.width === 344) panelNode = node
  if (node && typeof node === 'object' && Array.isArray(node.children)) node.children.forEach(findPanel)
  if (Array.isArray(node)) node.forEach(findPanel)
}
findPanel(ov3)
assert(panelNode !== null, 'editor panel node found')
assert(panelNode.props.style.position === 'fixed', 'editor panel fixed')
assert(typeof panelNode.props.ref === 'function', 'editor panel has drag ref')

// 6. 組裝消息格式：塊間空行分隔、無 ** 裝飾（修 md 惰性續行渲染問題）
const msg = T.composeMessage([{ turn: 3, quote: '引用一\n引用二', type: 'disagree', comment: '意見一' }])
assert(msg.includes('\n\n> 引用一\n> 引用二\n\n意見：意見一'), 'compose blank-line separated, got: ' + JSON.stringify(msg))
assert(!msg.includes('**'), 'compose has no bold decoration')

console.log('SMOKE OK — all assertions passed')
