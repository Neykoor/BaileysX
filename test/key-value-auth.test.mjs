import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { makeKeyValueAuthState } from '../lib/Utils/key-value-auth-state.js'

const makeStorage = () => {
	const map = new Map()
	return {
		map,
		async get(key) {
			return map.get(key) ?? null
		},
		async set(key, value) {
			map.set(key, value)
		},
		async delete(key) {
			map.delete(key)
		},
		async list(prefix) {
			return Array.from(map.entries())
				.filter(([key]) => key.startsWith(prefix))
				.map(([key, value]) => ({ key, value }))
		},
		async getMany(keys) {
			const result = new Map()
			for (const key of keys) {
				if (map.has(key)) {
					result.set(key, map.get(key))
				}
			}
			return result
		},
		async setMany(entries) {
			for (const entry of entries) {
				map.set(entry.key, entry.value)
			}
		},
		async deletePrefix(prefix) {
			for (const key of Array.from(map.keys())) {
				if (key.startsWith(prefix)) {
					map.delete(key)
				}
			}
		},
		async replaceAll(entries) {
			for (const entry of entries) {
				map.set(entry.key, entry.value)
			}
		},
		async close() {}
	}
}

const writeAuth = async auth => {
	auth.state.creds.registered = true
	auth.state.creds.accountSyncCounter = 42
	await auth.saveCreds()
	await auth.state.keys.set({
		session: { '123.0': Buffer.from([1, 2, 3]) },
		'pre-key': { 1: { public: Buffer.alloc(32, 1), private: Buffer.alloc(32, 2) } }
	})
}

describe('key-value auth state', () => {
	it('persists credentials and signal keys across reopen', async () => {
		const storage = makeStorage()
		const auth = await makeKeyValueAuthState({ storage, prefix: 'test:auth' })
		await writeAuth(auth)
		await auth.close()

		const reopened = await makeKeyValueAuthState({ storage, prefix: 'test:auth' })
		assert.equal(reopened.state.creds.registered, true)
		assert.equal(reopened.state.creds.accountSyncCounter, 42)
		const keys = await reopened.state.keys.get('session', ['123.0'])
		assert.deepEqual(Array.from(keys['123.0']), [1, 2, 3])
		await reopened.close()
	})

	it('encrypts values at rest and rejects the wrong passphrase', async () => {
		const storage = makeStorage()
		const auth = await makeKeyValueAuthState({
			storage,
			prefix: 'enc:auth',
			passphrase: 'correct horse battery staple'
		})
		await writeAuth(auth)
		await auth.close()

		const rawCreds = storage.map.get('enc:auth:creds')
		assert.match(rawCreds, /^enc:v1:/)
		assert.doesNotMatch(rawCreds, /accountSyncCounter/)
		const rawSession = storage.map.get('enc:auth:key:session:123.0')
		assert.match(rawSession, /^enc:v1:/)

		await assert.rejects(
			() =>
				makeKeyValueAuthState({
					storage,
					prefix: 'enc:auth',
					passphrase: 'wrong passphrase'
				}),
			/failed to decrypt|wrong passphrase/
		)

		const reopened = await makeKeyValueAuthState({
			storage,
			prefix: 'enc:auth',
			passphrase: 'correct horse battery staple'
		})
		assert.equal(reopened.state.creds.accountSyncCounter, 42)
		await reopened.close()
	})

	it('rekeys existing data to a new passphrase', async () => {
		const storage = makeStorage()
		const auth = await makeKeyValueAuthState({
			storage,
			prefix: 'rekey:auth',
			passphrase: 'old-pass'
		})
		await writeAuth(auth)
		await auth.rekey('new-pass')
		await auth.close()

		await assert.rejects(
			() => makeKeyValueAuthState({ storage, prefix: 'rekey:auth', passphrase: 'old-pass' }),
			/failed to decrypt|wrong passphrase/
		)

		const reopened = await makeKeyValueAuthState({
			storage,
			prefix: 'rekey:auth',
			passphrase: 'new-pass'
		})
		assert.equal(reopened.state.creds.accountSyncCounter, 42)
		const keys = await reopened.state.keys.get('session', ['123.0'])
		assert.deepEqual(Array.from(keys['123.0']), [1, 2, 3])
		await reopened.close()
	})

	it('clears signal keys without touching credentials', async () => {
		const storage = makeStorage()
		const auth = await makeKeyValueAuthState({ storage, prefix: 'clear:auth' })
		await writeAuth(auth)
		await auth.state.keys.clear()
		const keys = await auth.state.keys.get('session', ['123.0'])
		assert.equal(keys['123.0'], undefined)
		assert.equal(auth.state.creds.accountSyncCounter, 42)
		await auth.close()
	})
})
