import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { makeFakeWASocket } from '../lib/Utils/fake-socket.js'
import { definePlugin, makePluginManager } from '../lib/Utils/plugins.js'

const incoming = {
	key: { remoteJid: '123@s.whatsapp.net', fromMe: false, id: 'm1' },
	message: { conversation: 'hello plugin' },
	messageTimestamp: 1
}

const wait = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))

describe('plugin manager', () => {
	it('runs lifecycle, message and connection hooks', async () => {
		const sock = makeFakeWASocket()
		const manager = makePluginManager({ sock })
		const events = []

		const plugin = definePlugin({
			name: 'echo',
			version: '1.0.0',
			setup: () => {
				events.push('setup')
			},
			hooks: {
				onLoad: () => {
					events.push('load')
				},
				onUnload: () => {
					events.push('unload')
				},
				onMessage: async ctx => {
					events.push(`message:${ctx.text}`)
					await ctx.reply({ text: 'pong' })
				},
				onConnectionUpdate: update => {
					events.push(`connection:${update.connection}`)
				}
			}
		})

		const unregister = await manager.register(plugin)
		assert.deepEqual(manager.list(), [{ name: 'echo', version: '1.0.0' }])
		sock.connect()
		sock.receive(incoming)
		await wait()

		assert.deepEqual(events, ['setup', 'load', 'connection:open', 'message:hello plugin'])
		assert.equal(sock.sentMessages.length, 1)
		assert.equal(sock.sentMessages[0].content.text, 'pong')

		await unregister()
		assert.deepEqual(events.at(-1), 'unload')
		assert.equal(manager.list().length, 0)
	})

	it('stops subsequent plugin middleware when a plugin calls stop', async () => {
		const sock = makeFakeWASocket()
		const manager = makePluginManager({ sock })
		const calls = []

		await manager.register({
			name: 'first',
			hooks: {
				onMessage: ctx => {
					calls.push('first')
					ctx.stop()
				}
			}
		})
		await manager.register({
			name: 'second',
			hooks: {
				onMessage: () => {
					calls.push('second')
				}
			}
		})

		sock.receive(incoming)
		await wait()
		assert.deepEqual(calls, ['first'])
		await manager.stop()
	})

	it('isolates throwing hooks and rejects duplicate names', async () => {
		const sock = makeFakeWASocket()
		const manager = makePluginManager({ sock })
		let secondCalled = false

		await manager.register({
			name: 'throws',
			hooks: {
				onMessage: () => {
					throw new Error('boom')
				}
			}
		})
		await manager.register({
			name: 'second',
			hooks: {
				onMessage: () => {
					secondCalled = true
				}
			}
		})

		sock.receive(incoming)
		await wait()
		assert.equal(secondCalled, true)
		await assert.rejects(() => manager.register({ name: 'throws' }), /already registered/)
		await manager.stop()
	})
})
