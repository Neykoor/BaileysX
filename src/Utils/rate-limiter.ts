import { LRUCache } from 'lru-cache'
import type { OutgoingMiddleware } from './middleware'

export type TokenBucketOptions = {
	/** Maximum number of tokens the bucket can hold. */
	capacity: number
	/** Tokens added per refill interval. Defaults to 1. */
	refillTokens?: number
	/** Refill interval in milliseconds. Defaults to 1000. */
	refillIntervalMs?: number
	/** Initial token count. Defaults to the bucket capacity. */
	initialTokens?: number
	/** Injectable clock, mainly useful for tests. */
	now?: () => number
}

export type RateLimiterOptions = {
	global?: TokenBucketOptions
	perJid?: TokenBucketOptions
	maxJidBuckets?: number
	jidBucketTtlMs?: number
}

export type RateLimitMiddlewareOptions = {
	key?: (ctx: { jid: string }) => string
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * A fair, queue-based token bucket. Concurrent callers are serialized so a
 * burst cannot consume more tokens than the bucket contains.
 */
export class TokenBucket {
	private tokens: number
	private lastRefill: number
	private tail: Promise<void> = Promise.resolve()
	private readonly capacity: number
	private readonly refillTokens: number
	private readonly refillIntervalMs: number
	private readonly now: () => number

	constructor(options: TokenBucketOptions) {
		if (!Number.isFinite(options.capacity) || options.capacity <= 0) {
			throw new Error('token bucket capacity must be greater than 0')
		}

		this.capacity = options.capacity
		this.refillTokens = options.refillTokens ?? 1
		this.refillIntervalMs = options.refillIntervalMs ?? 1000
		this.now = options.now ?? Date.now
		this.tokens = Math.min(options.initialTokens ?? options.capacity, options.capacity)
		this.lastRefill = this.now()

		if (this.refillTokens <= 0 || this.refillIntervalMs <= 0) {
			throw new Error('token bucket refillTokens and refillIntervalMs must be greater than 0')
		}
	}

	private refill() {
		const now = this.now()
		const elapsed = now - this.lastRefill
		if (elapsed <= 0) {
			return
		}

		const intervals = Math.floor(elapsed / this.refillIntervalMs)
		if (intervals <= 0) {
			return
		}

		this.tokens = Math.min(this.capacity, this.tokens + intervals * this.refillTokens)
		this.lastRefill += intervals * this.refillIntervalMs
	}

	private take(): number {
		this.refill()
		if (this.tokens >= 1) {
			this.tokens -= 1
			return 0
		}

		const missing = 1 - this.tokens
		return Math.max(1, Math.ceil((missing / this.refillTokens) * this.refillIntervalMs))
	}

	private async waitForToken() {
		for (;;) {
			const waitMs = this.take()
			if (waitMs === 0) {
				return
			}

			await delay(waitMs)
		}
	}

	acquire(): Promise<void> {
		const next = this.tail.then(() => this.waitForToken())
		this.tail = next.catch(() => undefined)
		return next
	}

	tryAcquire(): boolean {
		return this.take() === 0
	}

	get available(): number {
		this.refill()
		return Math.floor(this.tokens)
	}
}

export class RateLimiter {
	private readonly globalBucket?: TokenBucket
	private readonly jidBuckets?: LRUCache<string, TokenBucket>
	private readonly perJidOptions?: TokenBucketOptions

	constructor(options: RateLimiterOptions = {}) {
		this.globalBucket = options.global ? new TokenBucket(options.global) : undefined
		this.perJidOptions = options.perJid
		if (options.perJid) {
			this.jidBuckets = new LRUCache<string, TokenBucket>({
				max: options.maxJidBuckets ?? 10_000,
				ttl: options.jidBucketTtlMs ?? 60 * 60 * 1000,
				ttlAutopurge: true
			})
		}
	}

	private getJidBucket(jid: string): TokenBucket | undefined {
		if (!this.jidBuckets || !this.perJidOptions) {
			return undefined
		}

		let bucket = this.jidBuckets.get(jid)
		if (!bucket) {
			bucket = new TokenBucket(this.perJidOptions)
			this.jidBuckets.set(jid, bucket)
		}

		return bucket
	}

	async acquire(jid: string): Promise<void> {
		const jidBucket = this.getJidBucket(jid)
		if (jidBucket) {
			await jidBucket.acquire()
		}

		if (this.globalBucket) {
			await this.globalBucket.acquire()
		}
	}

	tryAcquire(jid: string): boolean {
		const jidBucket = this.getJidBucket(jid)
		if (jidBucket && !jidBucket.tryAcquire()) {
			return false
		}

		return this.globalBucket ? this.globalBucket.tryAcquire() : true
	}

	getState(jid: string) {
		return {
			global: this.globalBucket?.available,
			jid: this.getJidBucket(jid)?.available
		}
	}

	clear() {
		this.jidBuckets?.clear()
	}
}

export const createRateLimiter = (options: RateLimiterOptions = {}) => new RateLimiter(options)

export const createRateLimitMiddleware = (
	limiter: RateLimiter,
	options: RateLimitMiddlewareOptions = {}
): OutgoingMiddleware => {
	return async ctx => {
		await limiter.acquire(options.key ? options.key(ctx) : ctx.jid)
	}
}
