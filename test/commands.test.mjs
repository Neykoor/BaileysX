import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { makeCommandRouter } from '../lib/Utils/commands.js'

const message = (text, id = 'm1', sender = '123@s.whatsapp.net') => ({
	key: { remoteJid: sender, fromMe: false, id },
	message: { conversation: text },
	messageTimestamp: 1
})

describe('command router', () => {
	it('parses commands, aliases, arguments and replies', async () => {
		const sent = []
		const router = makeCommandRouter({
			prefix: '!',
			sendMessage: async (jid, content, options) => {
				sent.push({ jid, content, options })
				return { key: { id: 'reply' } }
			}
		})

		router.command({
			name: 'echo',
			aliases: ['e'],
			handler: async ctx => {
				await ctx.reply({ text: ctx.args.join(' ') })
			}
		})

		const result = await router.handle(message('!echo hello world'))
		assert.equal(result.handled, true)
		assert.equal(result.command, 'echo')
		assert.equal(sent.length, 1)
		assert.equal(sent[0].jid, '123@s.whatsapp.net')
		assert.equal(sent[0].content.text, 'hello world')

		const alias = await router.handle(message('!e one'))
		assert.equal(alias.handled, true)
		assert.equal(sent[1].content.text, 'one')
	})

	it('enforces permissions and cooldowns', async () => {
		let clock = 0
		const router = makeCommandRouter({
			prefix: '!',
			now: () => clock,
			sendMessage: async () => undefined
		})

		router.command({
			name: 'secret',
			permission: ctx => ctx.senderJid === 'admin@s.whatsapp.net',
			handler: () => undefined
		})
		router.command({
			name: 'slow',
			cooldownMs: 1000,
			handler: () => undefined
		})

		const forbidden = await router.handle(message('!secret'))
		assert.equal(forbidden.handled, false)
		assert.equal(forbidden.reason, 'forbidden')

		const first = await router.handle(message('!slow'))
		assert.equal(first.handled, true)
		const second = await router.handle(message('!slow'))
		assert.equal(second.handled, false)
		assert.equal(second.reason, 'cooldown')
		clock = 1000
		const third = await router.handle(message('!slow'))
		assert.equal(third.handled, true)
	})

	it('returns reasons for ignored messages and supports middleware', async () => {
		const router = makeCommandRouter({ prefix: ['/', '!'], sendMessage: async () => undefined })
		router.command({ name: 'ping', handler: ctx => ctx.reply({ text: 'pong' }) })

		assert.equal((await router.handle(message('hello'))).reason, 'no-prefix')
		assert.equal((await router.handle(message('!missing'))).reason, 'not-found')

		let stopped = false
		const middleware = router.middleware()
		await middleware({
			jid: '123@s.whatsapp.net',
			message: message('/ping'),
			stop: () => {
				stopped = true
			}
		})
		assert.equal(stopped, false)
		assert.equal(router.list().length, 1)
		assert.equal(router.get('PING').name, 'ping')
	})

	it('stops the middleware chain when stopOnCommand is enabled', async () => {
		const router = makeCommandRouter({
			prefix: '!',
			stopOnCommand: true,
			sendMessage: async () => undefined
		})
		router.command({ name: 'stop', handler: () => undefined })

		let stopped = false
		await router.middleware()({
			jid: '123@s.whatsapp.net',
			message: message('!stop'),
			stop: () => {
				stopped = true
			}
		})
		assert.equal(stopped, true)
	})
})
