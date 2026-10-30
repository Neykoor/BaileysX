import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TokenBucket, createRateLimitMiddleware, createRateLimiter } from '../lib/Utils/rate-limiter.js'

describe('TokenBucket', () => {
	it('enforces capacity and refills deterministically', () => {
		let now = 0
		const bucket = new TokenBucket({
			capacity: 2,
			refillTokens: 1,
			refillIntervalMs: 100,
			now: () => now
		})

		assert.equal(bucket.tryAcquire(), true)
		assert.equal(bucket.tryAcquire(), true)
		assert.equal(bucket.tryAcquire(), false)
		assert.equal(bucket.available, 0)

		now = 100
		assert.equal(bucket.tryAcquire(), true)
		assert.equal(bucket.available, 0)
	})

	it('queues concurrent acquires until a token is available', async () => {
		const bucket = new TokenBucket({
			capacity: 1,
			refillTokens: 1,
			refillIntervalMs: 20
		})

		const started = Date.now()
		await Promise.all([bucket.acquire(), bucket.acquire()])
		assert.ok(Date.now() - started >= 15)
	})

	it('validates options', () => {
		assert.throws(() => new TokenBucket({ capacity: 0 }), /capacity/)
		assert.throws(() => new TokenBucket({ capacity: 1, refillTokens: 0 }), /refillTokens/)
	})
})

describe('RateLimiter', () => {
	it('enforces global and per-JID buckets', () => {
		let now = 0
		const limiter = createRateLimiter({
			global: { capacity: 3, refillIntervalMs: 1000, now: () => now },
			perJid: { capacity: 1, refillIntervalMs: 1000, now: () => now }
		})

		assert.equal(limiter.tryAcquire('a'), true)
		assert.equal(limiter.tryAcquire('a'), false)
		assert.equal(limiter.tryAcquire('b'), true)
		assert.equal(limiter.tryAcquire('c'), true)
		assert.equal(limiter.tryAcquire('d'), false)

		now = 1000
		assert.equal(limiter.tryAcquire('a'), true)
		assert.deepEqual(limiter.getState('a'), { global: 0, jid: 0 })
	})

	it('exposes an outgoing middleware that waits for capacity', async () => {
		const limiter = createRateLimiter({
			perJid: { capacity: 1, refillTokens: 1, refillIntervalMs: 15 }
		})
		const middleware = createRateLimitMiddleware(limiter)
		const ctx = { jid: '123@s.whatsapp.net', content: { text: 'x' }, options: {}, stop: () => undefined }

		const started = Date.now()
		await middleware(ctx)
		await middleware(ctx)
		assert.ok(Date.now() - started >= 10)
	})
})
