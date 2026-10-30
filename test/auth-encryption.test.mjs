import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { useSqliteAuthState } from '../lib/Utils/use-sqlite-auth-state.js'

async function tempDatabase(t) {
	const dir = await mkdtemp(join(tmpdir(), 'baileysx-auth-enc-'))
	const handles = []
	t.after(async () => {
		for (let i = handles.length - 1; i >= 0; i--) {
			try {
				handles[i].close()
			} catch {}
		}
		await rm(dir, { recursive: true, force: true })
	})
	return { dir, dbPath: join(dir, 'auth.db'), handles }
}

async function rawDatabase(dbPath) {
	const mod = await import('infinitysqlite')
	const Database = mod.default ?? mod
	return new Database(dbPath)
}

async function writeAuth(auth) {
	auth.state.creds.registered = false
	auth.state.creds.accountSyncCounter = 77
	auth.saveCreds()
	await auth.state.keys.set({
		session: { '123.0': Buffer.from([1, 2, 3]) },
		'pre-key': { 1: { public: Buffer.alloc(32, 1), private: Buffer.alloc(32, 2) } }
	})
}

describe('useSqliteAuthState encryption', () => {
	it('encrypts credentials and signal keys at rest and decrypts on reopen', async t => {
		const { dbPath, handles } = await tempDatabase(t)
		const first = await useSqliteAuthState({ dbPath, passphrase: 'correct horse battery staple' })
		handles.push(first)
		await writeAuth(first)
		first.close()

		const raw = await rawDatabase(dbPath)
		const credsValue = raw.prepare('SELECT value FROM creds').all()[0].value
		const keyValues = raw.prepare('SELECT value FROM signal_keys').all().map(row => row.value)
		raw.close()

		assert.match(credsValue, /^enc:v1:/)
		assert.ok(keyValues.length >= 2)
		assert.ok(keyValues.every(value => value.startsWith('enc:v1:')))
		assert.ok(!credsValue.includes('accountSyncCounter'))

		const second = await useSqliteAuthState({ dbPath, passphrase: 'correct horse battery staple' })
		handles.push(second)
		assert.equal(second.state.creds.accountSyncCounter, 77)
		assert.deepEqual(await second.state.keys.get('session', ['123.0']), {
			'123.0': Buffer.from([1, 2, 3])
		})
		assert.equal((await second.state.keys.get('pre-key', ['1']))['1'].private.length, 32)
	})

	it('rejects a wrong or missing passphrase', async t => {
		const { dbPath, handles } = await tempDatabase(t)
		const auth = await useSqliteAuthState({ dbPath, passphrase: 'secret' })
		handles.push(auth)
		await writeAuth(auth)
		auth.close()

		await assert.rejects(
			useSqliteAuthState({ dbPath, passphrase: 'wrong' }),
			/wrong passphrase|decrypt/
		)
		await assert.rejects(useSqliteAuthState({ dbPath }), /encrypted|passphrase/)
	})

	it('migrates a legacy plaintext database when a passphrase is first supplied', async t => {
		const { dbPath, handles } = await tempDatabase(t)
		const legacy = await useSqliteAuthState({ dbPath })
		handles.push(legacy)
		await writeAuth(legacy)
		legacy.close()

		const migrated = await useSqliteAuthState({ dbPath, passphrase: 'migrate me' })
		handles.push(migrated)
		assert.equal(migrated.state.creds.accountSyncCounter, 77)

		const raw = await rawDatabase(dbPath)
		const values = [
			...raw.prepare('SELECT value FROM creds').all(),
			...raw.prepare('SELECT value FROM signal_keys').all()
		].map(row => row.value)
		raw.close()
		assert.ok(values.length >= 3)
		assert.ok(values.every(value => value.startsWith('enc:v1:')))
	})

	it('creates an encrypted backup that can be opened with the passphrase', async t => {
		const { dir, dbPath, handles } = await tempDatabase(t)
		const auth = await useSqliteAuthState({ dbPath, passphrase: 'backup pass' })
		handles.push(auth)
		await writeAuth(auth)

		const backupPath = join(dir, 'auth-backup.db')
		auth.backupTo(backupPath)

		const backup = await useSqliteAuthState({ dbPath: backupPath, passphrase: 'backup pass' })
		handles.push(backup)
		assert.equal(backup.state.creds.accountSyncCounter, 77)
		assert.deepEqual(await backup.state.keys.get('session', ['123.0']), {
			'123.0': Buffer.from([1, 2, 3])
		})
	})

	it('validates the passphrase and closed state', async t => {
		const { dbPath, handles } = await tempDatabase(t)
		await assert.rejects(useSqliteAuthState({ dbPath, passphrase: '' }), /must not be empty/)

		const auth = await useSqliteAuthState({ dbPath })
		handles.push(auth)
		auth.close()
		assert.throws(() => auth.backupTo(join(dbPath, '..', 'backup.db')), /closed/)
	})
})
