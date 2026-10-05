// dsh-markup 錨定回歸測試：用假 DOM（屬性選擇器 + TreeWalker + Range 坐標語義）
// 驗證「選區 → (turn, 文本, 出現序號) → 重定位 Range」全鏈路，包括嵌套
// wrapper 去重、跨節點選區、同文本多次出現、occ 越界收斂到最後一次。
const assert = (cond, msg) => { if (!cond) throw new Error('ANCHOR FAIL: ' + msg) }

// ── 假 DOM ─────────────────────────────────────────────────────
// 文本節點按文檔順序登記，絕對偏移 = 前面節點長度之和；Range 用絕對坐標實現
// intersectsNode，與真實 Range 語義一致（部分重疊即相交）。
class FakeText {
	constructor(value) {
		this.nodeValue = value
		this.nodeType = 3
		this.parentElement = null
	}
}
class FakeElement {
	constructor(attrs) {
		this.attrs = attrs || {}
		this.children = []
		this.nodeType = 1
		this.parentElement = null
	}
	getAttribute(name) {
		const own = Object.prototype.hasOwnProperty.call(this.attrs, name)
		return own ? this.attrs[name] : null
	}
	append(...nodes) {
		for (const n of nodes) {
			n.parentElement = this
			this.children.push(n)
		}
	}
}

const doc = {
	_text: [],
	_elements: [],
	createTreeWalker(root) {
		const texts = []
		const walk = (node) => {
			for (const c of node.children) {
				if (c.nodeType === 3) texts.push(c)
				else walk(c)
			}
		}
		walk(root)
		let i = 0
		return { nextNode: () => (i < texts.length ? texts[i++] : null) }
	},
	querySelectorAll(selector) {
		const m = /^\[data-chat-turn="(.+)"\]$/.exec(selector)
		if (m === null) return []
		return doc._elements.filter((el) => el.getAttribute('data-chat-turn') === m[1])
	},
	createRange() {
		return new FakeRange()
	},
}

class FakeRange {
	constructor() {
		this.startContainer = null
		this.endContainer = null
		this.startOffset = 0
		this.endOffset = 0
	}
	setStart(node, off) { this.startContainer = node; this.startOffset = off }
	setEnd(node, off) { this.endContainer = node; this.endOffset = off }
	_abs(node, off) {
		let base = 0
		for (const t of doc._text) {
			if (t === node) return base + off
			base += t.nodeValue.length
		}
		throw new Error('node not in document order')
	}
	intersectsNode(node) {
		const s = this._abs(this.startContainer, this.startOffset)
		const e = this._abs(this.endContainer, this.endOffset)
		let base = 0
		for (const t of doc._text) {
			if (t === node) {
				const ns = base
				const ne = base + t.nodeValue.length
				return Math.max(s, e) > ns && Math.min(s, e) < ne
			}
			base += t.nodeValue.length
		}
		return false
	}
}

// 構造：外層 group 容器 [data-chat-turn=3] 嵌套 k1（assistant-step），
// 另有同輪 k2 —— 驗證去重後 hay 只算一次。
const t1 = new FakeText('Alpha beta ') // k1 第一個文本節點
const t2 = new FakeText('gamma delta.') // k1 第二個文本節點
const t3 = new FakeText('Alpha beta second occurrence.') // k2 唯一文本節點

const k1 = new FakeElement({ 'data-chat-node-key': 'k1', 'data-chat-flow-kind': 'assistant-step', 'data-chat-turn': '3' })
k1.append(t1, t2)
const outer = new FakeElement({ 'data-chat-turn': '3' })
outer.append(k1)
const k2 = new FakeElement({ 'data-chat-node-key': 'k2', 'data-chat-flow-kind': 'assistant-step', 'data-chat-turn': '3' })
k2.append(t3)
const otherTurn = new FakeElement({ 'data-chat-node-key': 'k9', 'data-chat-flow-kind': 'assistant-step', 'data-chat-turn': '4' })
otherTurn.append(new FakeText('Alpha beta other turn'))

doc._elements = [outer, k1, k2, otherTurn]
doc._text = [t1, t2, t3, otherTurn.children[0]]

global.document = doc
global.NodeFilter = { SHOW_TEXT: 4 }

// ── 物化工廠 ──────────────────────────────────────────────────
global.window = { __ModuleLoader__: { load: (s) => { global.__spec = s } } }
const fs = require('fs')
const path = require('path')
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8')
new Function('window', 'document', src)(global.window, global.document)
const React = { createElement: () => ({}), Fragment: Symbol() }
const T = global.__spec.factory(() => React).__test

// 去重：k1 的節點不被 outer 重複計入；只含 turn=3
const nodes = T.turnTextNodes(3)
assert(nodes.length === 3, 'dedupe turn text nodes, got ' + nodes.length)
assert(nodes[0] === t1 && nodes[1] === t2 && nodes[2] === t3, 'document order preserved')
const hay = nodes.map((n) => n.nodeValue).join('')
assert(hay === 'Alpha beta gamma delta.Alpha beta second occurrence.', 'haystack')

// ── 場景 1：選 k1 內的 "gamma delta."（單節點內選區）──────────
{
	const range = new FakeRange()
	range.setStart(t2, 0)
	range.setEnd(t2, 'gamma delta.'.length)
	const data = T.selectionTextData(range, nodes)
	assert(data !== null && data.plain === 'gamma delta.', 's1 plain')
	assert(data.startOffset === 'Alpha beta '.length, 's1 startOffset')
	assert(T.countOccurrencesBefore(hay, 'gamma delta.', data.startOffset) === 0, 's1 occ')
	const mark = { turn: 3, quotePlain: 'gamma delta.', occ: 0 }
	const located = T.locateMarkRange(mark)
	assert(located !== null, 's1 located')
	assert(located.startContainer === t2 && located.startOffset === 0, 's1 range start')
	assert(located.endOffset === 'gamma delta.'.length, 's1 range end')
}

// ── 場景 2：跨節點選區 "beta gamma"（t1 尾段 + t2 頭段）────────
{
	const range = new FakeRange()
	range.setStart(t1, 'Alpha '.length) // "beta " 開始
	range.setEnd(t2, 'gamma'.length)
	const data = T.selectionTextData(range, nodes)
	assert(data.plain === 'beta gamma', 's2 plain, got ' + JSON.stringify(data && data.plain))
	assert(data.startOffset === 'Alpha '.length, 's2 startOffset')
	const mark = { turn: 3, quotePlain: 'beta gamma', occ: 0 }
	const located = T.locateMarkRange(mark)
	assert(located !== null, 's2 located')
	assert(located.startContainer === t1 && located.startOffset === 'Alpha '.length, 's2 start')
	assert(located.endContainer === t2 && located.endOffset === 'gamma'.length, 's2 end')
}

// ── 場景 3：同文本第二次出現 —— "Alpha beta " 選在 k2 ──────────
{
	const range = new FakeRange()
	range.setStart(t3, 0)
	range.setEnd(t3, 'Alpha beta '.length)
	const data = T.selectionTextData(range, nodes)
	assert(data.plain === 'Alpha beta ', 's3 plain')
	// 出現 0 在 hay[0]（< startOffset），本次是出現 1
	const occ = T.countOccurrencesBefore(hay, 'Alpha beta ', data.startOffset)
	assert(occ === 1, 's3 occ, got ' + occ)
	const mark = { turn: 3, quotePlain: 'Alpha beta ', occ }
	const located = T.locateMarkRange(mark)
	assert(located !== null && located.startContainer === t3, 's3 located on second occurrence')
	assert(located.startOffset === 0, 's3 offset')
}

// ── 場景 4：occ 越界 → 收斂到最後一次出現 ─────────────────────
{
	const mark = { turn: 3, quotePlain: 'Alpha beta ', occ: 9 }
	const located = T.locateMarkRange(mark)
	assert(located !== null && located.startContainer === t3, 's4 clamps to last')
}

// ── 場景 5：文本已從 DOM 消失（重寫了內容）→ 返回 null ────────
{
	const mark = { turn: 3, quotePlain: '不存在的文本', occ: 0 }
	assert(T.locateMarkRange(mark) === null, 's5 missing text')
}

// ── 場景 6：整輪消失（虛擬化滾出視口）→ 返回 null，不拋錯 ────
{
	const mark = { turn: 99, quotePlain: 'Alpha beta ', occ: 0 }
	assert(T.locateMarkRange(mark) === null, 's6 missing turn')
}

// ── 場景 7：quotePlain 空白與 DOM 不一致 → 正規化後備匹配 ────
{
	const mark = { turn: 3, quotePlain: 'Alpha  beta\t gamma', occ: 0 } // 多餘空白
	const located = T.locateMarkRange(mark)
	assert(located !== null, 's7 normalized located')
	assert(located.startContainer === t1 && located.startOffset === 0, 's7 start')
	// 涵蓋 'Alpha beta gamma'（t1 全部 + t2 開頭）
	assert(located.endContainer === t2, 's7 end in t2')
}

// ── 場景 8：DOM 重渲染後空白加倍 → 正規化後備匹配 ────────────
{
	// 把 t1 的文字節點值加空白差異，精確匹配應失敗但正規化應命中
	const saved = t1.nodeValue
	t1.nodeValue = 'Alpha  beta '
	try {
		const mark = { turn: 3, quotePlain: 'Alpha beta gamma', occ: 0 }
		const located = T.locateMarkRange(mark)
		assert(located !== null, 's8 hay-normalized located')
		assert(located.startContainer === t1 && located.startOffset === 0, 's8 start')
	} finally {
		t1.nodeValue = saved
	}
}

console.log('ANCHOR OK — 8 scenarios passed')
