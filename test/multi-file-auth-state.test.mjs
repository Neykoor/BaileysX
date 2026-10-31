import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { useMultiFileAuthState } from '../lib/Utils/use-multi-file-auth-state.js'

const tempDir = async t => {
	const dir = await mkdtemp(join(tmpdir(), 'baileysx-auth-'))
	t.after(() => rm(dir, { recursive: true, force: true }))
	return dir
}

describe('useMultiFileAuthState', () => {
	it('persists creds and keys atomically without leaving temp files', async t => {
		const dir = await tempDir(t)
		const { state, saveCreds } = await useMultiFileAuthState(dir)

		await Promise.all([saveCreds(), saveCreds(), saveCreds()])
		await state.keys.set({ 'pre-key': { 1: { a: 1 }, 'x/y:z': { b: 2 } } })

		const files = (await readdir(dir)).sort()
		assert.deepEqual(files, ['creds.json', 'pre-key-1.json', 'pre-key-x__y-z.json'])

		const reloaded = await useMultiFileAuthState(dir)
		assert.equal(reloaded.state.creds.registrationId, state.creds.registrationId)
		assert.deepEqual(await reloaded.state.keys.get('pre-key', ['1', 'missing']), {
			1: { a: 1 },
			missing: null
		})
	})

	it('removes keys and ignores already-missing files', async t => {
		const dir = await tempDir(t)
		const { state } = await useMultiFileAuthState(dir)

		await state.keys.set({ 'pre-key': { 1: { a: 1 } } })
		await state.keys.set({ 'pre-key': { 1: null, ghost: null } })

		assert.deepEqual(await readdir(dir), [])
	})

	it('refuses to replace corrupt credentials with fresh ones', async t => {
		const dir = await tempDir(t)
		await writeFile(join(dir, 'creds.json'), '{"registrationId":1,')

		await assert.rejects(useMultiFileAuthState(dir), /Refusing to create new credentials/)
		assert.equal(await readFile(join(dir, 'creds.json'), 'utf8'), '{"registrationId":1,')
	})
})
