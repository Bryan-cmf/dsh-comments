/**
 * dsh-comments — host half.
 *
 * v0.4.0 起 Host 半不再慣性：它擁有標記的**權威持久化**——
 * `~/.dsh/dsh-comments/marks.json`（跨瀏覽器、跨設備、跨刷新），經
 * webServer 路由 `/api/dsh-comments/marks` 供瀏覽器半讀寫：
 *   GET  → 全量 JSON；PUT → 原子替換（上限 2MB）。
 *
 * 背景：瀏覽器 localStorage 在多來源（127.0.0.1 / tunnel 域名）、多瀏覽器、
 * 私密模式下不可靠——用戶 2026-10-05 反饋「刷新後點評全部消失」，
 * leveldb 考證 localStorage 從未寫入成功。Host 端文件存儲徹底解決。
 *
 * v0.6.0 起全面改名為 dsh-comments：資料夾、路由與日誌前綴都換了名字。
 * 舊資料（`~/.dsh/dsh-markup/marks.json`）會在首次讀取時自動搬到新位置，
 * 舊路由 `/api/dsh-markup/marks` 仍保留為別名，讓尚未更新的瀏覽器半繼續運作。
 */

import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Loader entry / diagnostic name. */
export const name = 'comments'

/** webServer 服務（路由註冊）。 */
export const inject = ['webServer']

const DIR = join(homedir(), '.dsh', 'dsh-comments')
const FILE = join(DIR, 'marks.json')
/** Pre-rename location; read once, then copied into DIR. */
const LEGACY_DIR = join(homedir(), '.dsh', 'dsh-markup')
const LEGACY_FILE = join(LEGACY_DIR, 'marks.json')
const MAX_BYTES = 2 * 1024 * 1024

async function readJson(file) {
	try {
		const raw = await fsp.readFile(file, 'utf8')
		const parsed = JSON.parse(raw)
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
		return parsed
	} catch (_error) {
		return null
	}
}

async function readAllFromDisk() {
	const current = await readJson(FILE)
	if (current !== null) return current
	// First read after the rename: fall back to the old file so nothing is lost,
	// even if the copy below could not run.
	return (await readJson(LEGACY_FILE)) ?? {}
}

/** Copy the pre-rename file into DIR once; never overwrite newer data. */
async function migrateLegacy() {
	try {
		const existing = await readJson(FILE)
		if (existing !== null) return
		const legacy = await readJson(LEGACY_FILE)
		if (legacy === null) return
		await fsp.mkdir(DIR, { recursive: true })
		await fsp.writeFile(FILE, JSON.stringify(legacy), 'utf8')
		console.log('[dsh-comments] migrated marks from ~/.dsh/dsh-markup/marks.json')
	} catch (error) {
		console.warn('[dsh-comments] legacy migration skipped:', String((error && error.message) || error))
	}
}

async function writeToDisk(data) {
	await fsp.mkdir(DIR, { recursive: true })
	const tmp = FILE + '.' + process.pid + '.tmp'
	await fsp.writeFile(tmp, JSON.stringify(data), 'utf8')
	await fsp.rename(tmp, FILE)
}

/** Node http 風格的 JSON 回覆（與 dsh-insights 的路由輔助同款）。 */
function sendJson(res, status, value) {
	const body = JSON.stringify(value)
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': String(Buffer.byteLength(body)),
	})
	res.end(body)
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const parts = []
		req.on('data', (c) => parts.push(c))
		req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
		req.on('error', reject)
	})
}

/** One handler shared by the current route and its pre-rename alias. */
async function marksHandler(req, res) {
	try {
		const method = String(req.method || 'GET')
		if (method === 'GET') {
			sendJson(res, 200, await readAllFromDisk())
			return
		}
		if (method === 'PUT') {
			const raw = await readBody(req)
			if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) {
				sendJson(res, 413, { error: 'payload too large' })
				return
			}
			let parsed = {}
			try {
				parsed = JSON.parse(raw)
			} catch (_error) {
				parsed = null
			}
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
				sendJson(res, 400, { error: 'invalid json object' })
				return
			}
			// 滾動備份：覆蓋前留底（保留最近 20 份 auto-*.json）——誤清/壞寫入皆可救
			try {
				const prev = await readAllFromDisk()
				if (Object.keys(prev).length > 0) {
					const stamp = new Date().toISOString().replace(/[:.]/g, '-')
					const bdir = join(DIR, 'backups')
					await fsp.mkdir(bdir, { recursive: true })
					await fsp.writeFile(join(bdir, 'auto-' + stamp + '.json'), JSON.stringify(prev), 'utf8')
					const keep = (await fsp.readdir(bdir)).filter((f) => f.startsWith('auto-')).sort()
					for (const stale of keep.slice(0, Math.max(0, keep.length - 20))) {
						await fsp.rm(join(bdir, stale), { force: true })
					}
				}
			} catch (_backupError) {
				/* 備份失敗不阻塞主寫入 */
			}
			await writeToDisk(parsed)
			sendJson(res, 200, { ok: true })
			return
		}
		sendJson(res, 405, { error: 'method not allowed' })
	} catch (error) {
		sendJson(res, 500, { error: String((error && error.message) || error) })
	}
}

/** 已註冊路由的 disposer（冪等保護：fiber 重啓用時避免 duplicate route 拋錯）。 */
let routeDisposers = null

export function apply(ctx) {
	const webServer = ctx.webServer
	if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
		console.error('[dsh-comments] webServer 服務不可用——標記僅存瀏覽器 localStorage（刷新可能丟失）')
		return
	}

	// 冪等：本模組實例已註冊過 → 直接返回
	if (routeDisposers !== null) return

	migrateLegacy().catch(() => {})

	const disposers = []
	for (const path of ['/api/dsh-comments/marks', '/api/dsh-markup/marks']) {
		try {
			disposers.push(webServer.register({ kind: 'exact', path, handler: marksHandler }))
		} catch (error) {
			const msg = String((error && error.message) || error)
			if (msg.includes('duplicate')) {
				console.warn('[dsh-comments] 路由 ' + path + ' 已由前一實例註冊，沿用既有路由')
				continue
			}
			throw error
		}
	}
	routeDisposers = disposers
}
