import type { Middleware, OutgoingMiddleware } from './middleware'

export interface IdempotencyStore {
	/** Atomically reserve `key`. Returns false when it is already reserved. */
	tryAcquire: (key: string, ttlMs: number) => Promise<boolean>
	release: (key: string) => Promise<void>
}

export type IdempotencyGuardOptions = {
	store: IdempotencyStore
	ttlMs?: number
	now?: () => number
}

export type IdempotencyResult<T> = {
	executed: boolean
	value?: T
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
	private readonly entries = new Map<string, number>()

	constructor(private readonly now: () => number = Date.now) {}

	async tryAcquire(key: string, ttlMs: number): Promise<boolean> {
		const current = this.now()
		const expiresAt = this.entries.get(key)
		if (expiresAt !== undefined && expiresAt > current) {
			return false
		}

		this.entries.set(key, current + Math.max(1, ttlMs))
		return true
	}

	async release(key: string): Promise<void> {
		this.entries.delete(key)
	}

	prune(): number {
		const current = this.now()
		let removed = 0
		for (const [key, expiresAt] of this.entries) {
			if (expiresAt <= current) {
				this.entries.delete(key)
				removed++
			}
		}

		return removed
	}

	size(): number {
		return this.entries.size
	}

	clear(): void {
		this.entries.clear()
	}
}

export const makeIdempotencyGuard = (opts: IdempotencyGuardOptions) => {
	const ttlMs = opts.ttlMs ?? 60_000
	const runOnce = async <T>(key: string, work: () => Promise<T>): Promise<IdempotencyResult<T>> => {
		const acquired = await opts.store.tryAcquire(key, ttlMs)
		if (!acquired) {
			return { executed: false }
		}

		try {
			return { executed: true, value: await work() }
		} catch (error) {
			await opts.store.release(key)
			throw error
		}
	}

	return { runOnce }
}

export type IncomingDedupeOptions = {
	store: IdempotencyStore
	ttlMs?: number
	key?: (message: { key?: { remoteJid?: string | null; id?: string | null } }) => string | undefined
}

/**
 * Stops duplicate incoming messages before the remaining middleware runs.
 */
export const createIncomingDedupeMiddleware = (opts: IncomingDedupeOptions): Middleware => {
	const ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000
	return async ctx => {
		const key =
			opts.key?.(ctx.message) ??
			(ctx.message.key?.id
				? `incoming:${ctx.message.key.remoteJid ?? ctx.jid}:${ctx.message.key.id}`
				: undefined)
		if (!key) {
			return
		}

		if (!(await opts.store.tryAcquire(key, ttlMs))) {
			ctx.stop()
		}
	}
}

export type OutgoingIdempotencyOptions = {
	store: IdempotencyStore
	ttlMs?: number
	key?: (ctx: { jid: string; options?: { messageId?: string } }) => string | undefined
}

/**
 * Cancels an outgoing send when `options.messageId` has already been used.
 * Messages without an explicit id are left untouched.
 */
export const createOutgoingIdempotencyMiddleware = (opts: OutgoingIdempotencyOptions): OutgoingMiddleware => {
	const ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000
	return async ctx => {
		const key = opts.key?.(ctx) ?? (ctx.options?.messageId ? `outgoing:${ctx.jid}:${ctx.options.messageId}` : undefined)
		if (!key) {
			return
		}

		if (!(await opts.store.tryAcquire(key, ttlMs))) {
			ctx.stop()
		}
	}
}
