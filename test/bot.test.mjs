import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { makeBotRouter } from '../lib/Utils/bot/router.js'
import {
	extractMentions,
	getJidUser,
	getMessageJid,
	getSenderJid,
	isFromMe,
	isGroupJid,
	isLidJid,
	isMentioned,
	isNewsletterJid,
	isUserJid,
	normalizeJid
} from '../lib/Utils/bot/jid.js'
import {
	getGroupAdmins,
	getGroupSuperAdmins,
	getParticipant,
	isBotAdmin,
	isGroupAdmin,
	isGroupSuperAdmin
} from '../lib/Utils/bot/groups.js'
import { makeSendQueue } from '../lib/Utils/bot/send-queue.js'
import { makeGroupSettings } from '../lib/Utils/bot/group-settings.js'
import { defineBotPlugin, withBotCommands } from '../lib/Utils/bot/plugin-integration.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const makeSock = () => {
	const sent = []
	return {
		sent,
		sendMessage: async (jid, content, options) => {
			const record = { jid, content, options }
			sent.push(record)
			return record
		}
	}
}

const makeMessage = ({ jid = '555@s.whatsapp.net', sender, text = '.ping', message } = {}) => {
	const key = { remoteJid: jid, fromMe: false, id: 'MSG' }
	if (sender) key.participant = sender
	return { key, message: message ?? { conversation: text } }
}

const makePluginCtx = ({ sock, jid = '555@s.whatsapp.net', sender, text = '.ping', message } = {}) => {
	const waMessage = makeMessage({ jid, sender, text, message })
	return {
		jid,
		senderJid: sender,
		message: waMessage,
		text,
		sock,
		reply: async (content, options) => sock.sendMessage(jid, content, options),
		stop: () => undefined
	}
}

describe('bot jid helpers', () => {
	it('classifies jids', () => {
		assert.equal(isGroupJid('123@g.us'), true)
		assert.equal(isGroupJid('123@s.whatsapp.net'), false)
		assert.equal(isUserJid('123@s.whatsapp.net'), true)
		assert.equal(isUserJid('123@lid'), false)
		assert.equal(isLidJid('123@lid'), true)
		assert.equal(isNewsletterJid('123@newsletter'), true)
		assert.equal(isGroupJid(undefined), false)
	})

	it('normalizes devices and legacy c.us servers', () => {
		assert.equal(normalizeJid('123:5@c.us'), '123@s.whatsapp.net')
		assert.equal(normalizeJid('123:5@s.whatsapp.net'), '123@s.whatsapp.net')
		assert.equal(normalizeJid('123:5@lid'), '123@lid')
		assert.equal(normalizeJid('not-a-jid'), undefined)
		assert.equal(normalizeJid(undefined), undefined)
		assert.equal(getJidUser('123:5@s.whatsapp.net'), '123')
	})

	it('reads message and sender jids from keys', () => {
		const msg = {
			key: {
				remoteJid: '123@s.whatsapp.net',
				remoteJidAlt: '999@lid',
				participant: '456:2@s.whatsapp.net'
			}
		}
		assert.equal(getMessageJid(msg), '999@lid')
		assert.equal(getSenderJid(msg), '456@s.whatsapp.net')
		assert.equal(isFromMe({ key: { fromMe: true } }), true)
		assert.equal(isFromMe({ key: {} }), false)
	})

	it('extracts and normalizes mentions from every supported message type', () => {
		const msg = {
			message: {
				extendedTextMessage: {
					text: 'hi',
					contextInfo: { mentionedJid: ['111:2@s.whatsapp.net', '222@lid'] }
				},
				imageMessage: {
					caption: 'pic',
					contextInfo: { mentionedJid: ['111@s.whatsapp.net', '333@s.whatsapp.net'] }
				}
			}
		}
		assert.deepEqual(extractMentions(msg), ['111@s.whatsapp.net', '222@lid', '333@s.whatsapp.net'])
		assert.equal(isMentioned(msg, '222:9@lid'), true)
		assert.equal(isMentioned(msg, '444@s.whatsapp.net'), false)
		assert.deepEqual(extractMentions(undefined), [])
	})
})

describe('bot group helpers', () => {
	const meta = {
		participants: [
			{ id: '111:2@s.whatsapp.net', admin: 'superadmin' },
			{ id: '222@s.whatsapp.net', admin: 'admin' },
			{ id: '333@s.whatsapp.net', admin: null }
		]
	}

	it('lists admins and super admins', () => {
		assert.deepEqual(getGroupAdmins(meta), ['111@s.whatsapp.net', '222@s.whatsapp.net'])
		assert.deepEqual(getGroupSuperAdmins(meta), ['111@s.whatsapp.net'])
	})

	it('checks roles regardless of device suffix', () => {
		assert.equal(isGroupAdmin(meta, '111:9@s.whatsapp.net'), true)
		assert.equal(isGroupAdmin(meta, '333@s.whatsapp.net'), false)
		assert.equal(isGroupSuperAdmin(meta, '111@s.whatsapp.net'), true)
		assert.equal(isGroupSuperAdmin(meta, '222@s.whatsapp.net'), false)
		assert.equal(isBotAdmin(meta, '222:4@s.whatsapp.net'), true)
		assert.equal(isGroupAdmin(meta, undefined), false)
	})

	it('finds participants and tolerates empty metadata', () => {
		assert.equal(getParticipant(meta, '333:1@s.whatsapp.net')?.id, '333@s.whatsapp.net')
		assert.equal(getParticipant(meta, '444@s.whatsapp.net'), undefined)
		assert.deepEqual(getGroupAdmins({}), [])
	})
})

describe('bot router', () => {
	it('parses commands, aliases, arguments and sends replies', async () => {
		const sock = makeSock()
		const router = makeBotRouter()
		const calls = []
		router.register({
			name: 'ping',
			aliases: ['p'],
			exec: async ctx => {
				calls.push({ args: ctx.args, jid: ctx.jid, sender: ctx.senderJid, isGroup: ctx.isGroup })
				await ctx.reply({ text: 'pong' })
				await ctx.send({ text: 'sent' })
			}
		})

		const handled = await router.handle({ messages: [makeMessage({ text: '.p one two' })], sock })
		assert.equal(handled, true)
		assert.deepEqual(calls, [{ args: ['one', 'two'], jid: '555@s.whatsapp.net', sender: '555@s.whatsapp.net', isGroup: false }])
		assert.equal(sock.sent.length, 2)
		assert.equal(sock.sent[0].jid, '555@s.whatsapp.net')

		assert.equal(router.list().length, 1)
		assert.equal(router.commands.get('p'), router.commands.get('ping'))
	})

	it('ignores non-commands and unknown commands', async () => {
		const router = makeBotRouter({ prefix: '!' })
		router.register({ name: 'ping', exec: () => assert.fail('must not run') })
		assert.equal(await router.handle({ messages: [makeMessage({ text: 'ping' })] }), false)
		assert.equal(await router.handle({ messages: [makeMessage({ text: '!' })] }), false)
		assert.equal(await router.handle({ messages: [makeMessage({ text: '!nope' })] }), false)
		assert.equal(await router.handle(undefined), false)
	})

	it('enforces group, private and role permissions with normalized jids', async () => {
		const meta = {
			participants: [
				{ id: '999:3@s.whatsapp.net', admin: 'superadmin' },
				{ id: '777@s.whatsapp.net', admin: 'admin' }
			]
		}
		const router = makeBotRouter({
			owners: ['123:4@s.whatsapp.net'],
			getGroupAdmins: async () => getGroupAdmins(meta),
			getGroupSuperAdmins: async () => getGroupSuperAdmins(meta)
		})
		let runs = 0
		router.register({ name: 'group', groupOnly: true, exec: () => void runs++ })
		router.register({ name: 'private', privateOnly: true, exec: () => void runs++ })
		router.register({ name: 'admin', adminOnly: true, exec: () => void runs++ })
		router.register({ name: 'super', superAdminOnly: true, exec: () => void runs++ })
		router.register({ name: 'owner', ownerOnly: true, exec: () => void runs++ })

		const group = { jid: '120@g.us', sender: '777:2@s.whatsapp.net' }
		assert.equal(await router.handle({ messages: [makeMessage({ ...group, text: '.group' })] }), true)
		assert.equal(await router.handle({ messages: [makeMessage({ ...group, text: '.private' })] }), false)
		assert.equal(await router.handle({ messages: [makeMessage({ ...group, text: '.admin' })] }), true)
		assert.equal(await router.handle({ messages: [makeMessage({ ...group, text: '.super' })] }), false)
		assert.equal(await router.handle({ messages: [makeMessage({ ...group, sender: '999:1@s.whatsapp.net', text: '.super' })] }), true)
		assert.equal(await router.handle({ messages: [makeMessage({ ...group, sender: '123:9@s.whatsapp.net', text: '.owner' })] }), true)
		assert.equal(await router.handle({ messages: [makeMessage({ ...group, text: '.owner' })] }), false)
		assert.equal(runs, 4)

		assert.equal(await router.handle({ messages: [makeMessage({ text: '.group' })] }), false)
		assert.equal(await router.handle({ messages: [makeMessage({ text: '.private' })] }), true)
	})

	it('applies per-sender cooldowns', async () => {
		const router = makeBotRouter()
		let runs = 0
		router.register({ name: 'once', cooldownMs: 60_000, exec: () => void runs++ })
		const ev = { messages: [makeMessage({ text: '.once' })] }
		assert.equal(await router.handle(ev), true)
		assert.equal(await router.handle(ev), true)
		assert.equal(runs, 1)
	})

	it('isolates command errors and reports them through the logger', async () => {
		const errors = []
		const router = makeBotRouter({ logger: { error: (payload, message) => errors.push({ payload, message }) } })
		router.register({ name: 'boom', exec: async () => { throw new Error('kaboom') } })
		assert.equal(await router.handle({ messages: [makeMessage({ text: '.boom' })] }), true)
		assert.equal(errors.length, 1)
		assert.match(errors[0].message, /bot command error/)
	})

	it('replaces stale aliases when a command is registered again', async () => {
		const router = makeBotRouter()
		let runs = 0
		router.register({ name: 'echo', aliases: ['e'], exec: () => void runs++ })
		router.register({ name: 'echo', exec: () => void runs++ })
		assert.equal(await router.handle({ messages: [makeMessage({ text: '.e' })] }), false)
		assert.equal(await router.handle({ messages: [makeMessage({ text: '.echo' })] }), true)
		assert.equal(runs, 1)
	})

	it('exposes mentions in the command context', async () => {
		const router = makeBotRouter()
		let seen
		router.register({ name: 'tag', exec: ctx => { seen = ctx.mentioned } })
		const message = {
			extendedTextMessage: {
				text: '.tag',
				contextInfo: { mentionedJid: ['111:3@s.whatsapp.net', '222@lid'] }
			}
		}
		assert.equal(await router.handle({ messages: [makeMessage({ text: '.tag', message })] }), true)
		assert.deepEqual(seen, ['111@s.whatsapp.net', '222@lid'])
	})

	it('handles plugin message contexts produced by the plugin manager', async () => {
		const sock = makeSock()
		const router = makeBotRouter()
		let ctxJid, ctxSender, ctxArgs
		router.register({
			name: 'hello',
			exec: async ctx => {
				ctxJid = ctx.jid
				ctxSender = ctx.senderJid
				ctxArgs = ctx.args
				await ctx.reply({ text: 'hi' })
			}
		})

		const handled = await router.handle(
			makePluginCtx({ sock, jid: '123@g.us', sender: '456:2@s.whatsapp.net', text: '.hello world' })
		)
		assert.equal(handled, true)
		assert.equal(ctxJid, '123@g.us')
		assert.equal(ctxSender, '456@s.whatsapp.net')
		assert.deepEqual(ctxArgs, ['world'])
		assert.deepEqual(sock.sent, [{ jid: '123@g.us', content: { text: 'hi' }, options: undefined }])
	})
})

describe('bot send queue', () => {
	it('sends queued messages and never exceeds the configured concurrency', async () => {
		let active = 0
		let maxActive = 0
		const sent = []
		const sock = {
			sendMessage: async (jid, content) => {
				active++
				maxActive = Math.max(maxActive, active)
				await wait(5)
				active--
				sent.push({ jid, content })
				return content
			}
		}
		const queue = makeSendQueue(sock, { concurrency: 2, minDelayMs: 0 })

		const results = await Promise.all([
			queue.enqueue('a@s.whatsapp.net', { text: '1' }),
			queue.enqueue('b@s.whatsapp.net', { text: '2' }),
			queue.enqueue('c@s.whatsapp.net', { text: '3' }),
			queue.enqueue('d@s.whatsapp.net', { text: '4' })
		])

		assert.equal(sent.length, 4)
		assert.equal(results.length, 4)
		assert.ok(maxActive <= 2)
		assert.ok(maxActive >= 1)
		assert.equal(queue.size(), 0)
	})

	it('retries transient failures and resolves with the successful send', async () => {
		let attempts = 0
		const queue = makeSendQueue(
			{
				sendMessage: async () => {
					attempts++
					if (attempts < 3) throw new Error('temporary')
					return { ok: true }
				}
			},
			{ concurrency: 1, minDelayMs: 1, maxDelayMs: 2, retryOnError: true }
		)

		assert.deepEqual(await queue.enqueue('a@s.whatsapp.net', { text: 'x' }, undefined, 3), { ok: true })
		assert.equal(attempts, 3)
	})

	it('rejects after exhausting the retry budget', async () => {
		let attempts = 0
		const queue = makeSendQueue(
			{
				sendMessage: async () => {
					attempts++
					throw new Error('always fails')
				}
			},
			{ concurrency: 1, minDelayMs: 1, maxDelayMs: 2 }
		)

		await assert.rejects(queue.enqueue('a@s.whatsapp.net', { text: 'x' }, undefined, 2), /always fails/)
		assert.equal(attempts, 2)
	})

	it('rejects queued work and new work after stop without hanging', async () => {
		let release
		const first = new Promise(resolve => {
			release = resolve
		})
		let calls = 0
		const queue = makeSendQueue(
			{
				sendMessage: () => {
					calls++
					return first
				}
			},
			{ concurrency: 1, minDelayMs: 0 }
		)

		const firstTask = queue.enqueue('a@s.whatsapp.net', { text: '1' })
		await wait(5)
		const secondTask = queue.enqueue('b@s.whatsapp.net', { text: '2' })

		queue.stop()

		await assert.rejects(secondTask, /stopped/)
		await assert.rejects(queue.enqueue('c@s.whatsapp.net', { text: '3' }), /stopped/)

		release({ ok: true })
		assert.deepEqual(await firstTask, { ok: true })
		assert.equal(calls, 1)
		assert.equal(queue.size(), 0)
	})
})

describe('bot group settings', () => {
	const makeStore = () => {
		const data = new Map()
		return {
			data,
			groupSettings: {
				get: async jid => data.get(jid) ?? {},
				set: async (jid, value) => void data.set(jid, value),
				delete: async jid => void data.delete(jid),
				all: async () => Object.fromEntries(data)
			}
		}
	}

	it('reads and writes settings through the store', async () => {
		const store = makeStore()
		const settings = makeGroupSettings(store)
		assert.deepEqual(await settings.get('g@g.us'), {})
		await settings.set('g@g.us', { prefix: '!', enabled: true })
		assert.deepEqual(await settings.get('g@g.us'), { prefix: '!', enabled: true })
		assert.deepEqual(await settings.all(), { 'g@g.us': { prefix: '!', enabled: true } })
		await settings.del('g@g.us')
		assert.deepEqual(await settings.get('g@g.us'), {})
		assert.deepEqual(await settings.all(), {})
	})

	it('uses delete as an alias and swallows store failures', async () => {
		let deleted
		const settings = makeGroupSettings({
			groupSettings: {
				delete: async jid => void (deleted = jid),
				get: async () => {
					throw new Error('nope')
				},
				get all() {
					throw new Error('nope')
				}
			}
		})
		await settings.delete('g@g.us')
		assert.equal(deleted, 'g@g.us')
		assert.deepEqual(await settings.get('g@g.us'), {})
		assert.deepEqual(await settings.all(), {})
	})

	it('returns empty defaults without a store', async () => {
		const settings = makeGroupSettings(undefined)
		assert.deepEqual(await settings.get('g@g.us'), {})
		assert.deepEqual(await settings.all(), {})
		await settings.set('g@g.us', { enabled: true })
		await settings.del('g@g.us')
	})
})

describe('bot plugin integration', () => {
	it('registers plugin commands through defineBotPlugin', async () => {
		const router = makeBotRouter()
		let ran = 0
		const plugin = defineBotPlugin(
			{ name: 'demo', commands: [{ name: 'demo', exec: () => void ran++ }] },
			router
		)
		assert.equal(plugin.name, 'demo')
		assert.equal(await router.handle({ messages: [makeMessage({ text: '.demo' })] }), true)
		assert.equal(ran, 1)
	})

	it('routes plugin messages through the bot router before the original hook', async () => {
		const sock = makeSock()
		const router = makeBotRouter()
		let commandCalls = 0
		let originalCalls = 0
		router.register({ name: 'ping', exec: () => void commandCalls++ })

		const plugin = withBotCommands({ router })({
			name: 'demo',
			hooks: {
				onMessage: async () => void originalCalls++
			}
		})

		await plugin.hooks.onMessage(makePluginCtx({ sock, text: '.ping' }))
		assert.equal(commandCalls, 1)
		assert.equal(originalCalls, 0)

		await plugin.hooks.onMessage(makePluginCtx({ sock, text: 'plain text' }))
		assert.equal(commandCalls, 1)
		assert.equal(originalCalls, 1)
	})
})
