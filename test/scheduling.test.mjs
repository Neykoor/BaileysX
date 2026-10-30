import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { makeSqliteScheduledMessageStore } from '../lib/Store/make-sqlite-scheduled-message-store.js'
import { MessageScheduler } from '../lib/Utils/scheduling.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const silentLogger = { debug: () => undefined, warn: () => undefined }

const cloneScheduled = scheduled => ({
	...scheduled,
	scheduledTime: new Date(scheduled.scheduledTime),
	createdAt: new Date(scheduled.createdAt)
})

class MemoryScheduledStore {
	rows = new Map()

	async loadPending() {
		return [...this.rows.values()]
			.filter(row => row.status === 'pending')
			.map(cloneScheduled)
	}

	async save(scheduled) {
		this.rows.set(scheduled.id, cloneScheduled(scheduled))
	}

	async update(scheduled) {
		this.rows.set(scheduled.id, cloneScheduled(scheduled))
	}

	async delete(id) {
		this.rows.delete(id)
	}
}

async function tempDatabase(t) {
	const dir = await mkdtemp(join(tmpdir(), 'baileysx-scheduler-'))
	const handles = []
	t.after(async () => {
		for (let i = handles.length - 1; i >= 0; i--) {
			try {
				handles[i].close()
			} catch {}
		}
		await rm(dir, { recursive: true, force: true })
	})
	return { dir, dbPath: join(dir, 'scheduler.db'), handles }
}

const jid = '123@s.whatsapp.net'

describe('MessageScheduler persistence', () => {
	it('persists scheduled and cancelled messages', async () => {
		const store = new MemoryScheduledStore()
		const scheduler = new MessageScheduler(async () => ({ key: { id: 'sent' } }), {
			store,
			checkInterval: 5,
			logger: silentLogger
		})

		const scheduled = scheduler.schedule(jid, { text: 'later' }, new Date(Date.now() + 5000))
		await wait(0)
		assert.equal(store.rows.get(scheduled.id).status, 'pending')
		assert.deepEqual(scheduler.getStats(), { pending: 1, restored: false, persistent: true })

		assert.equal(scheduler.cancel(scheduled.id), true)
		await wait(0)
		assert.equal(store.rows.get(scheduled.id).status, 'cancelled')
		scheduler.stop()
	})

	it('restores due pending messages after a restart and records success', async () => {
		const store = new MemoryScheduledStore()
		store.rows.set('due', {
			id: 'due',
			jid,
			content: { text: 'restored' },
			options: { messageId: 'restored-id' },
			scheduledTime: new Date(Date.now() - 1),
			createdAt: new Date(),
			status: 'pending'
		})

		const sent = []
		const scheduler = new MessageScheduler(async (to, content) => {
			sent.push({ to, content })
			return { key: { id: 'out' } }
		}, { store, checkInterval: 5, logger: silentLogger })

		await scheduler.restore()
		await wait(30)
		scheduler.stop()

		assert.equal(sent.length, 1)
		assert.equal(sent[0].to, jid)
		assert.deepEqual(sent[0].content, { text: 'restored' })
		assert.equal(store.rows.get('due').status, 'sent')
		assert.equal(store.rows.get('due').messageId, 'out')
	})

	it('records failures and keeps the failure reason', async () => {
		const store = new MemoryScheduledStore()
		store.rows.set('failed', {
			id: 'failed',
			jid,
			content: { text: 'nope' },
			scheduledTime: new Date(Date.now() - 1),
			createdAt: new Date(),
			status: 'pending'
		})

		const scheduler = new MessageScheduler(async () => {
			throw new Error('send failed')
		}, { store, checkInterval: 5, logger: silentLogger })

		await scheduler.restore()
		await wait(30)
		scheduler.stop()

		assert.equal(store.rows.get('failed').status, 'failed')
		assert.equal(store.rows.get('failed').error, 'send failed')
	})
})

describe('makeSqliteScheduledMessageStore', () => {
	it('round-trips scheduled messages and survives reopen', async t => {
		const { dbPath, handles } = await tempDatabase(t)
		const store = await makeSqliteScheduledMessageStore({ dbPath })
		handles.push(store)

		const scheduled = {
			id: 's1',
			jid,
			content: { text: 'sqlite outbox' },
			options: { messageId: 'm1' },
			scheduledTime: new Date(Date.now() + 10_000),
			createdAt: new Date(),
			status: 'pending'
		}

		await store.save(scheduled)
		assert.equal(store.count(), 1)
		assert.deepEqual(store.get('s1').content, { text: 'sqlite outbox' })
		assert.equal((await store.loadPending()).length, 1)

		await store.update({ ...scheduled, status: 'sent', messageId: 'sent-1' })
		assert.equal((await store.loadPending()).length, 0)
		store.close()

		const reopened = await makeSqliteScheduledMessageStore({ dbPath })
		handles.push(reopened)
		assert.equal(reopened.get('s1').status, 'sent')
		assert.equal(reopened.get('s1').messageId, 'sent-1')
		reopened.close()
	})

	it('restores a due message through the scheduler and persists the result', async t => {
		const { dbPath, handles } = await tempDatabase(t)
		const store = await makeSqliteScheduledMessageStore({ dbPath })
		handles.push(store)

		await store.save({
			id: 'due-sqlite',
			jid,
			content: { text: 'due' },
			scheduledTime: new Date(Date.now() - 1),
			createdAt: new Date(),
			status: 'pending'
		})

		const sent = []
		const scheduler = new MessageScheduler(async (to, content) => {
			sent.push({ to, content })
			return { key: { id: 'sqlite-sent' } }
		}, { store, checkInterval: 5, logger: silentLogger })

		await scheduler.restore()
		await wait(30)
		scheduler.stop()

		assert.equal(sent.length, 1)
		assert.equal(store.get('due-sqlite').status, 'sent')
		assert.equal(store.get('due-sqlite').messageId, 'sqlite-sent')
	})
})
