import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import { makeSocketMetrics } from '../lib/Utils/metrics.js'

describe('SocketMetrics', () => {
	it('tracks connection and message events without user content', () => {
		const ev = new EventEmitter()
		const metrics = makeSocketMetrics()
		metrics.attach(ev)

		ev.emit('connection.update', { connection: 'open' })
		ev.emit('messages.upsert', { messages: [{}, {}], type: 'notify' })
		ev.emit('messages.update', [{}, {}, {}])
		ev.emit('messages.delete', { keys: [{}, {}] })
		metrics.recordSent()
		metrics.recordSendFailure()
		metrics.recordMediaDownload()

		const snapshot = metrics.snapshot()
		assert.equal(snapshot.connection, 'open')
		assert.equal(snapshot.messagesReceived, 2)
		assert.equal(snapshot.messagesUpdated, 3)
		assert.equal(snapshot.messagesDeleted, 2)
		assert.equal(snapshot.messagesSent, 1)
		assert.equal(snapshot.sendFailures, 1)
		assert.equal(snapshot.mediaDownloads, 1)
		assert.equal(snapshot.connectionOpens, 1)
		assert.ok(snapshot.connectedAt)
		assert.ok(snapshot.connectedForMs >= 0)
		assert.ok(snapshot.uptimeMs >= 0)
	})

	it('detaches listeners and handles close events', () => {
		const ev = new EventEmitter()
		const metrics = makeSocketMetrics()
		metrics.attach(ev)

		ev.emit('connection.update', { connection: 'open' })
		ev.emit('connection.update', { connection: 'close' })
		metrics.detach()
		ev.emit('messages.upsert', { messages: [{}], type: 'notify' })

		const snapshot = metrics.snapshot()
		assert.equal(snapshot.connection, 'close')
		assert.equal(snapshot.disconnects, 1)
		assert.equal(snapshot.messagesReceived, 0)
		assert.equal(snapshot.connectedForMs, 0)
	})
})
