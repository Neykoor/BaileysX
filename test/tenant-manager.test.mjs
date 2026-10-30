import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { makeAuditLog, makeMemoryAuditSink } from '../lib/Utils/audit-log.js'
import { makeTenantManager } from '../lib/Utils/tenant-manager.js'

const makeFakeSessionManager = sent => opts => {
	const sessions = new Map()
	return {
		baseAuthDir: opts.baseAuthDir,
		async start(id) {
			const entry = {
				id,
				status: 'connected',
				sock: {
					async sendMessage(jid, content, options) {
						sent.push({ id, jid, content, options })
						return { key: { id: 'sent' } }
					}
				},
				stop: async () => {
					sessions.delete(id)
				}
			}
			sessions.set(id, entry)
			return entry
		},
		async stop(id) {
			sessions.delete(id)
		},
		async stopAll() {
			sessions.clear()
		},
		get(id) {
			return sessions.get(id)
		},
		list() {
			return Array.from(sessions.keys())
		},
		getHealth() {
			return {
				total: sessions.size,
				connected: sessions.size,
				starting: 0,
				reconnecting: 0,
				disconnected: 0,
				sessions: []
			}
		}
	}
}

describe('tenant manager', () => {
	it('isolates tenants, enforces session limits and audits operations', async () => {
		const sent = []
		const sink = makeMemoryAuditSink()
		const audit = makeAuditLog({ sink: sink.sink })
		const created = []
		const factory = opts => {
			created.push(opts)
			return makeFakeSessionManager(sent)(opts)
		}
		const manager = makeTenantManager({
			baseAuthDir: 'C:/auth',
			sessionManagerFactory: factory,
			limits: { maxSessions: 1 },
			audit
		})

		const entry = await manager.start('tenant-a', 's1')
		assert.equal(entry.id, 's1')
		assert.match(created[0].baseAuthDir, /tenant-a$/)
		await assert.rejects(() => manager.start('tenant-a', 's2'), /session limit/)
		await manager.start('tenant-b', 's1')
		assert.equal(manager.list().length, 2)
		assert.equal(manager.getHealth().totalSessions, 2)

		await manager.sendMessage('tenant-a', 's1', '123@s.whatsapp.net', { text: 'hello' })
		assert.equal(sent.length, 1)
		assert.equal(sent[0].content.text, 'hello')

		await manager.stop('tenant-a', 's1')
		assert.equal(manager.getHealth().totalSessions, 1)
		await manager.stopAll()
		assert.equal(manager.getHealth().totalSessions, 0)

		assert.equal(sink.events.some(event => event.action === 'session.start'), true)
		assert.equal(sink.events.some(event => event.action === 'session.stop'), true)
		assert.equal(sink.events.some(event => event.action === 'message.send'), true)
		await assert.rejects(() => manager.start('../escape', 's1'), /invalid tenant id/)
	})

	it('enforces per-tenant message quotas', async () => {
		const sent = []
		const manager = makeTenantManager({
			baseAuthDir: 'C:/auth',
			sessionManagerFactory: makeFakeSessionManager(sent),
			limits: { maxMessagesPerMinute: 1 },
			now: () => 0
		})

		await manager.start('tenant-a', 's1')
		await manager.sendMessage('tenant-a', 's1', '123@s.whatsapp.net', { text: 'one' })
		assert.equal(sent.length, 1)
		assert.equal(manager.getQuota('tenant-a').available, 0)
	})
})
