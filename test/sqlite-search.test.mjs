import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { makeSqliteStore } from '../lib/Store/make-sqlite-store.js'
import { extractMessageText } from '../lib/Utils/messages.js'

async function tempDatabase(t) {
	const dir = await mkdtemp(join(tmpdir(), 'baileysx-search-'))
	const handles = []
	t.after(async () => {
		for (let i = handles.length - 1; i >= 0; i--) {
			try {
				handles[i].close()
			} catch {}
		}
		await rm(dir, { recursive: true, force: true })
	})
	return { dir, dbPath: join(dir, 'search.db'), handles }
}

const jid = '123@s.whatsapp.net'
const otherJid = '456@s.whatsapp.net'

function message(id, timestamp, content, remoteJid = jid) {
	return {
		key: { remoteJid, fromMe: false, id },
		message: content,
		messageTimestamp: timestamp
	}
}

describe('extractMessageText', () => {
	it('indexes plain text, captions, filenames and edited messages', () => {
		assert.equal(extractMessageText({ conversation: 'hello' }), 'hello')
		assert.equal(extractMessageText({ extendedTextMessage: { text: 'extended' } }), 'extended')
		assert.equal(extractMessageText({ imageMessage: { caption: 'caption' } }), 'caption')
		assert.equal(extractMessageText({ documentMessage: { fileName: 'file.pdf' } }), 'file.pdf')
		assert.equal(
			extractMessageText({ protocolMessage: { editedMessage: { conversation: 'edited' } } }),
			'edited'
		)
		assert.equal(extractMessageText(undefined), '')
	})
})

describe('makeSqliteStore search and retention', () => {
	it('searches text, captions and filenames with optional JID filters', async t => {
		const { dbPath, handles } = await tempDatabase(t)
		const store = await makeSqliteStore({ dbPath })
		handles.push(store)
		const ev = new EventEmitter()
		store.bind(ev)

		ev.emit('messages.upsert', {
			messages: [
				message('m1', 1, { conversation: 'Hello World' }),
				message('m2', 2, { imageMessage: { caption: 'Holiday in Paris' } }),
				message('m3', 3, { documentMessage: { caption: 'invoice', fileName: 'invoice-2026.pdf' } }),
				message('m4', 4, { extendedTextMessage: { text: 'meeting notes' } }),
				message('m5', 5, { conversation: 'hello again' }),
				message('m6', 6, { conversation: 'hello other' }, otherJid)
			],
			type: 'notify'
		})

		assert.deepEqual(
			store.messages.search('hello').map(m => m.key.id),
			['m6', 'm5', 'm1']
		)
		assert.deepEqual(
			store.messages.search('hello', { jid }).map(m => m.key.id),
			['m5', 'm1']
		)
		assert.deepEqual(
			store.messages.search('holiday').map(m => m.key.id),
			['m2']
		)
		assert.deepEqual(
			store.messages.search('invoice').map(m => m.key.id),
			['m3']
		)
		assert.deepEqual(
			store.messages.search('meeting').map(m => m.key.id),
			['m4']
		)
		assert.deepEqual(
			store.messages.search('hello', { limit: 1 }).map(m => m.key.id),
			['m6']
		)
		assert.doesNotThrow(() => store.messages.search('hello "world" OR'))
		assert.deepEqual(store.messages.search('   '), [])
		assert.equal(store.messages.count(), 6)
		assert.equal(store.messages.count(jid), 5)
	})

	it('falls back to LIKE when FTS5 is unavailable at query time', async t => {
		const { dbPath, handles } = await tempDatabase(t)
		const store = await makeSqliteStore({ dbPath })
		handles.push(store)
		const ev = new EventEmitter()
		store.bind(ev)
		ev.emit('messages.upsert', {
			messages: [message('m1', 1, { conversation: 'fallback search' })],
			type: 'notify'
		})

		store.db.exec('DROP TABLE messages_fts')
		assert.deepEqual(
			store.messages.search('fallback').map(m => m.key.id),
			['m1']
		)
	})

	it('rebuilds the search index from stored messages', async t => {
		const { dbPath, handles } = await tempDatabase(t)
		const store = await makeSqliteStore({ dbPath })
		handles.push(store)
		const ev = new EventEmitter()
		store.bind(ev)
		ev.emit('messages.upsert', {
			messages: [message('m1', 1, { conversation: 'rebuild me' })],
			type: 'notify'
		})

		store.db.exec('DELETE FROM message_search; DELETE FROM messages_fts')
		assert.equal(store.messages.search('rebuild').length, 0)
		assert.equal(store.rebuildSearchIndex(), 1)
		assert.deepEqual(
			store.messages.search('rebuild').map(m => m.key.id),
			['m1']
		)
	})

	it('prunes old messages and keeps the FTS index in sync', async t => {
		const { dbPath, handles } = await tempDatabase(t)
		const store = await makeSqliteStore({ dbPath })
		handles.push(store)
		const ev = new EventEmitter()
		store.bind(ev)
		ev.emit('messages.upsert', {
			messages: [
				message('m1', 1, { conversation: 'old one' }),
				message('m2', 2, { conversation: 'old two' }),
				message('m3', 3, { conversation: 'middle' }),
				message('m4', 4, { conversation: 'newer' }),
				message('m5', 5, { conversation: 'newest' })
			],
			type: 'notify'
		})

		assert.equal(store.messages.prune({ jid, olderThan: 3 }), 2)
		assert.equal(store.messages.count(jid), 3)
		assert.equal(store.messages.get(jid, 'm1'), undefined)
		assert.equal(store.messages.search('old').length, 0)

		assert.equal(store.messages.prune({ jid, keepLatest: 1 }), 2)
		assert.equal(store.messages.count(jid), 1)
		assert.deepEqual(
			store.messages.page(jid).map(m => m.key.id),
			['m5']
		)
		assert.equal(store.messages.search('middle').length, 0)

		assert.throws(() => store.messages.prune({}), /requires/)
		assert.throws(() => store.messages.prune({ keepLatest: 1 }), /jid/)
		assert.throws(() => store.messages.prune({ jid, keepLatest: -1 }), /non-negative/)
	})

	it('creates a consistent backup that can be reopened', async t => {
		const { dir, dbPath, handles } = await tempDatabase(t)
		const store = await makeSqliteStore({ dbPath })
		handles.push(store)
		const ev = new EventEmitter()
		store.bind(ev)
		ev.emit('messages.upsert', {
			messages: [message('m1', 1, { conversation: 'backup search' })],
			type: 'notify'
		})

		const backupPath = join(dir, 'backup.db')
		store.backupTo(backupPath)
		const backup = await makeSqliteStore({ dbPath: backupPath })
		handles.push(backup)
		assert.deepEqual(
			backup.messages.search('backup').map(m => m.key.id),
			['m1']
		)
	})
})
