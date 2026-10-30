import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	makeRedisIdempotencyStore,
	makeRedisScheduledMessageStore,
	useRedisAuthState
} from '../lib/Utils/redis-adapters.js'

class FakeRedis {
	constructor() {
		this.map = new Map()
		this.quitCalled = false
	}

	async get(key) {
		return this.map.get(key) ?? null
	}

	async set(key, value, options = {}) {
		if (options.NX && this.map.has(key)) {
			return null
		}
		this.map.set(key, value)
		return 'OK'
	}

	async del(...keys) {
		let removed = 0
		for (const key of keys) {
			if (this.map.delete(key)) {
				removed++
			}
		}
		return removed
	}

	async mGet(keys) {
		return keys.map(key => this.map.get(key) ?? null)
	}

	async *scanIterator({ MATCH }) {
		const prefix = MATCH.endsWith('*') ? MATCH.slice(0, -1).replace(/\\(.)/g, '$1') : MATCH
		for (const key of Array.from(this.map.keys())) {
			if (key.startsWith(prefix)) {
				yield key
			}
		}
	}

	multi() {
		const operations = []
		return {
			set: (key, value) => {
				operations.push(['set', key, value])
				return this
			},
			del: (...keys) => {
				operations.push(['del', keys])
				return this
			},
			exec: async () => {
				for (const [type, ...args] of operations) {
					if (type === 'set') {
						this.map.set(args[0], args[1])
					} else {
						for (const key of args[0]) {
							this.map.delete(key)
						}
					}
				}
				return []
			}
		}
	}

	async quit() {
		this.quitCalled = true
	}
}

const writeAuth = async auth => {
	auth.state.creds.registered = true
	auth.state.creds.accountSyncCounter = 7
	await auth.saveCreds()
	await auth.state.keys.set({ session: { '1.0': Buffer.from([9, 8, 7]) } })
}

describe('Redis adapters', () => {
	it('stores encrypted auth state and reloads it', async () => {
		const client = new FakeRedis()
		const auth = await useRedisAuthState({
			client,
			prefix: 'redis:auth',
			passphrase: 'secret'
		})
		await writeAuth(auth)
		assert.match(client.map.get('redis:auth:creds'), /^enc:v1:/)
		await auth.close()

		const reopened = await useRedisAuthState({
			client,
			prefix: 'redis:auth',
			passphrase: 'secret'
		})
		assert.equal(reopened.state.creds.accountSyncCounter, 7)
		const keys = await reopened.state.keys.get('session', ['1.0'])
		assert.deepEqual(Array.from(keys['1.0']), [9, 8, 7])
		await reopened.close()
	})

	it('supports scheduled-message outbox operations', async () => {
		const client = new FakeRedis()
		const store = makeRedisScheduledMessageStore({ client, prefix: 'redis:outbox' })
		const scheduled = {
			id: 's1',
			jid: '123@s.whatsapp.net',
			content: { text: 'later' },
			scheduledTime: new Date('2030-01-01T00:00:00.000Z'),
			createdAt: new Date('2029-01-01T00:00:00.000Z'),
			status: 'pending'
		}

		await store.save(scheduled)
		const pending = await store.loadPending()
		assert.equal(pending.length, 1)
		assert.equal(pending[0].content.text, 'later')
		assert.equal(pending[0].scheduledTime.toISOString(), scheduled.scheduledTime.toISOString())

		await store.update({ ...scheduled, status: 'sent' })
		assert.equal((await store.loadPending()).length, 0)
		assert.equal((await store.list()).length, 1)
		await store.delete('s1')
		assert.equal((await store.list()).length, 0)
		await store.close()
	})

	it('implements atomic idempotency acquisition and release', async () => {
		const client = new FakeRedis()
		const store = makeRedisIdempotencyStore({ client, prefix: 'redis:idem' })
		assert.equal(await store.tryAcquire('key', 1000), true)
		assert.equal(await store.tryAcquire('key', 1000), false)
		await store.release('key')
		assert.equal(await store.tryAcquire('key', 1000), true)
	})

	it('closes the client when requested', async () => {
		const client = new FakeRedis()
		const auth = await useRedisAuthState({ client, prefix: 'close:auth', closeClient: true })
		await auth.close()
		assert.equal(client.quitCalled, true)
	})
})
