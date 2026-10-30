import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	addTransactionCapability,
	assertMeId,
	initAuthCreds,
	makeCacheableSignalKeyStore
} from '../lib/Utils/auth-utils.js'
import { Curve } from '../lib/Utils/crypto.js'
import { createMemoryKeyStore, logger } from './support/signal.mjs'

describe('makeCacheableSignalKeyStore', () => {
	it('loads values from the backing store and serves them from cache', async () => {
		const backing = createMemoryKeyStore()
		await backing.set({ session: { a: Buffer.from([1]) } })
		const cached = makeCacheableSignalKeyStore(backing, logger)

		assert.deepEqual(await cached.get('session', ['a']), { a: Buffer.from([1]) })
		await backing.set({ session: { a: Buffer.from([2]) } })
		assert.deepEqual(await cached.get('session', ['a']), { a: Buffer.from([1]) })
	})

	it('invalidates cached entries when a key is deleted', async () => {
		const backing = createMemoryKeyStore()
		const cached = makeCacheableSignalKeyStore(backing, logger)
		await cached.set({ session: { a: Buffer.from([1]) } })
		assert.deepEqual(await cached.get('session', ['a']), { a: Buffer.from([1]) })

		await cached.set({ session: { a: null } })
		assert.deepEqual(await cached.get('session', ['a']), {})
		assert.deepEqual(await backing.get('session', ['a']), {})
	})

	it('clears both the cache and the backing store', async () => {
		const backing = createMemoryKeyStore()
		const cached = makeCacheableSignalKeyStore(backing, logger)
		await cached.set({ session: { a: Buffer.from([1]) } })
		await cached.clear()
		assert.deepEqual(await cached.get('session', ['a']), {})
		assert.deepEqual(await backing.get('session', ['a']), {})
	})
})

describe('addTransactionCapability', () => {
	const options = { maxCommitRetries: 2, delayBetweenTriesMs: 1 }
	const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

	it('commits writes made inside a transaction', async () => {
		const backing = createMemoryKeyStore()
		const store = addTransactionCapability(backing, logger, options)

		assert.equal(store.isInTransaction(), false)
		await store.transaction(async () => {
			assert.equal(store.isInTransaction(), true)
			await store.set({ session: { a: Buffer.from([1]) } })
			assert.deepEqual(await store.get('session', ['a']), { a: Buffer.from([1]) })
		}, 'key')

		assert.equal(store.isInTransaction(), false)
		assert.deepEqual(await backing.get('session', ['a']), { a: Buffer.from([1]) })
	})

	it('reuses nested transaction contexts and commits once', async () => {
		const backing = createMemoryKeyStore()
		const store = addTransactionCapability(backing, logger, options)

		await store.transaction(async () => {
			await store.set({ session: { a: Buffer.from([1]) } })
			await store.transaction(async () => {
				await store.set({ session: { b: Buffer.from([2]) } })
			}, 'nested')
		}, 'outer')

		assert.deepEqual(await backing.get('session', ['a', 'b']), {
			a: Buffer.from([1]),
			b: Buffer.from([2])
		})
	})

	it('serializes concurrent transactions for the same key', async () => {
		const backing = createMemoryKeyStore()
		const store = addTransactionCapability(backing, logger, options)
		let active = 0
		let maxActive = 0
		let completed = 0

		const work = async () => {
			active++
			maxActive = Math.max(maxActive, active)
			await wait(5)
			active--
			completed++
		}

		await Promise.all(Array.from({ length: 4 }, () => store.transaction(work, 'shared-key')))
		assert.equal(maxActive, 1)
		assert.equal(completed, 4)
	})

	it('retries transient commit failures', async () => {
		const backing = createMemoryKeyStore()
		let attempts = 0
		const flaky = {
			...backing,
			async set(updates) {
				attempts++
				if (attempts < 3) {
					throw new Error('transient commit failure')
				}
				await backing.set(updates)
			}
		}
		const store = addTransactionCapability(flaky, logger, { maxCommitRetries: 3, delayBetweenTriesMs: 1 })

		await store.transaction(async () => {
			await store.set({ session: { retried: Buffer.from([1]) } })
		}, 'retry-key')

		assert.equal(attempts, 3)
		assert.deepEqual(await backing.get('session', ['retried']), { retried: Buffer.from([1]) })
	})

	it('does not commit a failed transaction', async () => {
		const backing = createMemoryKeyStore()
		const store = addTransactionCapability(backing, logger, options)

		await assert.rejects(
			store.transaction(async () => {
				await store.set({ session: { a: Buffer.from([1]) } })
				throw new Error('boom')
			}, 'key'),
			/boom/
		)

		assert.deepEqual(await backing.get('session', ['a']), {})
	})

	it('deletes existing prekeys inside a transaction', async () => {
		const backing = createMemoryKeyStore()
		await backing.set({ 'pre-key': { 1: { public: Buffer.alloc(32), private: Buffer.alloc(32) } } })
		const store = addTransactionCapability(backing, logger, options)

		await store.transaction(async () => {
			await store.set({ 'pre-key': { 1: null } })
		}, 'pre-key')

		assert.deepEqual(await backing.get('pre-key', ['1']), {})
	})

	it('skips deleting prekeys that never existed', async () => {
		const backing = createMemoryKeyStore()
		const store = addTransactionCapability(backing, logger, options)

		await store.set({ 'pre-key': { 99: null } })
		assert.deepEqual(await backing.get('pre-key', ['99']), {})
	})
})

describe('initAuthCreds', () => {
	it('creates a complete initial auth state', () => {
		const creds = initAuthCreds()
		assert.equal(creds.noiseKey.public.length, 32)
		assert.equal(creds.pairingEphemeralKeyPair.private.length, 32)
		assert.equal(creds.signedIdentityKey.public.length, 32)
		assert.equal(creds.signedPreKey.keyId, 1)
		assert.equal(creds.signedPreKey.signature.length, 64)
		assert.ok(creds.registrationId >= 0 && creds.registrationId <= 16383)
		assert.equal(creds.nextPreKeyId, 1)
		assert.equal(creds.firstUnuploadedPreKeyId, 1)
		assert.equal(creds.registered, false)
		assert.deepEqual(creds.retiredSignedPreKeyIds, [])

		assert.equal(
			Curve.verify(
				creds.signedIdentityKey.public,
				Buffer.concat([Buffer.from([5]), creds.signedPreKey.keyPair.public]),
				creds.signedPreKey.signature
			),
			true
		)
	})
})

describe('assertMeId', () => {
	it('returns the authenticated id or throws', () => {
		assert.equal(assertMeId({ me: { id: '123@s.whatsapp.net' } }), '123@s.whatsapp.net')
		assert.throws(() => assertMeId({}), /not authenticated/)
	})
})
