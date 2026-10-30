import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import { makeMiddlewareStack } from '../lib/Utils/middleware.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

const logger = () => {
	const errors = []
	return {
		errors,
		error: (...args) => errors.push(args),
		debug: () => undefined,
		warn: () => undefined,
		info: () => undefined
	}
}

const message = (id = 'm1') => ({
	key: { remoteJid: '123@s.whatsapp.net', fromMe: false, id },
	message: { conversation: 'original' },
	messageTimestamp: 1
})

describe('makeMiddlewareStack', () => {
	it('runs incoming middleware in order and lets it mutate the message', async () => {
		const ev = new EventEmitter()
		const stack = makeMiddlewareStack({ ev })
		const order = []

		stack.use(ctx => {
			order.push('first')
			ctx.message.message.conversation = 'mutated'
		})
		stack.use(() => {
			order.push('second')
		})

		const msg = message()
		ev.emit('messages.upsert', { messages: [msg], type: 'notify' })
		await tick()

		assert.deepEqual(order, ['first', 'second'])
		assert.equal(msg.message.conversation, 'mutated')
	})

	it('ignores append notifications and missing remote JIDs', async () => {
		const ev = new EventEmitter()
		const stack = makeMiddlewareStack({ ev })
		let calls = 0
		stack.use(() => {
			calls++
		})

		ev.emit('messages.upsert', { messages: [message()], type: 'append' })
		ev.emit('messages.upsert', {
			messages: [{ ...message(), key: { fromMe: false, id: 'm2' } }],
			type: 'notify'
		})
		await tick()
		assert.equal(calls, 0)
	})

	it('stops the chain, isolates errors and supports unsubscribe', async () => {
		const ev = new EventEmitter()
		const log = logger()
		const stack = makeMiddlewareStack({ ev }, { logger: log })
		const order = []

		const unsubscribe = stack.use(() => {
			order.push('first')
			throw new Error('boom')
		})
		stack.use(ctx => {
			order.push('second')
			ctx.stop()
		})
		stack.use(() => {
			order.push('third')
		})

		ev.emit('messages.upsert', { messages: [message()], type: 'notify' })
		await tick()

		assert.deepEqual(order, ['first', 'second'])
		assert.equal(log.errors.length, 1)

		unsubscribe()
		order.length = 0
		ev.emit('messages.upsert', { messages: [message()], type: 'notify' })
		await tick()
		assert.deepEqual(order, ['second'])
	})

	it('mutates outgoing content/options and can cancel the send', async () => {
		const ev = new EventEmitter()
		const stack = makeMiddlewareStack({ ev })
		const order = []

		stack.useOutgoing(ctx => {
			order.push('mutate')
			ctx.jid = '456@s.whatsapp.net'
			ctx.content = { text: 'changed' }
			ctx.options = { ...ctx.options, messageId: 'custom' }
		})
		stack.useOutgoing(ctx => {
			order.push('stop')
			ctx.stop()
		})
		stack.useOutgoing(() => {
			order.push('never')
		})

		const result = await stack.runOutgoing('123@s.whatsapp.net', { text: 'original' }, {})
		assert.deepEqual(order, ['mutate', 'stop'])
		assert.equal(result.stopped, true)
		assert.equal(result.jid, '456@s.whatsapp.net')
		assert.deepEqual(result.content, { text: 'changed' })
		assert.equal(result.options.messageId, 'custom')
	})

	it('isolates outgoing middleware errors', async () => {
		const ev = new EventEmitter()
		const log = logger()
		const stack = makeMiddlewareStack({ ev }, { logger: log })
		let reached = false

		stack.useOutgoing(() => {
			throw new Error('outgoing boom')
		})
		stack.useOutgoing(() => {
			reached = true
		})

		const result = await stack.runOutgoing('123@s.whatsapp.net', { text: 'x' })
		assert.equal(reached, true)
		assert.equal(result.stopped, false)
		assert.equal(log.errors.length, 1)
	})
})
