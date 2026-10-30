import type { GroupMetadata } from '../../Types'
import type { ILogger } from '../logger'
import logger from '../logger'

export type GroupMetaCacheOptions = {
	ttlMs?: number
	max?: number
	fetch: (jid: string) => Promise<GroupMetadata>
	logger?: ILogger
}

export const makeGroupMetaCache = (opts: GroupMetaCacheOptions) => {
	const ttlMs = opts.ttlMs ?? 60000
	const max = opts.max ?? 200
	const log = opts.logger ?? logger
	const map = new Map<string, { meta: GroupMetadata; exp: number }>()
	const inflight = new Map<string, Promise<GroupMetadata>>()

	const get = async (jid: string, force = false) => {
		if (!force) {
			const c = map.get(jid)
			if (c && c.exp > Date.now()) return c.meta
		}
		const p = inflight.get(jid)
		if (p) return p
		const np = opts
			.fetch(jid)
			.then(m => {
				map.set(jid, { meta: m, exp: Date.now() + ttlMs })
				if (map.size > max) {
					const first = map.keys().next().value
					if (first) map.delete(first)
				}
				inflight.delete(jid)
				return m
			})
			.catch(e => {
				inflight.delete(jid)
				log.warn({ e, jid }, 'group metadata fetch failed')
				throw e
			})
		inflight.set(jid, np)
		return np
	}

	const set = (jid: string, meta: GroupMetadata) => {
		map.set(jid, { meta, exp: Date.now() + ttlMs })
	}

	const invalidate = (jid: string) => {
		map.delete(jid)
		inflight.delete(jid)
	}

	const clear = () => {
		map.clear()
		inflight.clear()
	}

	const has = (jid: string) => {
		const c = map.get(jid)
		return !!c && c.exp > Date.now()
	}

	return { get, set, invalidate, clear, has, size: () => map.size }
}

export type GroupMetaCache = ReturnType<typeof makeGroupMetaCache>
