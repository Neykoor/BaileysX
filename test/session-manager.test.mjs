import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { makeSessionManager } from '../lib/Utils/session-manager.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const silentLogger = {
	level: 'silent',
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
	trace: () => undefined,
	fatal: () => undefined,
	child() {
		return this
	}
}

async function tempDir(t) {
	const dir = await mkdtemp(join(tmpdir(), 'baileysx-sessions-'))
	t.after(async () => {
		await rm(dir, { recursive: true, force: true })
	})
	return dir
}

const makeSocketFactory = () => {
	const sockets = []
	const factory = () => {
		const ev = new EventEmitter()
		let ended = false
		const sock = {
			ev,
			get ended() {
				return ended
			},
			end: () => {
				ended = true
				ev.emit('connection.update', { connection: 'close' })
			}
		}
		sockets.push(sock)
		return sock
	}
	return { factory, sockets }
}

describe('makeSessionManager', () => {
	it('starts, tracks health and stops a file-backed session', async t => {
		const dir = await tempDir(t)
		const { factory, sockets } = makeSocketFactory()
		const manager = makeSessionManager({
			baseAuthDir: dir,
			config: { logger: silentLogger },
			socketFactory: factory
		})
		t.after(() => manager.stopAll())

		const entry = await manager.start('alpha')
		assert.equal(entry.id, 'alpha')
		assert.equal(entry.status, 'starting')
		assert.equal(sockets.length, 1)

		sockets[0].ev.emit('connection.update', { connection: 'open' })
		assert.equal(entry.status, 'connected')
		assert.ok(entry.lastSeenAt instanceof Date)
		assert.deepEqual(manager.list(), ['alpha'])
		assert.equal(manager.getHealth().connected, 1)
		assert.equal(manager.getHealth().sessions[0].connected, true)

		const again = await manager.start('alpha')
		assert.equal(again, entry)
		assert.equal(sockets.length, 1)

		sockets[0].ev.emit('creds.update')
		await wait(20)

		await manager.stop('alpha')
		assert.equal(sockets[0].ended, true)
		assert.equal(entry.status, 'stopped')
		assert.deepEqual(manager.list(), [])
		assert.equal(manager.getHealth().total, 0)

		const files = await readdir(join(dir, 'alpha'))
		assert.ok(files.includes('creds.json'))
	})

	it('rejects unsafe session ids', async t => {
		const dir = await tempDir(t)
		const manager = makeSessionManager({
			baseAuthDir: dir,
			config: { logger: silentLogger },
			socketFactory: () => {
				throw new Error('should not be called')
			}
		})

		await assert.rejects(manager.start('../escape'), /invalid session id/)
		await assert.rejects(manager.start('bad/id'), /invalid session id/)
		await assert.rejects(manager.start(''), /invalid session id/)
	})

	it('supports SQLite auth storage', async t => {
		const dir = await tempDir(t)
		const { factory, sockets } = makeSocketFactory()
		const manager = makeSessionManager({
			baseAuthDir: dir,
			storage: 'sqlite',
			passphrase: 'session secret',
			config: { logger: silentLogger },
			socketFactory: factory
		})
		t.after(() => manager.stopAll())

		const entry = await manager.start('sqlite-session')
		sockets[0].ev.emit('connection.update', { connection: 'open' })
		assert.equal(entry.status, 'connected')
		assert.equal((await stat(join(dir, 'sqlite-session.db'))).isFile(), true)

		await manager.stop('sqlite-session')
		assert.equal(sockets[0].ended, true)
	})

	it('auto-reconnects sessions and exposes the current socket', async t => {
		const dir = await tempDir(t)
		const { factory, sockets } = makeSocketFactory()
		const manager = makeSessionManager({
			baseAuthDir: dir,
			config: { logger: silentLogger },
			socketFactory: factory,
			autoReconnect: true,
			reconnectOptions: {
				minDelayMs: 1,
				maxDelayMs: 2,
				maxAttempts: 3
			}
		})
		t.after(() => manager.stopAll())

		const entry = await manager.start('resilient')
		sockets[0].ev.emit('connection.update', { connection: 'open' })
		assert.equal(entry.status, 'connected')

		sockets[0].ev.emit('connection.update', {
			connection: 'close',
			lastDisconnect: { error: { output: { statusCode: 428 } } }
		})
		assert.equal(entry.status, 'reconnecting')

		await wait(30)
		assert.ok(sockets.length >= 2)
		sockets[1].ev.emit('connection.update', { connection: 'open' })
		assert.equal(entry.status, 'connected')
		assert.equal(entry.sock, sockets[1])

		await manager.stop('resilient')
		assert.equal(entry.status, 'stopped')
		assert.equal(manager.getHealth().total, 0)
	})

	it('stops all sessions', async t => {
		const dir = await tempDir(t)
		const { factory, sockets } = makeSocketFactory()
		const manager = makeSessionManager({
			baseAuthDir: dir,
			config: { logger: silentLogger },
			socketFactory: factory
		})

		await manager.start('one')
		await manager.start('two')
		assert.equal(sockets.length, 2)
		await manager.stopAll()
		assert.equal(manager.list().length, 0)
		assert.ok(sockets.every(socket => socket.ended))
	})
})
