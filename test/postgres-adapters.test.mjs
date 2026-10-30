import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FakePostgres } from './helpers/fake-postgres.mjs'
import {
	makePostgresIdempotencyStore,
	makePostgresScheduledMessageStore,
	usePostgresAuthState
} from '../lib/Utils/postgres-adapters.js'

const writeAuth = async auth => {
	auth.state.creds.registered = true
	auth.state.creds.accountSyncCounter = 11
	await auth.saveCreds()
	await auth.state.keys.set({ session: { '1.0': Buffer.from([4, 5, 6]) } })
}

describe('Postgres adapters', () => {
	it('stores encrypted auth state and reloads it', async () => {
		const client = new FakePostgres()
		const auth = await usePostgresAuthState({
			client,
			table: 'pg_auth',
			prefix: 'pg:auth',
			passphrase: 'secret'
		})
		await writeAuth(auth)
		assert.match(client.tables.get('pg_auth').rows.get('pg:auth:creds').value, /^enc:v1:/)
		await auth.close()

		const reopened = await usePostgresAuthState({
			client,
			table: 'pg_auth',
			prefix: 'pg:auth',
			passphrase: 'secret'
		})
		assert.equal(reopened.state.creds.accountSyncCounter, 11)
		const keys = await reopened.state.keys.get('session', ['1.0'])
		assert.deepEqual(Array.from(keys['1.0']), [4, 5, 6])
		await reopened.close()
	})

	it('supports scheduled-message outbox operations', async () => {
		const client = new FakePostgres()
		const store = makePostgresScheduledMessageStore({ client, table: 'pg_sched' })
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

		await store.update({ ...scheduled, status: 'sent' })
		assert.equal((await store.loadPending()).length, 0)
		assert.equal((await store.list()).length, 1)
		await store.delete('s1')
		assert.equal((await store.list()).length, 0)
		await store.close()
	})

	it('implements idempotency acquisition and expiry', async () => {
		const client = new FakePostgres()
		let clock = 0
		const store = makePostgresIdempotencyStore({ client, table: 'pg_idem', now: () => clock })
		assert.equal(await store.tryAcquire('key', 100), true)
		assert.equal(await store.tryAcquire('key', 100), false)
		clock = 100
		assert.equal(await store.tryAcquire('key', 100), true)
		await store.release('key')
		assert.equal(await store.tryAcquire('key', 100), true)
	})

	it('rejects unsafe table names', async () => {
		await assert.rejects(
			() => usePostgresAuthState({ client: new FakePostgres(), table: 'bad;drop' }),
			/invalid SQL table name/
		)
	})
})
