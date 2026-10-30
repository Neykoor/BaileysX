import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { makeFakeWASocket } from '../lib/Utils/fake-socket.js'

const incoming = {
	key: { remoteJid: '123@s.whatsapp.net', fromMe: false, id: 'in-1' },
	message: { conversation: 'hello' },
	messageTimestamp: 1
}

describe('makeFakeWASocket', () => {
	it('emits connection state, runs middleware and records sends', async () => {
		const sock = makeFakeWASocket({
			downloadMedia: async () => Buffer.from('media-bytes')
		})

		assert.equal(sock.getHealth().connected, false)
		sock.connect()
		assert.equal(sock.getHealth().connected, true)

		const received = []
		sock.use(async ctx => {
			received.push(ctx.message.key.id)
			ctx.message.message = { conversation: 'processed' }
		})
		sock.receive(incoming)
		assert.deepEqual(received, ['in-1'])
		assert.equal(sock.getMetrics().messagesReceived, 1)

		sock.useOutgoing(async ctx => {
			ctx.jid = '999@s.whatsapp.net'
			ctx.content = { text: 'rewritten' }
		})
		const sent = await sock.sendMessage('123@s.whatsapp.net', { text: 'hello' }, { messageId: 'out-1' })

		assert.equal(sent.key.id, 'out-1')
		assert.equal(sock.sentMessages.length, 1)
		assert.equal(sock.sentMessages[0].jid, '999@s.whatsapp.net')
		assert.equal(sock.sentMessages[0].content.text, 'rewritten')
		assert.equal(sock.getMetrics().messagesSent, 1)

		const media = await sock.downloadMedia(incoming)
		assert.equal(media.toString(), 'media-bytes')

		sock.end()
		assert.equal(sock.getHealth().connected, false)
	})

	it('supports outgoing cancellation and scheduling', async () => {
		const sock = makeFakeWASocket()
		sock.connect()
		sock.useOutgoing(ctx => {
			ctx.stop()
		})

		const result = await sock.sendMessage('123@s.whatsapp.net', { text: 'blocked' })
		assert.equal(result, undefined)
		assert.equal(sock.sentMessages.length, 0)

		const scheduled = sock.scheduleMessage(
			'123@s.whatsapp.net',
			{ text: 'later' },
			new Date(Date.now() + 60_000)
		)
		assert.equal(sock.getMetrics().scheduler.pending, 1)
		assert.equal(sock.cancelScheduledMessage(scheduled.id), true)
		assert.equal(sock.getMetrics().scheduler.pending, 0)
	})

	it('can emit its own sent messages when requested', async () => {
		const sock = makeFakeWASocket({ emitOwnEvents: true })
		sock.connect()
		let ownMessages = 0
		sock.use(() => {
			ownMessages++
		})

		await sock.sendMessage('123@s.whatsapp.net', { text: 'own' })
		assert.equal(ownMessages, 1)
		assert.equal(sock.ev.emitted.at(-1).event, 'messages.upsert')
	})
})
