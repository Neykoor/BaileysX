import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { retryDelay, RetryQueue, withRetry } from '../lib/Utils/retry.js'

describe('retry helpers', () => {
	it('retries with exponential backoff and eventually succeeds', async () => {
		const delays = []
		let attempts = 0
		const result = await withRetry(
			async attempt => {
				attempts = attempt
				if (attempt < 3) {
					throw new Error(`fail-${attempt}`)
				}
				return 'ok'
			},
			{
				maxAttempts: 4,
				baseDelayMs: 10,
				sleep: async ms => {
					delays.push(ms)
				}
			}
		)

		assert.equal(result, 'ok')
		assert.equal(attempts, 3)
		assert.deepEqual(delays, [10, 20])
	})

	it('honours shouldRetry and maxAttempts', async () => {
		let calls = 0
		await assert.rejects(
			() =>
				withRetry(
					async () => {
						calls++
						throw new Error('nope')
					},
					{
						maxAttempts: 5,
						shouldRetry: () => false,
						sleep: async () => undefined
					}
				),
			/nope/
		)
		assert.equal(calls, 1)

		calls = 0
		await assert.rejects(
			() =>
				withRetry(
					async () => {
						calls++
						throw new Error('always')
					},
					{ maxAttempts: 3, sleep: async () => undefined }
				),
			/always/
		)
		assert.equal(calls, 3)
	})

	it('computes bounded delays', () => {
		assert.equal(retryDelay(1, 100, 1000, 2), 100)
		assert.equal(retryDelay(2, 100, 1000, 2), 200)
		assert.equal(retryDelay(10, 100, 1000, 2), 1000)
	})

	it('processes queued retry tasks and reports exhaustion', async () => {
		let clock = 0
		const queue = new RetryQueue({ now: () => clock })
		const successes = []
		const failures = []
		let attempts = 0

		queue.add(
			'flaky',
			async () => {
				attempts++
				if (attempts === 1) {
					throw new Error('temporary')
				}
				return 'sent'
			},
			{
				maxAttempts: 2,
				baseDelayMs: 100,
				onSuccess: (value, count) => successes.push([value, count]),
				onError: (error, count) => failures.push([error.message, count])
			}
		)

		assert.equal(await queue.processOnce(), 1)
		assert.equal(queue.size(), 1)
		assert.equal(queue.get('flaky').nextAt, 100)

		clock = 100
		assert.equal(await queue.processOnce(), 1)
		assert.equal(queue.size(), 0)
		assert.deepEqual(successes, [['sent', 2]])
		assert.equal(failures.length, 0)

		queue.add(
			'dead',
			async () => {
				throw new Error('dead')
			},
			{
				maxAttempts: 1,
				onError: (error, count) => failures.push([error.message, count])
			}
		)
		await queue.processOnce()
		assert.equal(queue.size(), 0)
		assert.deepEqual(failures, [['dead', 1]])
		queue.stop()
	})
})
