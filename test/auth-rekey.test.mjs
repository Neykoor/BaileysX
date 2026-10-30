import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { useSqliteAuthState } from '../lib/Utils/use-sqlite-auth-state.js'

describe('SQLite auth rekey', () => {
	it('rotates the passphrase without losing credentials or keys', async t => {
		const dir = await mkdtemp(join(tmpdir(), 'baileysx-rekey-'))
		t.after(async () => {
			await rm(dir, { recursive: true, force: true })
		})
		const dbPath = join(dir, 'auth.db')

		const auth = await useSqliteAuthState({ dbPath, passphrase: 'old-pass' })
		auth.state.creds.registered = true
		auth.state.creds.accountSyncCounter = 42
		auth.saveCreds()
		await auth.state.keys.set({ session: { '1.0': Buffer.from([7, 8, 9]) } })
		auth.rekey('new-pass')
		auth.close()

		await assert.rejects(
			() => useSqliteAuthState({ dbPath, passphrase: 'old-pass' }),
			/wrong passphrase|failed to decrypt/
		)

		const reopened = await useSqliteAuthState({ dbPath, passphrase: 'new-pass' })
		assert.equal(reopened.state.creds.accountSyncCounter, 42)
		const keys = await reopened.state.keys.get('session', ['1.0'])
		assert.deepEqual(Array.from(keys['1.0']), [7, 8, 9])
		reopened.close()
	})

	it('can add encryption to a plaintext database', async t => {
		const dir = await mkdtemp(join(tmpdir(), 'baileysx-rekey-plain-'))
		t.after(async () => {
			await rm(dir, { recursive: true, force: true })
		})
		const dbPath = join(dir, 'auth.db')

		const plain = await useSqliteAuthState({ dbPath })
		plain.state.creds.accountSyncCounter = 5
		plain.saveCreds()
		plain.rekey('new-pass')
		plain.close()

		const encrypted = await useSqliteAuthState({ dbPath, passphrase: 'new-pass' })
		assert.equal(encrypted.state.creds.accountSyncCounter, 5)
		encrypted.close()
	})
})
