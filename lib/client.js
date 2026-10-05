/**
 * dsh-markup — browser half.
 *
 * 手寫 bundle（lazy-CJS 形狀）：執行本檔案只註冊工廠；所有副作用（樣式表
 * 插入包括在內）都發生在工廠閉包物化之時。
 *
 * 功能（用戶 2026-10-05 需求，已確認）：
 *   1. 在任意助手消息上劃選一小段文字 → 選區旁浮出「✎ Markup」按鈕。
 *   2. 點擊後先選點評類型（不同意/不清晰/建議修改/提問/其他），再寫意見，
 *      保存後該片段在原消息上持續高亮（CSS Custom Highlight API）。
 *   3. 可連續標記多段；composer 上方有點評面板：查看/定位/編輯/刪除。
 *   4. 「⤴ 插入輸入框」把全部點評組裝成「引用 + 類型 + 意見」的編號消息
 *      追加到草稿（可補充總述再發送）；「直接發送」則組裝後立即提交。
 *
 * 設計要點：
 *   - 標記錨定：消息 DOM 的 wrapper 帶 data-chat-turn / data-chat-node-key /
 *     data-chat-flow-kind（dsh-client-ui-chat 的 flowItem）。錨 = (turn, 文本,
 *     出現序號)，存 localStorage（per-session），React 重渲染後由
 *     MutationObserver 觸發重新定位高亮——不改動 React 管理的 DOM。
 *   - 引用 = 精確等於劃選文字（表格儲存格 tab → 「 | 」）；md-extract 的
 *     結構化重建（表格→GFM、程式碼→圍欄、清單/標題還原）保留在內但不再
 *     用於引用路徑（用戶 2026-10-05 反饋：引用應是所選的字，不是整段）。
 *   - 寫入通道：conversation.input.dock 條目（session 作用域）拿到
 *     inputActions（provide 通道），或經 entry inject hook 走
 *     conversation.input.for(actx) 服務路由（官方 queue dock 同款）。
 *   - 與 dsh-insights 的「加到筆記」選區按鈕共存：本插件按鈕錨在選區
 *     右端，避開其上方居中的位置。
 */

window.__ModuleLoader__.load({
	id: 'dsh-markup',
	factory: (require) => {
		const React = require('react')
		const h = React.createElement

		// 診斷把手：瀏覽器 console 裏輸入 __DSH_MARKUP__ 可見插件是否已物化。
		try {
			window.__DSH_MARKUP__ = { version: '0.3.2' }
		} catch (_error) {
			/* 忽略 */
		}

		// ════════════════════════════════════════════════════════════════
		// 1. 選區 DOM → Markdown（移植自 dsh-insights/src/client/md-extract.ts，
		//    結構相容最小 DOM；無瀏覽器特定依賴）
		// ════════════════════════════════════════════════════════════════

		const TEXT_NODE = 3
		const ELEMENT_NODE = 1

		function tagOf(node) {
			return typeof node.tagName === 'string' ? node.tagName.toUpperCase() : ''
		}

		function children(node) {
			const out = []
			const list = node.childNodes
			if (list === undefined || list === null) return out
			for (let i = 0; i < list.length; i += 1) {
				const child = list[i]
				if (child !== undefined && child !== null) out.push(child)
			}
			return out
		}

		function descendants(node, tags) {
			const out = []
			const walk = (n) => {
				for (const child of children(n)) {
					if (child.nodeType === ELEMENT_NODE) {
						if (tags.includes(tagOf(child))) out.push(child)
						walk(child)
					}
				}
			}
			walk(node)
			return out
		}

		function textOf(node) {
			if (node.nodeType === TEXT_NODE) return node.nodeValue ?? ''
			let out = ''
			for (const child of children(node)) out += textOf(child)
			return out
		}

		function inlineMd(node) {
			if (node.nodeType === TEXT_NODE) return node.nodeValue ?? ''
			if (node.nodeType !== ELEMENT_NODE) return ''
			const inner = children(node).map(inlineMd).join('')
			switch (tagOf(node)) {
				case 'CODE': return inner === '' ? '' : '`' + inner + '`'
				case 'STRONG':
				case 'B': return inner === '' ? '' : '**' + inner + '**'
				case 'EM':
				case 'I': return inner === '' ? '' : '*' + inner + '*'
				case 'DEL':
				case 'S': return inner === '' ? '' : '~~' + inner + '~~'
				case 'BR': return ' '
				case 'A': {
					const get = node.getAttribute
					const href = typeof get === 'function' ? (get.call(node, 'href') ?? '') : ''
					return href !== '' && inner !== '' ? '[' + inner + '](' + href + ')' : inner
				}
				default: return inner
			}
		}

		function cellMd(cell) {
			return inlineMd(cell).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')
		}

		function tableMd(rows) {
			const clean = rows.filter((r) => r.length > 0)
			if (clean.length === 0) return ''
			const cols = Math.max(...clean.map((r) => r.length))
			const pad = (row) => {
				const cells = row.map(cellMd)
				while (cells.length < cols) cells.push('')
				return cells
			}
			const head = pad(clean[0])
			const lines = ['| ' + head.join(' | ') + ' |', '| ' + head.map(() => '---').join(' | ') + ' |']
			for (const row of clean.slice(1)) lines.push('| ' + pad(row).join(' | ') + ' |')
			return lines.join('\n')
		}

		function isHeaderRow(tr) {
			const parent = tr.parentElement
			if (parent !== undefined && parent !== null && tagOf(parent) === 'THEAD') return true
			return descendants(tr, ['TH']).length > 0
		}

		function tableFromRange(table, range) {
			const trs = descendants(table, ['TR'])
			if (trs.length === 0) return ''
			const headerTr = trs.find((tr) => isHeaderRow(tr))
			let covered = []
			try {
				covered = trs.filter((tr) => range.intersectsNode(tr))
			} catch (_error) {
				covered = []
			}
			const picked = covered.length > 0 ? covered : trs
			const rows = []
			if (headerTr !== undefined && !picked.includes(headerTr)) rows.push(descendants(headerTr, ['TH', 'TD']))
			for (const tr of picked) rows.push(descendants(tr, ['TH', 'TD']))
			return tableMd(rows)
		}

		function tableOf(node) {
			let el = node
			while (el !== null && el !== undefined) {
				if (tagOf(el) === 'TABLE') return el
				el = el.parentElement ?? null
			}
			return null
		}

		const BLOCK_TAGS = ['TABLE', 'PRE', 'UL', 'OL', 'P', 'DIV', 'SECTION', 'ARTICLE', 'BLOCKQUOTE']

		function blocksMd(root, range) {
			const out = []
			const push = (block) => {
				const t = block.trim()
				if (t !== '') out.push(t)
			}

			const walk = (node) => {
				if (node.nodeType === TEXT_NODE) {
					const text = (node.nodeValue ?? '').replace(/[ \t]+/g, ' ').trim()
					if (text !== '') push(text)
					return
				}
				if (node.nodeType !== ELEMENT_NODE) {
					for (const child of children(node)) walk(child)
					return
				}
				switch (tagOf(node)) {
					case 'TABLE': {
						const inRange = range !== undefined && tableOf(range.startContainer) === node
						const md = inRange
							? tableFromRange(node, range)
							: tableMd(descendants(node, ['TR']).map((tr) => descendants(tr, ['TH', 'TD'])))
						push(md)
						return
					}
					case 'PRE': {
						const code = textOf(node).replace(/\n+$/, '')
						if (code.trim() !== '') push('```\n' + code + '\n```')
						return
					}
					case 'UL':
					case 'OL': {
						const items = children(node).filter((c) => tagOf(c) === 'LI')
						const lines = items.map((li, i) => {
							const body = inlineMd(li).replace(/\s+/g, ' ').trim()
							return tagOf(node) === 'OL' ? (i + 1) + '. ' + body : '- ' + body
						})
						push(lines.join('\n'))
						return
					}
					case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
						const text = inlineMd(node).replace(/\s+/g, ' ').trim()
						if (text !== '') push('#'.repeat(Number(tagOf(node).slice(1))) + ' ' + text)
						return
					}
					case 'P': case 'DIV': case 'SECTION': case 'ARTICLE': case 'LI': case 'BLOCKQUOTE': {
						const kids = children(node)
						const hasBlockChild = kids.some((c) => BLOCK_TAGS.includes(tagOf(c)))
						if (!hasBlockChild) {
							const inline = inlineMd(node).replace(/[ \t]+/g, ' ').trim()
							if (inline !== '') push(inline)
							return
						}
						const inline = kids
							.filter((c) => c.nodeType === TEXT_NODE)
							.map((c) => (c.nodeValue ?? '').replace(/[ \t]+/g, ' ').trim())
							.filter((t) => t !== '')
							.join(' ')
						if (inline !== '') push(inline)
						for (const child of kids) if (child.nodeType === ELEMENT_NODE) walk(child)
						return
					}
					default: {
						for (const child of children(node)) walk(child)
					}
				}
			}

			for (const child of children(root)) walk(child)
			return out.join('\n\n')
		}

		function selectionMarkdown(range) {
			try {
				const table = tableOf(range.startContainer)
				if (table !== null && tableOf(range.endContainer) === table) {
					const md = tableFromRange(table, range)
					if (md.trim() !== '') return md
				}
				const frag = range.cloneContents()
				const md = blocksMd(frag, range)
				if (md.trim() !== '') return md
			} catch (_error) {
				// 落到純文字兜底
			}
			return ''
		}

		// ════════════════════════════════════════════════════════════════
		// 2. 小工具：localStorage、類型表、事件匯流排
		// ════════════════════════════════════════════════════════════════

		/** localStorage 不可用時優雅退化（標記僅存活於本次頁面）。 */
		const store = (() => {
			try {
				const probe = '__dsh_markup_probe__'
				window.localStorage.setItem(probe, '1')
				window.localStorage.removeItem(probe)
				return window.localStorage
			} catch (_error) {
				return null
			}
		})()

		const memory = new Map()
		const KEY = 'dsh-markup/marks/v1'
		const MAX_SESSIONS = 60
		const MAX_MARKS_PER_SESSION = 300

		function readAll() {
			if (store === null) return Object.fromEntries(memory)
			try {
				const raw = store.getItem(KEY)
				if (raw === null) return {}
				const parsed = JSON.parse(raw)
				if (parsed === null || typeof parsed !== 'object') return {}
				return parsed
			} catch (_error) {
				return {}
			}
		}

		function writeAll(all) {
			// 修剪：session 過多丟最舊；單 session 標記過多丟最舊
			const sids = Object.keys(all)
			if (sids.length > MAX_SESSIONS) {
				const byLatest = sids
					.map((sid) => ({ sid, last: Math.max(0, ...all[sid].map((m) => m.created)) }))
					.sort((a, b) => b.last - a.last)
				for (const { sid } of byLatest.slice(MAX_SESSIONS)) delete all[sid]
			}
			for (const sid of Object.keys(all)) {
				if (all[sid].length > MAX_MARKS_PER_SESSION) {
					all[sid] = all[sid].slice(-MAX_MARKS_PER_SESSION)
				}
			}
			if (store === null) {
				for (const [sid, marks] of Object.entries(all)) memory.set(sid, marks)
				return
			}
			try {
				store.setItem(KEY, JSON.stringify(all))
			} catch (_error) {
				/* 配額滿：本頁仍可用 */
			}
		}

		function marksOf(sid) {
			if (sid === '') return []
			const all = readAll()
			const marks = all[sid]
			return Array.isArray(marks) ? marks : []
		}

		function saveMark(sid, mark) {
			if (sid === '') return
			const all = readAll()
			const list = Array.isArray(all[sid]) ? all[sid] : []
			const idx = list.findIndex((m) => m.id === mark.id)
			if (idx >= 0) list[idx] = mark
			else list.push(mark)
			all[sid] = list
			writeAll(all)
			emitChange()
		}

		function deleteMark(sid, id) {
			const all = readAll()
			if (!Array.isArray(all[sid])) return
			all[sid] = all[sid].filter((m) => m.id !== id)
			writeAll(all)
			emitChange()
		}

		function clearMarks(sid) {
			const all = readAll()
			delete all[sid]
			writeAll(all)
			emitChange()
		}

		const TYPES = [
			{ id: 'disagree', label: '不同意', color: '#e5533d' },
			{ id: 'unclear', label: '不清晰', color: '#d99413' },
			{ id: 'suggest', label: '建議修改', color: '#3b82f6' },
			{ id: 'question', label: '提問', color: '#8b5cf6' },
			{ id: 'other', label: '其他', color: '#8a8f98' },
		]
		const typeOf = (id) => TYPES.find((t) => t.id === id) ?? TYPES[TYPES.length - 1]

		/** 極小事件匯流排：任何狀態變化都通知已掛載的組件重渲染。 */
		const listeners = new Set()
		function emitChange() {
			for (const fn of listeners) {
				try {
					fn()
				} catch (_error) {
					/* 單個組件出錯不拖垮其他 */
				}
			}
		}
		function useForce() {
			const [, force] = React.useReducer((n) => n + 1, 0)
			React.useEffect(() => {
				const fn = () => force()
				listeners.add(fn)
				return () => {
					listeners.delete(fn)
				}
			}, [])
		}

		// ════════════════════════════════════════════════════════════════
		// 3. 橋接：root 作用域的 overlay 拿不到 session 資訊，由 dock 條目填入
		// ════════════════════════════════════════════════════════════════

		const bridge = {
			sessionId: '',
			actions: null, // { setDraft(text), submit() } — 來自 inputActions 或服務路由
		}

		// ════════════════════════════════════════════════════════════════
		// 4. 選區 → 標記候選（錨定到 data-chat-turn / 文本 / 出現序號）
		// ════════════════════════════════════════════════════════════════

		const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT'])
		const OWN_SELECTOR = '[data-dsh-markup-ui]'

		function inExcluded(node) {
			let el = node instanceof Element ? node : (node !== null && node !== undefined ? node.parentElement : null)
			while (el !== null) {
				if (EDITABLE.has(el.tagName)) return true
				const ce = el.getAttribute && el.getAttribute('contenteditable')
				if (ce === 'true' || ce === '') return true
				if (typeof el.closest === 'function' && el.closest(OWN_SELECTOR) !== null) return true
				el = el.parentElement
			}
			return false
		}

		/** 某輪的所有文字節點（跨嵌套 wrapper 去重，按文檔順序）。 */
		function turnTextNodes(turn) {
			const seen = new Set()
			const nodes = []
			let els = []
			try {
				els = Array.from(document.querySelectorAll('[data-chat-turn="' + String(turn) + '"]'))
			} catch (_error) {
				return nodes
			}
			for (const el of els) {
				const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
				let n = walker.nextNode()
				while (n !== null) {
					if (!seen.has(n)) {
						seen.add(n)
						nodes.push(n)
					}
					n = walker.nextNode()
				}
			}
			return nodes
		}

		/** 選區在 turn 文本串流內的 (純文本, 起始偏移)；無效回 null。 */
		function selectionTextData(range, turnNodes) {
			const inRange = []
			for (const n of turnNodes) {
				try {
					if (range.intersectsNode(n)) inRange.push(n)
				} catch (_error) {
					/* 忽略單節點 */
				}
			}
			if (inRange.length === 0) return null
			const parts = []
			for (let i = 0; i < inRange.length; i += 1) {
				const node = inRange[i]
				let v = node.nodeValue || ''
				if (i === 0 && node === range.startContainer) v = v.slice(range.startOffset)
				if (i === inRange.length - 1 && node === range.endContainer) {
					const end = node === range.startContainer ? range.endOffset - range.startOffset : range.endOffset
					v = v.slice(0, end)
				}
				parts.push(v)
			}
			let startOffset = 0
			for (const n of turnNodes) {
				if (n === inRange[0]) break
				startOffset += (n.nodeValue || '').length
			}
			if (inRange[0] === range.startContainer) startOffset += range.startOffset
			return { plain: parts.join(''), startOffset }
		}

		function countOccurrencesBefore(hay, needle, limit) {
			if (needle === '') return 0
			let idx = 0
			let count = 0
			for (;;) {
				const found = hay.indexOf(needle, idx)
				if (found < 0 || found >= limit) return count
				count += 1
				idx = found + needle.length
			}
		}

		function nthOccurrence(hay, needle, n) {
			if (needle === '') return -1
			let idx = 0
			let k = 0
			let last = -1
			for (;;) {
				const found = hay.indexOf(needle, idx)
				if (found < 0) return last >= 0 ? last : -1
				if (k === n) return found
				last = found
				k += 1
				idx = found + needle.length
			}
		}

		function rangeFromOffsets(nodes, start, end) {
			const r = document.createRange()
			let acc = 0
			let started = false
			for (const n of nodes) {
				const len = (n.nodeValue || '').length
				const nodeStart = acc
				const nodeEnd = acc + len
				if (!started && start < nodeEnd && len > 0) {
					try {
						r.setStart(n, Math.max(0, start - nodeStart))
					} catch (_error) {
						r.setStart(n, 0)
					}
					started = true
				}
				if (started && end <= nodeEnd) {
					try {
						r.setEnd(n, Math.max(0, end - nodeStart))
					} catch (_error) {
						r.setEnd(n, len)
					}
					return r
				}
				acc = nodeEnd
			}
			if (started) {
				const lastNode = nodes[nodes.length - 1]
				try {
					r.setEnd(lastNode, (lastNode.nodeValue || '').length)
				} catch (_error) {
					/* 空範圍 */
				}
			}
			return r
		}

		/** 由標記記錄在當前 DOM 中定位 Range；找不到回 null。 */
		/** 空白正規化 + 位置映射：norm.text 的每個字符 → hay 的原始偏移。 */
		function normalizeWithMap(hay) {
			let text = ''
			const map = []
			let lastSpace = true // 開頭的空白跳過（等價 trimStart）
			for (let i = 0; i < hay.length; i += 1) {
				const ch = hay[i]
				if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') {
					if (!lastSpace) {
						text += ' '
						map.push(i)
						lastSpace = true
					}
				} else {
					text += ch
					map.push(i)
					lastSpace = false
				}
			}
			// 去尾：映射同步截斷
			while (text.length > 0 && text[text.length - 1] === ' ') {
				text = text.slice(0, -1)
				map.pop()
			}
			return { text, map }
		}

		/** 全局對話文本（懶構建，每次 refreshHighlights 重置）：
		 *  輪次錨失效（分頁/分組重渲染改變了 [data-chat-turn] 容器）時的
		 *  四級後備匹配用的全文範圍。 */
		let globalCache = null
		function globalHay() {
			if (globalCache !== null) return globalCache
			globalCache = { nodes: [], hay: '' }
			try {
				const flow = document.querySelector('[data-chat-flow]')
				if (flow === null || flow === undefined) return globalCache
				const nodes = []
				const walker = document.createTreeWalker(flow, NodeFilter.SHOW_TEXT)
				let n = walker.nextNode()
				while (n !== null) {
					nodes.push(n)
					n = walker.nextNode()
				}
				let hay = ''
				for (const t of nodes) hay += t.nodeValue || ''
				globalCache = { nodes, hay }
			} catch (_error) {
				/* 保留空緩存 */
			}
			return globalCache
		}

		/** 四級定位：輪次內精確 → 輪次內正規化 → 全文精確 → 全文正規化。 */
		function locateMarkRange(mark) {
			try {
				// 1–2 級：輪次範圍內
				const nodes = turnTextNodes(mark.turn)
				if (nodes.length > 0) {
					let hay = ''
					for (const n of nodes) hay += n.nodeValue || ''
					const at = nthOccurrence(hay, mark.quotePlain, mark.occ)
					if (at >= 0) return rangeFromOffsets(nodes, at, at + mark.quotePlain.length)
					const normHit = normalizedHit(nodes, hay, mark.quotePlain)
					if (normHit !== null) return normHit
				}
				// 3–4 級：全文範圍（occ 以輪次為口徑，全局僅取首次出現）
				const g = globalHay()
				if (g.nodes.length === 0) return null
				const gat = g.hay.indexOf(mark.quotePlain)
				if (gat >= 0) return rangeFromOffsets(g.nodes, gat, gat + mark.quotePlain.length)
				return normalizedHit(g.nodes, g.hay, mark.quotePlain)
			} catch (_error) {
				return null
			}
		}

		/** 空白正規化匹配（重渲染後文字節點的空白差異容錯），命中回 Range。 */
		function normalizedHit(nodes, hay, quotePlain) {
			const nq = quotePlain.replace(/\s+/g, ' ').trim()
			if (nq.length < 2) return null
			const norm = normalizeWithMap(hay)
			const nat = norm.text.indexOf(nq)
			if (nat < 0) return null
			const rawStart = norm.map[nat]
			const rawEnd = norm.map[nat + nq.length - 1]
			if (rawStart === undefined || rawEnd === undefined) return null
			return rangeFromOffsets(nodes, rawStart, rawEnd + 1)
		}

		/**
		 * 讀當前選區，若落在助手消息（data-chat-flow-kind="assistant-step"）內，
		 * 構建標記候選；否則 null。
		 */
		function candidateFromSelection() {
			try {
				const sel = window.getSelection()
				if (sel === null || sel === undefined || sel.isCollapsed || sel.rangeCount === 0) return null
				const range = sel.getRangeAt(0)
				if (inExcluded(range.startContainer) || inExcluded(range.endContainer)) return null
				const rect = range.getBoundingClientRect()
				if (rect.width === 0 && rect.height === 0) return null

				const startEl = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
				const nodeBox = startEl !== null && typeof startEl.closest === 'function'
					? startEl.closest('[data-chat-node-key]')
					: null
				if (nodeBox === null) return null
				const kind = nodeBox.getAttribute('data-chat-flow-kind') || ''
				if (kind !== 'assistant-step') return null // 僅助手消息
				const turnRaw = nodeBox.getAttribute('data-chat-turn') || ''
				const turn = Number(turnRaw)
				if (!Number.isFinite(turn)) return null

				const turnNodes = turnTextNodes(turn)
				const data = selectionTextData(range, turnNodes)
				if (data === null) return null
				const quotePlain = data.plain.replace(/\s+$/,'')
				if (quotePlain.trim().length < 2) return null

				// 出現序號：本次選區之前的完整出現次數
				let hay = ''
				for (const n of turnNodes) hay += n.nodeValue || ''
				const occ = countOccurrencesBefore(hay, quotePlain, data.startOffset)

				// 引用 = 精確等於用戶劃選的文字（表格儲存格邊界 tab → 「 | 」，
				// 其餘原樣；不再用結構化重建——用戶 2026-10-05 反饋：顯示的應是
				// 所選的字，不是整段/整表）
				const quote = sel.toString().replace(/\t/g, ' | ').replace(/\s+$/, '')
				return {
					turn,
					nodeKey: nodeBox.getAttribute('data-chat-node-key') || '',
					quote,
					quotePlain,
					occ,
					// 按鈕錨：選區末端（x）+ 末行基線（y）；selLeft 供右緣翻轉
					x: rect.right,
					y: rect.bottom - 26,
					selLeft: rect.left,
				}
			} catch (_error) {
				return null
			}
		}

		// ════════════════════════════════════════════════════════════════
		// 5. 高亮引擎（CSS Custom Highlight API；不支援則只走面板）
		// ════════════════════════════════════════════════════════════════

		const highlightSupported = () =>
			typeof CSS !== 'undefined' && CSS.highlights !== undefined && typeof window.Highlight === 'function'

		/** markId → 當前定位到的 Range（供點擊命中與定位滾動）。 */
		const markRanges = new Map()

		function refreshHighlights() {
			markRanges.clear()
			globalCache = null // 全文緩存隨刷新重建
			const sid = bridge.sessionId
			const hl = highlightSupported()
			if (hl) {
				// 清掉本插件註冊過的所有 highlight 名
				for (const t of TYPES) {
					try {
						CSS.highlights.delete('dsh-markup-' + t.id)
					} catch (_error) {
						/* 忽略 */
					}
				}
				try {
					CSS.highlights.delete('dsh-markup-flash')
				} catch (_error) {
					/* 忽略 */
				}
			}
			if (sid !== '') {
				const byType = new Map()
				for (const mark of marksOf(sid)) {
					const range = locateMarkRange(mark)
					if (range === null) continue
					markRanges.set(mark.id, range)
					if (!byType.has(mark.type)) byType.set(mark.type, [])
					byType.get(mark.type).push(range)
				}
				if (hl) {
					for (const [type, ranges] of byType) {
						try {
							CSS.highlights.set('dsh-markup-' + type, new window.Highlight(...ranges))
						} catch (_error) {
							/* 單類失敗不影響其他 */
						}
					}
				}
			}
			computeRail()
			emitChange()
		}

		// ── 側邊導航軌（Word 式頁邊標記）───────────────────────────
		/** rail.data：{ mark, frac }[]；frac = 標記在滾動內容中的相對位置。 */
		const rail = { scroller: null, data: [] }
		let railHideTimer = null

		function railEnter(id) {
			if (railHideTimer !== null) {
				window.clearTimeout(railHideTimer)
				railHideTimer = null
			}
			ui.railHover = id
			emitChange()
		}

		function railLeave() {
			if (railHideTimer !== null) window.clearTimeout(railHideTimer)
			railHideTimer = window.setTimeout(() => {
				ui.railHover = null
				emitChange()
			}, 180)
		}

		/** 由標記元素向上找對話滾動容器。 */
		function findScroller(el) {
			let n = el
			while (n !== null && n !== undefined && n !== document.body) {
				if (n.scrollHeight > n.clientHeight + 8) return n
				n = n.parentElement
			}
			return document.documentElement
		}

		function computeRail() {
			rail.data = []
			rail.scroller = null
			const sid = bridge.sessionId
			if (sid === '' || markRanges.size === 0) return
			for (const [, range] of markRanges) {
				const el = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
				if (el !== null && el !== undefined) rail.scroller = findScroller(el)
				break
			}
			const sc = rail.scroller ?? document.documentElement
			const scRect = sc.getBoundingClientRect()
			const total = Math.max(sc.scrollHeight, 1)
			for (const mark of marksOf(sid)) {
				const range = markRanges.get(mark.id)
				if (range === undefined) continue
				if (ui.typeFilter !== null && !ui.typeFilter.has(mark.type)) continue
				const rect = range.getBoundingClientRect()
				const docY = sc.scrollTop + (rect.top - scRect.top) + Math.min(rect.height / 2, 24)
				rail.data.push({ mark, frac: clampN(docY / total, 0, 1) })
			}
		}

		function flashMark(mark) {
			if (!highlightSupported()) return
			const range = markRanges.get(mark.id)
			if (range === undefined) return
			try {
				CSS.highlights.set('dsh-markup-flash', new window.Highlight(range))
			} catch (_error) {
				return
			}
			window.setTimeout(() => {
				try {
					CSS.highlights.delete('dsh-markup-flash')
				} catch (_error) {
					/* 忽略 */
				}
			}, 1200)
		}

		function scrollToMark(mark) {
			refreshHighlights()
			const range = markRanges.get(mark.id)
			if (range === undefined) {
				showToast('未能在當前頁面定位這條點評——內容可能尚未載入（滾到該處等 1.5 秒）或已被壓縮')
				return
			}
			const el = range.startContainer !== null
				? (range.startContainer.parentElement || (range.startContainer instanceof Element ? range.startContainer : null))
				: null
			if (el !== null && typeof el.scrollIntoView === 'function') {
				el.scrollIntoView({ behavior: 'smooth', block: 'center' })
			}
			flashMark(mark)
		}

		// ════════════════════════════════════════════════════════════════
		// 6. UI 狀態
		// ════════════════════════════════════════════════════════════════

		const ui = {
			candidate: null, // 劃選候選（浮出按鈕）
			editor: null, // { mode:'create'|'edit', markId?, draft, type, comment, x, y }
			toast: '', // 短提示文案
			toastAt: 0,
			panelPos: null, // 邊欄編輯面板位置 {x, y}（持久化、可拖動）
			railHover: null, // 導航軌上懸停的 markId
			typeFilter: null, // 顯示過濾：Set<typeId> 或 null（不過濾；影響面板行與軌刻度）
		}

		/** 邊欄面板位置持久化（localStorage；不可用則僅本頁記憶）。 */
		const KEY_PANEL = 'dsh-markup/panel/v1'
		function readPanelPos() {
			if (store === null) return ui.panelPos
			try {
				const raw = store.getItem(KEY_PANEL)
				if (raw === null) return null
				const p = JSON.parse(raw)
				if (p === null || typeof p !== 'object' || typeof p.x !== 'number' || typeof p.y !== 'number') return null
				return { x: p.x, y: p.y }
			} catch (_error) {
				return null
			}
		}
		function writePanelPos(pos) {
			if (store === null) return
			try {
				store.setItem(KEY_PANEL, JSON.stringify(pos))
			} catch (_error) {
				/* 忽略 */
			}
		}

		const clampN = (v, lo, hi) => Math.min(Math.max(v, lo), hi)

		/** 邊欄面板拖動：pointer capture + 直接寫 style（避免每幀 re-render）。 */
		const panelDrag = { active: false, sx: 0, sy: 0, ox: 0, oy: 0, moved: false, node: null }
		const panelDragHandlers = {
			onPointerDown: (e) => {
				if (e.button !== undefined && e.button !== 0) return
				const node = panelDrag.node
				if (node === null || node === undefined) return
				e.preventDefault()
				e.stopPropagation()
				panelDrag.active = true
				panelDrag.moved = false
				panelDrag.sx = e.clientX
				panelDrag.sy = e.clientY
				const r = node.getBoundingClientRect()
				panelDrag.ox = r.left
				panelDrag.oy = r.top
				try {
					e.currentTarget.setPointerCapture(e.pointerId)
				} catch (_error) {
					/* 捕獲是優化 */
				}
			},
			onPointerMove: (e) => {
				if (!panelDrag.active || panelDrag.node === null) return
				const dx = e.clientX - panelDrag.sx
				const dy = e.clientY - panelDrag.sy
				if (!panelDrag.moved && Math.abs(dx) + Math.abs(dy) < 4) return
				panelDrag.moved = true
				const node = panelDrag.node
				const x = clampN(panelDrag.ox + dx, 4, Math.max(4, window.innerWidth - node.offsetWidth - 4))
				const y = clampN(panelDrag.oy + dy, 4, Math.max(4, window.innerHeight - 52))
				node.style.left = x + 'px'
				node.style.top = y + 'px'
			},
			onPointerUp: (e) => {
				if (!panelDrag.active) return
				panelDrag.active = false
				try {
					e.currentTarget.releasePointerCapture(e.pointerId)
				} catch (_error) {
					/* 忽略 */
				}
				if (panelDrag.moved && panelDrag.node !== null) {
					const r = panelDrag.node.getBoundingClientRect()
					ui.panelPos = { x: r.left, y: r.top }
					writePanelPos(ui.panelPos)
				}
			},
			onPointerCancel: () => {
				panelDrag.active = false
			},
		}

		/** 邊欄面板默認位置：停靠視窗右緣、垂直對齊選區/點擊處。 */
		function panelDefaultPos(refY) {
			const W = 344
			return {
				x: clampN(window.innerWidth - W - 16, 8, Math.max(8, window.innerWidth - W - 8)),
				y: clampN(refY, 76, Math.max(76, window.innerHeight - 380)),
			}
		}

		function panelCurrentPos(refY) {
			const saved = readPanelPos()
			if (saved !== null) {
				return {
					x: clampN(saved.x, 4, Math.max(4, window.innerWidth - 120)),
					y: clampN(saved.y, 4, Math.max(4, window.innerHeight - 52)),
				}
			}
			return panelDefaultPos(refY)
		}

		function showToast(text) {
			ui.toast = text
			ui.toastAt = Date.now()
			emitChange()
			window.setTimeout(() => {
				if (Date.now() - ui.toastAt >= 2400) {
					ui.toast = ''
					emitChange()
				}
			}, 2600)
		}

		function openCreateEditor() {
			if (ui.candidate === null) return
			ui.editor = {
				mode: 'create',
				markId: undefined,
				draft: ui.candidate,
				type: 'disagree',
				comment: '',
				x: ui.candidate.x,
				y: ui.candidate.y,
			}
			ui.panelPos = panelCurrentPos(ui.candidate.y)
			ui.candidate = null
			emitChange()
		}

		function openEditEditor(mark, x, y) {
			ui.editor = {
				mode: 'edit',
				markId: mark.id,
				draft: { turn: mark.turn, nodeKey: mark.nodeKey, quote: mark.quote, quotePlain: mark.quotePlain, occ: mark.occ, x: 0, y: 0 },
				type: mark.type,
				comment: mark.comment,
				x: x ?? window.innerWidth - 380,
				y: y ?? 80,
			}
			ui.panelPos = panelCurrentPos(y ?? mark.turn * 0 + 120)
			emitChange()
		}

		function closeEditor() {
			ui.editor = null
			emitChange()
		}

		function saveEditor() {
			const ed = ui.editor
			if (ed === null) return
			const sid = bridge.sessionId
			const comment = ed.comment.trim()
			if (comment === '') {
				showToast('請填寫意見（或點「其他」並簡述）')
				return
			}
			if (ed.mode === 'create') {
				const list = marksOf(sid)
				const mark = {
					id: 'm' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
					turn: ed.draft.turn,
					nodeKey: ed.draft.nodeKey,
					quote: ed.draft.quote,
					quotePlain: ed.draft.quotePlain,
					occ: ed.draft.occ,
					type: ed.type,
					comment,
					created: Date.now(),
				}
				saveMark(sid, mark)
				showToast('✓ 已標記 #' + (list.length + 1) + '（' + typeOf(ed.type).label + '）')
			} else if (ed.markId !== undefined) {
				const prev = marksOf(sid).find((m) => m.id === ed.markId)
				if (prev !== undefined) {
					saveMark(sid, { ...prev, type: ed.type, comment })
					showToast('✓ 點評已更新')
				}
			}
			ui.editor = null
			try {
				window.getSelection().removeAllRanges()
			} catch (_error) {
				/* 忽略 */
			}
			refreshHighlights()
			emitChange()
		}

		// ════════════════════════════════════════════════════════════════
		// 7. 組裝點評消息
		// ════════════════════════════════════════════════════════════════

		function blockquote(text) {
			return text
				.replace(/\r\n/g, '\n')
				.split('\n')
				.map((line) => '> ' + line)
				.join('\n')
		}

		function composeMessage(marks) {
			// 模板規範（用戶 2026-10-05 反饋「插入輸入框後 md 渲染不對」）：
			// 1) 所有塊之間必須空行分隔——「> 引用行」後直接跟文字會被 markdown
			//    的惰性續行（lazy continuation）吞進引用塊；2) 不用 **粗體** 裝飾
			//    ——composer 是純文本，符號會原樣顯示。
			const lines = []
			lines.push('我對你先前回覆的 ' + marks.length + ' 處片段有點評，請逐條對應處理：')
			lines.push('')
			for (let i = 0; i < marks.length; i += 1) {
				const mark = marks[i]
				const meta = typeOf(mark.type)
				lines.push((i + 1) + '.〔' + meta.label + '〕第 ' + mark.turn + ' 輪回覆')
				lines.push('')
				lines.push(blockquote(mark.quote))
				lines.push('')
				lines.push('意見：' + mark.comment.replace(/\r\n/g, '\n'))
				lines.push('')
			}
			lines.push('（以上由 Markup 劃選點評生成；請先確認你對每一處引用的理解，再逐條回應——同意並修改、解釋，或提出異議，編號對應上面的點評。）')
			return lines.join('\n')
		}

		// ════════════════════════════════════════════════════════════════
		// 8. 樣式
		// ════════════════════════════════════════════════════════════════

		function installStyles() {
			const tag = document.createElement('style')
			tag.setAttribute('data-dsh-markup', 'styles')
			tag.textContent = [
				// 高亮（CSS Custom Highlight API；後備瀏覽器不支持時只是不高亮）
				'::highlight(dsh-markup-disagree) { background-color: rgba(229, 83, 61, .30); text-decoration: underline 2px rgba(229, 83, 61, .95); }',
				'::highlight(dsh-markup-unclear) { background-color: rgba(217, 148, 19, .32); text-decoration: underline 2px rgba(217, 148, 19, .95); }',
				'::highlight(dsh-markup-suggest) { background-color: rgba(59, 130, 246, .26); text-decoration: underline 2px rgba(59, 130, 246, .95); }',
				'::highlight(dsh-markup-question) { background-color: rgba(139, 92, 246, .26); text-decoration: underline 2px rgba(139, 92, 246, .95); }',
				'::highlight(dsh-markup-other) { background-color: rgba(128, 132, 140, .30); text-decoration: underline 2px rgba(128, 132, 140, .95); }',
				'::highlight(dsh-markup-flash) { background-color: rgba(255, 191, 0, .55); }',
				// 面板/彈窗動畫
				'@keyframes dshMarkupPop { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }',
				'.dsh-markup-pop { animation: dshMarkupPop .14s ease-out; }',
			].join('\n')
			document.head.appendChild(tag)
			return () => {
				try {
					tag.remove()
				} catch (_error) {
					/* 忽略 */
				}
			}
		}

		// ════════════════════════════════════════════════════════════════
		// 9. 全局監聽（選區按鈕、DOM 變化重定位、高亮點擊）
		// ════════════════════════════════════════════════════════════════

		function installSelectionWatcher() {
			let hideTimer = null
			// 拖動進行中（pointer 按下）不評估、不顯示——按鈕只在選區
			// 手勢完成（pointerup / keyup）後浮現，避免拖動時按鈕跟跳
			let dragging = false

			const update = (e) => {
				if (ui.editor !== null) return // 編輯器開著：不搶戲
				if (dragging) return
				const target = e !== undefined && e !== null && e.target instanceof Element ? e.target : null
				if (target !== null && typeof target.closest === 'function' && target.closest(OWN_SELECTOR) !== null) return
				const next = candidateFromSelection()
				if (next === null) {
					// 延遲清除：給 pointerdown → click 之間的選區保持留出餘裕
					if (hideTimer !== null) window.clearTimeout(hideTimer)
					hideTimer = window.setTimeout(() => {
						ui.candidate = null
						emitChange()
					}, 160)
					return
				}
				if (hideTimer !== null) {
					window.clearTimeout(hideTimer)
					hideTimer = null
				}
				const prev = ui.candidate
				if (prev !== null && prev.quotePlain === next.quotePlain && prev.turn === next.turn && Math.abs(prev.x - next.x) < 2 && Math.abs(prev.y - next.y) < 2) return
				ui.candidate = next
				emitChange()
			}

			const onPointerDown = (e) => {
				const target = e.target instanceof Element ? e.target : null
				if (target !== null && typeof target.closest === 'function' && target.closest(OWN_SELECTOR) !== null) return
				dragging = true
			}

			const onPointerUp = (e) => {
				dragging = false
				update(e)
			}

			const onKey = (e) => {
				if (e.key === 'Escape') {
					if (ui.editor !== null) closeEditor()
					else {
						ui.candidate = null
						emitChange()
					}
				}
			}

			const onResize = () => {
				ui.candidate = null
				emitChange()
			}

			document.addEventListener('pointerdown', onPointerDown)
			document.addEventListener('pointerup', onPointerUp)
			document.addEventListener('pointercancel', onPointerUp)
			document.addEventListener('keyup', update)
			document.addEventListener('keydown', onKey)
			window.addEventListener('resize', onResize)
			return () => {
				document.removeEventListener('pointerdown', onPointerDown)
				document.removeEventListener('pointerup', onPointerUp)
				document.removeEventListener('pointercancel', onPointerUp)
				document.removeEventListener('keyup', update)
				document.removeEventListener('keydown', onKey)
				window.removeEventListener('resize', onResize)
				if (hideTimer !== null) window.clearTimeout(hideTimer)
				ui.candidate = null
			}
		}

		function installHighlightObserver() {
			let timer = null
			const schedule = () => {
				if (timer !== null) window.clearTimeout(timer)
				timer = window.setTimeout(() => {
					timer = null
					refreshHighlights()
				}, 450)
			}
			const observer = new MutationObserver(schedule)
			observer.observe(document.body, { childList: true, subtree: true, characterData: true })
			window.addEventListener('scroll', schedule, { passive: true, capture: true })
			window.addEventListener('dsh-markup:refresh', schedule)
			// 週期性兜底重定位：分頁虛擬化載入、折疊展開等任何觀察器漏掉的
			// 渲染路徑，都會在下一個週期補上高亮（無標記時刷新本身就是空操作）
			const interval = window.setInterval(() => {
				refreshHighlights()
			}, 1500)
			refreshHighlights()
			return () => {
				observer.disconnect()
				window.removeEventListener('scroll', schedule, { capture: true })
				window.removeEventListener('dsh-markup:refresh', schedule)
				if (timer !== null) window.clearTimeout(timer)
				window.clearInterval(interval)
			}
		}

		function installHighlightClicks() {
			const onPointerDown = (e) => {
				if (ui.editor !== null) return
				const target = e.target
				if (!(target instanceof Element)) return
				if (inExcluded(target)) return
				if (markRanges.size === 0) return
				let point = null
				if (typeof document.caretRangeFromPoint === 'function') {
					point = document.caretRangeFromPoint(e.clientX, e.clientY)
				} else if (typeof document.caretPositionFromPoint === 'function') {
					const cp = document.caretPositionFromPoint(e.clientX, e.clientY)
					if (cp !== null) {
						point = document.createRange()
						try {
							point.setStart(cp.offsetNode, cp.offset)
						} catch (_error) {
							point = null
						}
					}
				}
				if (point === null) return
				const sid = bridge.sessionId
				for (const mark of marksOf(sid)) {
					const range = markRanges.get(mark.id)
					if (range === undefined) continue
					try {
						if (range.isPointInRange(point.startContainer, point.startOffset)) {
							e.preventDefault()
							e.stopPropagation()
							openEditEditor(mark, e.clientX, e.clientY)
							return
						}
					} catch (_error) {
						/* 忽略單點 */
					}
				}
			}
			document.addEventListener('pointerdown', onPointerDown, true)
			return () => {
				document.removeEventListener('pointerdown', onPointerDown, true)
			}
		}

		// ════════════════════════════════════════════════════════════════
		// 10. 組件
		// ════════════════════════════════════════════════════════════════

		const Z = 72 // 高於一般內容，低於官方 modal

		const btnStyle = {
			position: 'fixed',
			zIndex: Z,
			display: 'flex',
			alignItems: 'center',
			gap: 4,
			padding: '4px 10px',
			borderRadius: 999,
			cursor: 'pointer',
			background: 'var(--dsw-alias-bg-layer-1, #fff)',
			color: 'var(--dsw-alias-label-primary, #1f2328)',
			border: '1px solid var(--dsw-alias-border-l1, #d8dce3)',
			boxShadow: 'var(--dsw-shadow-lv2, 0 4px 16px rgba(0,0,0,.25))',
			fontSize: 12,
			fontWeight: 600,
			userSelect: 'none',
			touchAction: 'none',
		}

		const toastStyle = {
			position: 'fixed',
			zIndex: Z + 2,
			left: '50%',
			bottom: 108,
			transform: 'translateX(-50%)',
			padding: '6px 12px',
			borderRadius: 8,
			fontSize: 12,
			background: 'var(--dsw-alias-bg-layer-1, #fff)',
			color: 'var(--dsw-alias-label-primary, #1f2328)',
			border: '1px solid var(--dsw-alias-border-l1, #d8dce3)',
			boxShadow: 'var(--dsw-shadow-lv2, 0 4px 16px rgba(0,0,0,.25))',
		}

		/** 編輯彈窗：類型 chips + 引用預覽 + 意見輸入。 */
		function MarkupEditor() {
			useForce()
			const ed = ui.editor
			const [comment, setComment] = React.useState(ed === null ? '' : ed.comment)
			React.useEffect(() => {
				setComment(ed === null ? '' : ed.comment)
			}, [ed])
			if (ed === null) return null

			const meta = typeOf(ed.type)
			const W = 344
			const pos = ui.panelPos ?? panelDefaultPos(ed.y)
			const x = clampN(pos.x, 4, Math.max(4, window.innerWidth - W - 8))
			const y = clampN(pos.y, 4, Math.max(4, window.innerHeight - 52))

			const chip = (t) =>
				h('button', {
					key: t.id,
					'data-dsh-markup-ui': '1',
					style: {
						padding: '3px 10px',
						borderRadius: 999,
						fontSize: 12,
						fontWeight: 600,
						cursor: 'pointer',
						border: '1px solid ' + (ed.type === t.id ? t.color : 'var(--dsw-alias-border-l1, #d8dce3)'),
						color: ed.type === t.id ? '#fff' : t.color,
						background: ed.type === t.id ? t.color : 'transparent',
					},
					onClick: (e) => {
						e.preventDefault()
						e.stopPropagation()
						ed.type = t.id
						emitChange()
					},
				}, t.label)

			return h('div', {
				'data-dsh-markup-ui': '1',
				className: 'dsh-markup-pop',
				ref: (node) => {
					panelDrag.node = node
				},
				style: {
					position: 'fixed',
					left: x,
					top: y,
					zIndex: Z + 1,
					width: W,
					maxWidth: 'calc(100vw - 16px)',
					borderRadius: 12,
					background: 'var(--dsw-alias-bg-layer-1, #fff)',
					border: '1px solid var(--dsw-alias-border-l1, #d8dce3)',
					boxShadow: 'var(--dsw-shadow-lv3, 0 12px 40px rgba(0,0,0,.35))',
					padding: '0 12px 10px',
					display: 'flex',
					flexDirection: 'column',
					gap: 8,
					fontSize: 12,
					color: 'var(--dsw-alias-label-primary, #1f2328)',
				},
				onPointerDown: (e) => {
					// 保住底層選區（create 模式下視覺引用仍在）；拖動柄自行 stopPropagation
					e.preventDefault()
				},
			},
				h('div', {
					'data-dsh-markup-ui': '1',
					style: {
						display: 'flex',
						alignItems: 'center',
						gap: 6,
						margin: '0 -12px',
						padding: '8px 12px',
						borderBottom: '1px solid var(--dsw-alias-border-l1, #e6e8ec)',
						cursor: 'grab',
						touchAction: 'none',
						userSelect: 'none',
					},
					title: '拖動移動面板',
					...panelDragHandlers,
				},
					h('span', { style: { color: 'var(--dsw-alias-label-tertiary, #9aa0a6)', fontSize: 11 } }, '⠿'),
					h('span', { style: { fontWeight: 700, fontSize: 12 } }, '✎ Markup 點評'),
					h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, flex: 1 } }, '第 ' + ed.draft.turn + ' 輪回覆' + (ed.mode === 'edit' ? ' · 編輯' : '')),
					h('span', { style: { color: 'var(--dsw-alias-label-tertiary, #9aa0a6)', fontSize: 10 } }, '可拖動'),
				),
				h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } }, TYPES.map(chip)),
				h('div', {
					style: {
						maxHeight: 130,
						overflow: 'auto',
						padding: '6px 9px',
						borderRadius: 8,
						background: 'var(--dsw-alias-bg-base, #f6f7f9)',
						border: '1px solid var(--dsw-alias-border-l1, #d8dce3)',
						whiteSpace: 'pre-wrap',
						wordBreak: 'break-word',
						fontSize: 11,
						lineHeight: 1.55,
						color: 'var(--dsw-alias-label-secondary)',
						fontStyle: 'italic',
					},
				},
					h('span', { style: { color: meta.color, fontWeight: 700, fontStyle: 'normal' } }, '「' + meta.label + '」引用你所選文字：'),
					'\n',
					ed.draft.quote.slice(0, 500) + (ed.draft.quote.length > 500 ? '…' : ''),
				),
				h('textarea', {
					'data-dsh-markup-ui': '1',
					ref: (node) => {
						if (node !== null && ed.mode === 'create') {
							try {
								node.focus()
							} catch (_error) {
								/* 忽略 */
							}
						}
					},
					value: comment,
					placeholder: '我的意見（必填）：這裡我不同意 / 沒看懂 / 想改成…',
					onChange: (e) => {
						setComment(e.target.value)
						ed.comment = e.target.value
					},
					onKeyDown: (e) => {
						if (e.key === 'Escape') {
							e.preventDefault()
							closeEditor()
						}
						if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
							e.preventDefault()
							saveEditor()
						}
					},
					style: {
						width: '100%',
						boxSizing: 'border-box',
						minHeight: 64,
						resize: 'vertical',
						borderRadius: 8,
						border: '1px solid var(--dsw-alias-border-l1, #d8dce3)',
						background: 'var(--dsw-alias-bg-base, #f6f7f9)',
						color: 'var(--dsw-alias-label-primary, #1f2328)',
						padding: '7px 9px',
						fontSize: 12,
						lineHeight: 1.55,
						fontFamily: 'inherit',
					},
				}),
				h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' } },
					h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary, #9aa0a6)', marginRight: 'auto' } }, '⌘/Ctrl+Enter 保存'),
					h('button', {
						'data-dsh-markup-ui': '1',
						style: { padding: '5px 12px', borderRadius: 8, fontSize: 12, cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l1, #d8dce3)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)' },
						onClick: (e) => {
							e.preventDefault()
							closeEditor()
						},
					}, '取消'),
					h('button', {
						'data-dsh-markup-ui': '1',
						style: { padding: '5px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid ' + meta.color, background: meta.color, color: '#fff' },
						onClick: (e) => {
							e.preventDefault()
							e.stopPropagation()
							saveEditor()
						},
					}, '保存標記'),
				),
			)
		}

		/** shell.overlay 條目：劃選按鈕 + 編輯彈窗 + toast。 */
		/**
		 * 側邊導航軌（shell.overlay 條目的一部分）：右緣細軌 + 每條標記一枚
		 * 彩色刻度（位置 = 文檔內相對位置）。懸停刻度 → 同高度左側彈出邊注卡
		 * （Word 式頁邊備注）；點擊 → 滾動到原文並閃爍。
		 */
		function MarkupRail() {
			useForce()
			const data = rail.data
			if (data.length === 0) return null
			const vh = window.innerHeight
			// 與右側系統滾動條鏡像對稱（用戶 2026-10-05 反饋）：貼齊對話區
			// 最左緣、全高、細軌；刻度為滾動條 thumb 式圓角塊、按類型着色
			let scRect = null
			if (rail.scroller !== null && typeof rail.scroller.getBoundingClientRect === 'function') {
				scRect = rail.scroller.getBoundingClientRect()
			}
			const x = scRect !== null ? Math.max(2, Math.round(scRect.left) + 2) : 8
			const top = scRect !== null ? Math.round(scRect.top) + 4 : Math.round(vh * 0.18)
			const height = scRect !== null ? Math.max(80, Math.round(scRect.height) - 8) : Math.round(vh * 0.64)

			const hovered = data.find((d) => d.mark.id === ui.railHover)
			const tickY = (frac) => Math.round(top + frac * height)

			return h(React.Fragment, null,
				// 軌道（不可交互的細線，對稱於右側滾動條）
				h('div', {
					'data-dsh-markup-ui': '1',
					style: {
						position: 'fixed', left: x + 3, top, width: 3, height,
						borderRadius: 2, zIndex: Z - 1, pointerEvents: 'none',
						background: 'var(--dsw-alias-border-l2, rgba(128,132,140,.15))',
					},
				}),
				data.map((d) => {
					const meta = typeOf(d.mark.type)
					// 刻度 = 滾動條 thumb 式窄長膠囊：寬 5px、高按引用長度伸縮，
					// 與右側系統滾動條鏡像對稱（橫向細窄、縱向居中延展）
					const hoveredNow = ui.railHover === d.mark.id
					const len = Math.max(14, Math.min(30, Math.round((d.mark.quotePlain || d.mark.quote || '').length / 6)))
					return h('div', {
						key: d.mark.id,
						'data-dsh-markup-ui': '1',
						style: {
							position: 'fixed',
							left: hoveredNow ? x - 1 : x + 1,
							top: Math.round(tickY(d.frac) - len / 2),
							width: hoveredNow ? 7 : 5,
							height: len,
							borderRadius: 3,
							zIndex: Z,
							background: meta.color,
							opacity: hoveredNow ? 1 : 0.78,
							transition: 'width .12s ease, opacity .12s ease',
							cursor: 'pointer', touchAction: 'none',
						},
						title: '〔' + meta.label + '〕第 ' + d.mark.turn + ' 輪 · ' + d.mark.comment.slice(0, 40),
						onPointerEnter: () => railEnter(d.mark.id),
						onPointerLeave: railLeave,
						onClick: (e) => {
							e.preventDefault()
							e.stopPropagation()
							scrollToMark(d.mark)
						},
					})
				}),
				hovered !== undefined
					? h('div', {
						'data-dsh-markup-ui': '1',
						className: 'dsh-markup-pop',
						style: {
							position: 'fixed',
							left: clampN(x + 14, 8, Math.max(8, window.innerWidth - 268)),
							top: clampN(tickY(hovered.frac) - 26, 8, Math.max(8, vh - 230)),
							width: 250, zIndex: Z + 1,
							borderRadius: 10,
							background: 'var(--dsw-alias-bg-layer-1, #fff)',
							border: '1px solid var(--dsw-alias-border-l1, #d8dce3)',
							borderLeft: '3px solid ' + typeOf(hovered.mark.type).color,
							boxShadow: 'var(--dsw-shadow-lv3, 0 12px 40px rgba(0,0,0,.35))',
							padding: '8px 10px',
							fontSize: 11,
							color: 'var(--dsw-alias-label-primary, #1f2328)',
							display: 'flex',
							flexDirection: 'column',
							gap: 5,
						},
						onPointerEnter: () => railEnter(hovered.mark.id),
						onPointerLeave: railLeave,
					},
						h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
							h('span', { style: { fontSize: 10, fontWeight: 700, color: '#fff', background: typeOf(hovered.mark.type).color, borderRadius: 5, padding: '1px 6px', flex: 'none' } }, typeOf(hovered.mark.type).label),
							h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary, #9aa0a6)' } }, '第 ' + hovered.mark.turn + ' 輪回覆'),
						),
						h('div', {
							style: {
								maxHeight: 40, overflow: 'hidden', fontStyle: 'italic',
								color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.45,
							},
						}, hovered.mark.quote.replace(/\s+/g, ' ').slice(0, 90) + (hovered.mark.quote.length > 90 ? '…' : '')),
						h('div', { style: { lineHeight: 1.5 } }, hovered.mark.comment),
						h('div', { style: { display: 'flex', gap: 6, justifyContent: 'flex-end' } },
							h('button', {
								'data-dsh-markup-ui': '1',
								style: smallBtn(),
								onClick: (e) => {
									e.preventDefault()
									e.stopPropagation()
									scrollToMark(hovered.mark)
								},
							}, '定位'),
							h('button', {
								'data-dsh-markup-ui': '1',
								style: smallBtn(),
								onClick: (e) => {
									e.preventDefault()
									e.stopPropagation()
									openEditEditor(hovered.mark, undefined, undefined)
								},
							}, '✎ 編輯'),
						),
					)
					: null,
			)
		}

		function MarkupOverlay() {
			useForce()
			const cand = ui.candidate
			return h(React.Fragment, null,
				h(MarkupRail, null),
				cand !== null && ui.editor === null
					? h('div', {
						'data-dsh-markup-ui': '1',
						className: 'dsh-markup-pop',
						style: {
							...btnStyle,
							// 錨在選區末端、末行基線處；右緣放不下翻到選區左側
							left: cand.x + 104 < window.innerWidth
								? Math.max(8, cand.x + 10)
								: Math.max(8, (cand.selLeft ?? window.innerWidth - 120) - 104),
							top: clampN(cand.y, 8, window.innerHeight - 36),
						},
						title: '把選中的片段加入點評（選類型 → 寫意見）',
						onPointerDown: (e) => {
							e.preventDefault()
							e.stopPropagation()
						},
						onClick: (e) => {
							e.preventDefault()
							e.stopPropagation()
							openCreateEditor()
						},
					},
						h('span', null, '✎'),
						h('span', null, 'Markup'),
					)
					: null,
				h(MarkupEditor, null),
				ui.toast !== '' ? h('div', { 'data-dsh-markup-ui': '1', style: toastStyle }, ui.toast) : null,
			)
		}

		// ── composer 上方的點評面板 ────────────────────────────────────

		/** 探測 composer 實際寬度（取編輯區 rect），點評橫條與之同寬。 */
		function composerWidth() {
			try {
				const seat = document.querySelector('[data-conversation-region="composer"]')
				if (seat !== null && seat !== undefined) {
					const editable = seat.querySelector('[contenteditable="true"]')
					if (editable !== null && editable !== undefined) {
						const w = editable.getBoundingClientRect().width
						if (w > 240) return Math.round(w) + 20 // 含內邊距，貼合卡片視覺寬
					}
				}
			} catch (_error) {
				/* 探測失敗用回退寬度 */
			}
			return 760
		}

		const dockCard = {
			borderRadius: 10,
			border: '1px solid var(--dsw-alias-border-l1, #d8dce3)',
			background: 'var(--dsw-alias-bg-layer-1, #fff)',
			padding: '8px 10px',
			fontSize: 12,
			color: 'var(--dsw-alias-label-primary, #1f2328)',
			display: 'flex',
			flexDirection: 'column',
			gap: 6,
			maxWidth: '100%',
			margin: '0 auto',
			boxSizing: 'border-box',
		}
		const smallBtn = (color, extra) => ({
			fontSize: 11,
			padding: '2px 8px',
			borderRadius: 6,
			cursor: 'pointer',
			border: '1px solid var(--dsw-alias-border-l1, #d8dce3)',
			background: 'transparent',
			color: color || 'var(--dsw-alias-label-secondary)',
			flex: 'none',
			...extra,
		})
		const primaryBtn = (color) => ({
			fontSize: 11,
			padding: '4px 12px',
			borderRadius: 8,
			cursor: 'pointer',
			border: '1px solid ' + color,
			background: color,
			color: '#fff',
			fontWeight: 700,
			flex: 'none',
		})

		/** 類型過濾（顯示用：面板行 + 導航軌刻度；null = 不過濾）。 */
		function filterActive(list) {
			if (ui.typeFilter === null) return list
			return list.filter((m) => ui.typeFilter.has(m.type))
		}

		/** 拖動重排：把 dragId 移到 overId 的位置。 */
		function moveMark(sid, dragId, overId) {
			if (dragId === overId) return
			const all = readAll()
			const list = Array.isArray(all[sid]) ? all[sid] : []
			const from = list.findIndex((m) => m.id === dragId)
			const to = list.findIndex((m) => m.id === overId)
			if (from < 0 || to < 0) return
			const [moved] = list.splice(from, 1)
			list.splice(to, 0, moved)
			all[sid] = list
			writeAll(all)
			emitChange()
			refreshHighlights()
		}

		/** 列表行拖動（⠿ 手柄）：pointer capture + elementFromPoint 命中目標行。 */
		const rowDrag = { active: false, sid: '', dragId: null }

		/** 直接發送窗口：此窗口內的 submitting 遷移由本按鈕自己觸發，隨發鉤子跳過。 */
		const directSendGuard = { until: 0 }

		/** 隨發鉤子（用戶 2026-10-05 需求）：用戶在輸入框打字後點擊輸入框自己的
		 *  發送（或 Enter）時，待發點評以排隊消息緊隨其後發出，然後清空。
		 *  依據 InputState.phase 進入 'submitting' 的遷移判定。 */
		const sendWatch = { phase: null }

		function rideAlongOnSubmit(sid, input) {
			if (input === null || typeof input !== 'object' || typeof input.phase !== 'string') return
			const phase = input.phase
			const prev = sendWatch.phase
			sendWatch.phase = phase
			if (prev === null || prev === phase || phase !== 'submitting') return
			if (Date.now() < directSendGuard.until) return
			const pending = filterActive(marksOf(sid))
			if (pending.length === 0) return
			const actions = (bridge.actions && typeof bridge.actions.setDraft === 'function') ? bridge.actions : null
			if (actions === null || typeof actions.submit !== 'function') return
			actions.setDraft(composeMessage(pending))
			clearMarks(sid)
			showToast('✓ 已隨你的消息一起發送 ' + pending.length + ' 處點評')
			refreshHighlights()
			window.setTimeout(() => {
				try {
					actions.submit()
				} catch (_error) {
					showToast('✗ 點評排隊失敗——內容已在輸入框，請手動發送')
				}
			}, 150)
		}
		const rowDragHandlers = {
			onPointerDown: (e, mark) => {
				if (e.button !== undefined && e.button !== 0) return
				e.preventDefault()
				e.stopPropagation()
				rowDrag.active = true
				rowDrag.sid = bridge.sessionId
				rowDrag.dragId = mark.id
				try {
					e.currentTarget.setPointerCapture(e.pointerId)
				} catch (_error) {
					/* 捕獲是優化 */
				}
			},
			onPointerMove: (e) => {
				if (!rowDrag.active) return
				const el = document.elementFromPoint(e.clientX, e.clientY)
				const row = el !== null && typeof el.closest === 'function' ? el.closest('[data-markup-row-id]') : null
				if (row === null) return
				const overId = row.getAttribute('data-markup-row-id')
				if (overId !== null && overId !== rowDrag.dragId) {
					moveMark(rowDrag.sid, rowDrag.dragId, overId)
				}
			},
			onPointerUp: (e) => {
				if (!rowDrag.active) return
				rowDrag.active = false
				rowDrag.dragId = null
				try {
					e.currentTarget.releasePointerCapture(e.pointerId)
				} catch (_error) {
					/* 忽略 */
				}
			},
		}

		function MarkupDock(props) {
			useForce()
			const [open, setOpen] = React.useState(false)
			const [confirmClear, setConfirmClear] = React.useState(false)
			const sid = typeof props.sessionId === 'string' ? props.sessionId : (props.session && typeof props.session.sessionId === 'string' ? props.session.sessionId : '')
			const allMarks = marksOf(sid)
			const marks = filterActive(allMarks)

			// 橋接給 overlay 用（sessionId + 寫入動作）
			bridge.sessionId = sid
			rideAlongOnSubmit(sid, props.input ?? null)
			if (bridge.actions === null && props.inputActions && typeof props.inputActions.setDraft === 'function') {
				bridge.actions = {
					setDraft: (text) => props.inputActions.setDraft(text),
					submit: typeof props.inputActions.submit === 'function' ? () => props.inputActions.submit() : null,
				}
			}
			React.useEffect(() => {
				refreshHighlights()
			}, [sid, allMarks.length])

			if (sid === '' || allMarks.length === 0) return null

			const actions = (bridge.actions && typeof bridge.actions.setDraft === 'function')
				? bridge.actions
				: (props.inputActions && typeof props.inputActions.setDraft === 'function' ? props.inputActions : null)
			const draft = props.input && typeof props.input.draft === 'string' ? props.input.draft : ''

			const consumeMarks = (noun) => {
				clearMarks(sid)
				refreshHighlights()
				showToast('✓ 已' + noun + '，點評已清空')
			}

			const insertToDraft = () => {
				if (marks.length === 0) {
					showToast('目前過濾下沒有可見點評——請先顯示至少一種類型')
					return
				}
				if (actions === null) {
					showToast('✗ 輸入框動作不可用——已複製到剪貼板')
					try {
						navigator.clipboard.writeText(composeMessage(marks))
					} catch (_error) {
						/* 忽略 */
					}
					return
				}
				const msg = composeMessage(marks)
				actions.setDraft(draft.trim() !== '' ? draft.replace(/\s+$/, '') + '\n\n---\n\n' + msg : msg)
				consumeMarks('插入輸入框')
			}

			const sendNow = () => {
				if (marks.length === 0) {
					showToast('目前過濾下沒有可見點評——請先顯示至少一種類型')
					return
				}
				if (actions === null || typeof actions.submit !== 'function') {
					insertToDraft()
					return
				}
				actions.setDraft(composeMessage(marks))
				showToast('正在發送點評…')
				// 先清空再提交：送出即消費，且避免 submitting 遷移的隨發鉤子重複發送
				consumeMarks('發送')
				directSendGuard.until = Date.now() + 1500
				window.setTimeout(() => {
					try {
						actions.submit()
					} catch (_error) {
						showToast('✗ 發送失敗——內容已在輸入框，請手動發送')
					}
				}, 90)
			}

			const row = (mark, i) => {
				const meta = typeOf(mark.type)
				const snippet = mark.quote.replace(/\s+/g, ' ').slice(0, 66)
				return h('div', {
					key: mark.id,
					'data-markup-row-id': mark.id,
					style: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 0', borderTop: '1px solid var(--dsw-alias-border-l1, #e6e8ec)' },
				},
					h('span', {
						'data-dsh-markup-ui': '1',
						title: '拖動調整順序（編號隨之更新）',
						style: { color: 'var(--dsw-alias-label-tertiary, #9aa0a6)', cursor: 'grab', flex: 'none', paddingTop: 2, fontSize: 11, touchAction: 'none', userSelect: 'none' },
						onPointerDown: (e) => rowDragHandlers.onPointerDown(e, mark),
						onPointerMove: rowDragHandlers.onPointerMove,
						onPointerUp: rowDragHandlers.onPointerUp,
					}, '⠿'),
					h('span', {
						style: { color: meta.color, fontWeight: 800, fontSize: 11, flex: 'none', paddingTop: 1 },
						title: markRanges.has(mark.id) ? '已定位（高亮應顯示）' : '未定位：內容未載入或已變動',
					}, (markRanges.has(mark.id) ? '●' : '○') + '#' + (i + 1)),
					h('div', { style: { flex: 1, minWidth: 0 } },
						h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 2 } },
							h('span', { style: { fontSize: 10, fontWeight: 700, color: '#fff', background: meta.color, borderRadius: 5, padding: '1px 6px', flex: 'none' } }, meta.label),
							h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary, #9aa0a6)', flex: 'none' } }, '第 ' + mark.turn + ' 輪'),
							h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, snippet),
						),
						h('div', { style: { fontSize: 11, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' } },
							h('span', { style: { color: 'var(--dsw-alias-label-tertiary, #9aa0a6)' } }, '意見：'),
							mark.comment,
						),
					),
					h('div', { style: { display: 'flex', gap: 4, flex: 'none' } },
						h('button', {
							'data-dsh-markup-ui': '1',
							style: smallBtn(),
							title: '滾動到原文並閃爍高亮',
							onClick: () => scrollToMark(mark),
						}, '定位'),
						h('button', {
							'data-dsh-markup-ui': '1',
							style: smallBtn(),
							title: '編輯類型與意見',
							onClick: (e) => openEditEditor(mark, e.clientX, e.clientY),
						}, '✎'),
						h('button', {
							'data-dsh-markup-ui': '1',
							style: smallBtn('var(--dsw-alias-state-error-primary, #e5533d)'),
							title: '刪除這條點評',
							onClick: () => {
								deleteMark(sid, mark.id)
								refreshHighlights()
							},
						}, '✕'),
					),
				)
			}

			return h('div', { 'data-dsh-markup-ui': '1', style: { ...dockCard, width: Math.round(composerWidth() * 0.9) } },
				h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
					h('button', {
						'data-dsh-markup-ui': '1',
						style: { ...smallBtn('var(--dsw-alias-label-primary)'), fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4 },
						onClick: () => {
							setOpen(!open)
							setConfirmClear(false)
						},
					},
						h('span', null, '🏷'),
						h('span', null, 'Markup 點評 ' + marks.length + (ui.typeFilter !== null ? '/' + allMarks.length : '') + ' 處'),
						h('span', { style: { fontSize: 9, color: 'var(--dsh-alias-label-tertiary)' } }, open ? '▲' : '▼'),
					),
					h('span', { style: { fontSize: 10, color: 'var(--dsh-alias-label-tertiary, #9aa0a6)', flex: 1 } }, '在上方回覆中劃選文字即可新增點評；⠿ 可拖動排序'),
					confirmClear
						? h('button', {
							'data-dsh-markup-ui': '1',
							style: smallBtn('var(--dsw-alias-state-error-primary, #e5533d)', { fontWeight: 700 }),
							onClick: () => {
								clearMarks(sid)
								refreshHighlights()
								setConfirmClear(false)
								setOpen(false)
								showToast('已清空本 session 的點評')
							},
						}, '確認清空？')
						: h('button', {
							'data-dsh-markup-ui': '1',
							style: smallBtn(),
							title: '刪除本 session 的全部點評',
							onClick: () => setConfirmClear(true),
						}, '清空'),
					h('button', {
						'data-dsh-markup-ui': '1',
						style: smallBtn(),
						title: '把全部點評組裝成引用消息，追加到輸入框草稿（可補充總述再發送）',
						onClick: insertToDraft,
					}, '⤴ 插入輸入框'),
					h('button', {
						'data-dsh-markup-ui': '1',
						style: primaryBtn('#3b82f6'),
						title: '組裝點評消息並立即發送到本對話',
						onClick: sendNow,
					}, '直接發送'),
				),
				open
					? h('div', null,
						// 類型過濾 chips（顯示過濾：面板行 + 側邊軌刻度；發送內容以所見為準）
						h('div', { style: { display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', padding: '2px 0 6px' } },
							h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary, #9aa0a6)', flex: 'none' } }, '類型：'),
							TYPES.filter((t) => allMarks.some((m) => m.type === t.id)).map((t) => {
								const on = ui.typeFilter === null || ui.typeFilter.has(t.id)
								return h('button', {
									key: t.id,
									'data-dsh-markup-ui': '1',
									style: {
										fontSize: 10, fontWeight: 600, cursor: 'pointer', flex: 'none',
										padding: '1px 7px', borderRadius: 999,
										border: '1px solid ' + (on ? t.color : 'var(--dsw-alias-border-l1, #d8dce3)'),
										color: on ? t.color : 'var(--dsw-alias-label-tertiary, #9aa0a6)',
										background: 'transparent',
										opacity: on ? 1 : 0.55,
									},
									title: on ? '點擊隱藏此類型' : '點擊顯示此類型',
									onClick: (e) => {
										e.preventDefault()
										e.stopPropagation()
										if (ui.typeFilter === null) {
											ui.typeFilter = new Set(TYPES.map((x) => x.id))
										}
										if (ui.typeFilter.has(t.id)) ui.typeFilter.delete(t.id)
										else ui.typeFilter.add(t.id)
										if (ui.typeFilter.size === TYPES.length) ui.typeFilter = null
										emitChange()
										refreshHighlights()
									},
								}, t.label)
							}),
						),
						marks.length === 0
							? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9aa0a6)', padding: '6px 0' } }, '目前類型過濾下沒有可見點評——發送按鈕會以可見點評為準，請至少顯示一種類型。')
							: marks.map((mark, i) => row(mark, i)),
					)
					: null,
			)
		}

		// ════════════════════════════════════════════════════════════════
		// 11. apply：註冊槽位 + 安裝全局監聽
		// ════════════════════════════════════════════════════════════════

		function apply(ctx) {
			const slots = ctx.slots
			if (slots === undefined || slots === null) {
				console.error('[dsh-markup] slots 服務不可用，插件未激活')
				return
			}

			const disposeStyles = typeof ctx.effect === 'function'
				? ctx.effect(() => installStyles(), 'markup: stylesheet')
				: installStyles()
			const disposeWatch = typeof ctx.effect === 'function'
				? ctx.effect(() => installSelectionWatcher(), 'markup: selection')
				: installSelectionWatcher()
			const disposeObs = typeof ctx.effect === 'function'
				? ctx.effect(() => installHighlightObserver(), 'markup: highlights')
				: installHighlightObserver()
			const disposeClicks = typeof ctx.effect === 'function'
				? ctx.effect(() => installHighlightClicks(), 'markup: highlight-clicks')
				: installHighlightClicks()
			void disposeStyles
			void disposeWatch
			void disposeObs
			void disposeClicks

			// dock 條目：拿 sessionId 與輸入框動作（inject hook 走官方服務路由，
			// 與 conversation-queue-dock 同款；props.inputActions 為後備）
			slots.inject('conversation.input.dock', () =>
				slots.register({
					name: 'conversation.input.dock',
					id: 'markup-dock',
					order: 26,
					label: 'Markup 點評',
					inject: (sessionId) => {
						try {
							if (typeof sessionId !== 'string' || sessionId === '' || ctx.sessions === undefined) return {}
							const actx = ctx.sessions.scope(sessionId)
							if (actx === undefined) return {}
							const conversation = actx.get('conversation')
							if (conversation === undefined || conversation.input === undefined) return {}
							const shell = conversation.input.for(actx)
							if (shell === undefined || shell.actions === undefined) return {}
							bridge.actions = {
								setDraft: (text) => shell.actions.setDraft(text),
								submit: typeof shell.actions.submit === 'function' ? () => shell.actions.submit() : null,
							}
							return { markupReady: true }
						} catch (_error) {
							return {}
						}
					},
				}, MarkupDock),
			)

			// overlay 條目：劃選按鈕 + 編輯彈窗
			slots.inject('shell.overlay', () =>
				slots.register({ name: 'shell.overlay', id: 'markup-button', order: 12, label: '劃選點評' }, MarkupOverlay),
			)
		}

		const exports = {}
		/** 測試出口：純字符串函數與錨定函數（後者需先設好 global.document），供 Node 端回歸測試。 */
		exports.__test = {
			blockquote, composeMessage, countOccurrencesBefore, nthOccurrence, TYPES,
			turnTextNodes, selectionTextData, locateMarkRange, rangeFromOffsets,
			setEditorState: (ed) => { ui.editor = ed; ui.panelPos = panelCurrentPos(ed.y) },
		}
		exports.name = 'markup'
		exports.inject = ['slots', 'sessions']
		exports.apply = apply
		return exports
	},
})
