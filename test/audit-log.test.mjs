import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { makeAuditLog, makeMemoryAuditSink } from '../lib/Utils/audit-log.js'

describe('audit log', () => {
	it('records timestamped events and redacts secrets recursively', async () => {
		const sink = makeMemoryAuditSink()
		const audit = makeAuditLog({ sink: sink.sink, now: () => 1234 })
		const record = await audit.record({
			action: 'session.start',
			tenantId: 'tenant-a',
			sessionId: 's1',
			outcome: 'success',
			metadata: {
				token: 'secret-token',
				nested: { password: 'pw', ok: 1 },
				list: [{ authorization: 'Bearer x' }]
			}
		})

		assert.equal(record.timestamp, 1234)
		assert.equal(record.metadata.token, '[redacted]')
		assert.equal(record.metadata.nested.password, '[redacted]')
		assert.equal(record.metadata.nested.ok, 1)
		assert.equal(record.metadata.list[0].authorization, '[redacted]')
		assert.equal(sink.events.length, 1)
		assert.deepEqual(sink.events[0], record)
	})

	it('supports custom redaction keys and clearing the sink', async () => {
		const sink = makeMemoryAuditSink()
		const audit = makeAuditLog({ sink: sink.sink, redactKeys: ['cookie'] })
		await audit.record({ action: 'x', metadata: { cookie: 'c', token: 'visible' } })
		assert.equal(sink.events[0].metadata.cookie, '[redacted]')
		assert.equal(sink.events[0].metadata.token, 'visible')
		sink.clear()
		assert.equal(sink.events.length, 0)
	})
})
