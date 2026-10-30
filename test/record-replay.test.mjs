import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	deserializeRecording,
	makeFakeEventEmitter,
	recordEvents,
	replayEvents,
	serializeRecording
} from '../lib/Utils/record-replay.js'

const message = {
	key: { remoteJid: '123@s.whatsapp.net', fromMe: false, id: 'msg-1' },
	message: {
		imageMessage: {
			fileSha256: Buffer.from([1, 2, 3]),
			mimetype: 'image/jpeg'
		}
	},
	messageTimestamp: 10
}

describe('record/replay', () => {
	it('records, serializes and replays events with buffers intact', async () => {
		const source = makeFakeEventEmitter()
		const { recording, stop } = recordEvents(source)

		source.emit('messages.upsert', { messages: [message], type: 'notify' })
		source.emit('connection.update', { connection: 'open' })
		stop()

		assert.equal(recording.events.length, 2)
		assert.equal(recording.events[0].event, 'messages.upsert')
		assert.equal(source.emitted.length, 2)

		const restored = deserializeRecording(serializeRecording(recording))
		const target = makeFakeEventEmitter()
		const received = []
		target.on('messages.upsert', payload => received.push(payload))
		target.on('connection.update', payload => received.push(payload))

		await replayEvents(target, restored, { speed: 0 })

		assert.equal(received.length, 2)
		assert.equal(received[0].messages[0].key.id, 'msg-1')
		assert.equal(Buffer.isBuffer(received[0].messages[0].message.imageMessage.fileSha256), true)
		assert.deepEqual(
			Array.from(received[0].messages[0].message.imageMessage.fileSha256),
			[1, 2, 3]
		)
		assert.equal(received[1].connection, 'open')
	})

	it('supports event filters and custom replay hooks', async () => {
		const source = makeFakeEventEmitter()
		const { recording, stop } = recordEvents(source, {
			events: ['connection.update'],
			filter: (_event, data) => data.connection !== 'connecting'
		})

		source.emit('connection.update', { connection: 'connecting' })
		source.emit('connection.update', { connection: 'open' })
		source.emit('messages.upsert', { messages: [message], type: 'notify' })
		stop()

		assert.equal(recording.events.length, 1)
		assert.equal(recording.events[0].data.connection, 'open')

		const target = makeFakeEventEmitter()
		const seen = []
		await replayEvents(target, recording, {
			speed: 0,
			onEvent: event => {
				seen.push(event.event)
			}
		})

		assert.deepEqual(seen, ['connection.update'])
		assert.equal(target.emitted.length, 1)
	})

	it('does not record after stop is called twice', () => {
		const source = makeFakeEventEmitter()
		const { recording, stop } = recordEvents(source, { events: ['creds.update'] })
		stop()
		stop()
		source.emit('creds.update', { registered: true })
		assert.equal(recording.events.length, 0)
	})
})
