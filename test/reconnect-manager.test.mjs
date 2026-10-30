import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import { ConnectionWatchdog } from '../lib/Utils/connection-watchdog.js'
import { makeResilientSocket } from '../lib/Utils/reconnect-manager.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const silentLogger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined
}

const socketFactory = sockets => () => {
	const ev = new EventEmitter()
	const sock = {
		ev,
		ended: false,
		end: () => {
			sock.ended = true
			ev.emit('connection.update', { connection: 'close' })
		}
	}
	sockets.push(sock)
	return sock
}

const closeUpdate = statusCode => ({
	connection: 'close',
	lastDisconnect: { error: { output: { statusCode } } }
})

describe('ConnectionWatchdog', () => {
	it('reconnects with backoff and stops on terminal codes', () => {
		const watchdog = new ConnectionWatchdog({ baseDelayMs: 10, maxDelayMs: 1000, backoffFactor: 2 })
		const first = watchdog.decide(428)
		assert.equal(first.action, 'reconnect')
		assert.ok(first.delayMs >= 10)

		watchdog.notifyConnected()
		assert.equal(watchdog.decide(428).action, 'reconnect')
		assert.deepEqual(watchdog.decide(401), {
			action: 'stop',
			reason: 'terminal disconnect code 401 - re-authentication required'
		})
	})

	it('uses a longer cooldown for rate-limit style codes', () => {
		const watchdog = new ConnectionWatchdog({
			baseDelayMs: 10,
			rateLimitCooldownMs: 500
		})
		const decision = watchdog.decide(405)
		assert.equal(decision.action, 'reconnect')
		assert.ok(decision.delayMs >= 500)
	})
})

describe('makeResilientSocket', () => {
	it('reconnects after a transient close and resets attempts on open', async () => {
		const sockets = []
		const resilient = makeResilientSocket({
			config: { auth: {} },
			socketFactory: socketFactory(sockets),
			minDelayMs: 1,
			maxDelayMs: 2,
			maxAttempts: 3,
			logger: silentLogger
		})

		sockets[0].ev.emit('connection.update', { connection: 'open' })
		sockets[0].ev.emit('connection.update', closeUpdate(428))
		await wait(30)
		assert.equal(sockets.length, 2)

		sockets[1].ev.emit('connection.update', { connection: 'open' })
		assert.equal(resilient.socket, sockets[1])
		resilient.stop()
		assert.equal(sockets[1].ended, true)
	})

	it('stops on a terminal disconnect code', () => {
		const sockets = []
		let stoppedWith
		const resilient = makeResilientSocket({
			config: { auth: {} },
			socketFactory: socketFactory(sockets),
			logger: silentLogger,
			onStopped: statusCode => {
				stoppedWith = statusCode
			}
		})

		sockets[0].ev.emit('connection.update', closeUpdate(401))
		assert.equal(stoppedWith, 401)
		assert.equal(sockets.length, 1)
		resilient.stop()
	})

	it('honors maxAttempts', async () => {
		const sockets = []
		let maxReached = false
		const resilient = makeResilientSocket({
			config: { auth: {} },
			socketFactory: socketFactory(sockets),
			minDelayMs: 1,
			maxDelayMs: 2,
			maxAttempts: 1,
			logger: silentLogger,
			onMaxAttemptsReached: () => {
				maxReached = true
			}
		})

		sockets[0].ev.emit('connection.update', closeUpdate(428))
		await wait(20)
		assert.equal(sockets.length, 2)
		sockets[1].ev.emit('connection.update', closeUpdate(428))
		assert.equal(maxReached, true)
		assert.equal(sockets.length, 2)
		resilient.stop()
	})
})
