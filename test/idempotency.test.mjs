import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	createIncomingDedupeMiddleware,
	createOutgoingIdempotencyMiddleware,
	InMemoryIdempotencyStore,
	makeIdempotencyGuard
} from '../lib/Utils/idempotency.js'

describe('idempotency', () => {
	it('runs a keyed operation only once until the TTL expires', async () => {
		let clock = 0
		const store = new InMemoryIdempotencyStore(() => clock)
		const guard = makeIdempotencyGuard({ store, ttlMs: 100 })
		let calls = 0

		const first = await guard.runOnce('job-1', async () => {
			calls++
			return 'ok'
		})
		const second = await guard.runOnce('job-1', async () => {
			calls++
			return 'ok'
		})

		assert.deepEqual(first, { executed: true, value: 'ok' })
		assert.deepEqual(second, { executed: false })
		assert.equal(calls, 1)

		clock = 100
		const third = await guard.runOnce('job-1', async () => {
			calls++
			return 'again'
		})
		assert.equal(third.executed, true)
		assert.equal(calls, 2)
	})

	it('releases the key when work throws', async () => {
		const store = new InMemoryIdempotencyStore()
		const guard = makeIdempotencyGuard({ store })

		await assert.rejects(
			() =>
				guard.runOnce('job', async () => {
					throw new Error('failed')
				}),
			/failed/
		)
		const retry = await guard.runOnce('job', async () => 'recovered')
		assert.deepEqual(retry, { executed: true, value: 'recovered' })
	})

	it('deduplicates incoming messages through middleware', async () => {
		const store = new InMemoryIdempotencyStore()
		const middleware = createIncomingDedupeMiddleware({ store })
		let stopped = false
		const ctx = {
			jid: '123@s.whatsapp.net',
			message: { key: { id: 'm1', remoteJid: '123@s.whatsapp.net' } },
			stop: () => {
				stopped = true
			}
		}

		await middleware(ctx)
		assert.equal(stopped, false)
		await middleware(ctx)
		assert.equal(stopped, true)
	})

	it('cancels duplicate outgoing sends with an explicit message id', async () => {
		const store = new InMemoryIdempotencyStore()
		const middleware = createOutgoingIdempotencyMiddleware({ store })
		let stopped = false
		const ctx = {
			jid: '123@s.whatsapp.net',
			content: { text: 'hello' },
			options: { messageId: 'out-1' },
			stop: () => {
				stopped = true
			}
		}

		await middleware(ctx)
		assert.equal(stopped, false)
		await middleware(ctx)
		assert.equal(stopped, true)
	})
})
