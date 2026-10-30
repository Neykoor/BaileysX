import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { makeSqliteStore } from '../lib/Store/make-sqlite-store.js'
import { useSqliteAuthState } from '../lib/Utils/use-sqlite-auth-state.js'

async function tempDatabase(t) {
	const dir = await mkdtemp(join(tmpdir(), 'baileysx-sqlite-'))
	const handles = []
	t.after(async () => {
		for (let i = handles.length - 1; i >= 0; i--) {
			try {
				handles[i].close()
			} catch {}
		}
		await rm(dir, { recursive: true, force: true })
	})
	return { dir, dbPath: join(dir, 'test.db'), handles }
}

const jid = '123@s.whatsapp.net'

function message(id, timestamp, text = id) {
	return {
		key: { remoteJid: jid, fromMe: false, id },
		message: { conversation: text },
		messageTimestamp: timestamp
	}
}

describe('useSqliteAuthState', () => {
	it('persists credentials and signal keys across reopen', async t => {
		const { dbPath, handles } = await tempDatabase(t)
		const first = await useSqliteAuthState({ dbPath })
		handles.push(first)
		first.state.creds.registered = false
		first.state.creds.accountSyncCounter = 7
		first.saveCreds()
		await first.state.keys.set({
			session: { '123.0': Buffer.from([1, 2, 3]) },
			'pre-key': { 1: { public: Buffer.alloc(32, 1), private: Buffer.alloc(32, 2) } },
			'lid-mapping': { 123: '456' }
		})
		first.close()

		const second = await useSqliteAuthState({ dbPath })
		handles.push(second)
		assert.equal(second.state.creds.accountSyncCounter, 7)
		assert.deepEqual(await second.state.keys.get('session', ['123.0']), {
			'123.0': Buffer.from([1, 2, 3])
		})
		assert.equal((await second.state.keys.get('pre-key', ['1']))['1'].private.length, 32)
		assert.equal((await second.state.keys.get('lid-mapping', ['123']))['123'], '456')
	})

	it('deletes keys and skips writes after close', async t => {
		const { dbPath, handles } = await tempDatabase(t)
		const auth = await useSqliteAuthState({ dbPath })
		handles.push(auth)
		await auth.state.keys.set({ session: { a: Buffer.from([1]) } })
		await auth.state.keys.set({ session: { a: null } })
		assert.deepEqual(await auth.state.keys.get('session', ['a']), {})

		auth.close()
		await auth.state.keys.set({ session: { b: Buffer.from([2]) } })
		assert.deepEqual(await auth.state.keys.get('session', ['b']), {})
		auth.saveCreds()
	})

	it('hydrates app-state sync keys through the protobuf decoder', async t => {
		const { dbPath, handles } = await tempDatabase(t)
		const auth = await useSqliteAuthState({ dbPath })
		handles.push(auth)
		await auth.state.keys.set({
			'app-state-sync-key': {
				key: { keyData: Buffer.from([1, 2, 3]), timestamp: 123 }
			}
		})

		const key = (await auth.state.keys.get('app-state-sync-key', ['key'])).key
		assert.equal(String(key.timestamp), '123')
		assert.deepEqual(Buffer.from(key.keyData), Buffer.from([1, 2, 3]))
	})
})

describe('makeSqliteStore', () => {
	it('stores and updates chats, contacts, groups and messages', async t => {
		const { dbPath, handles } = await tempDatabase(t)
		const store = await makeSqliteStore({ dbPath })
		handles.push(store)
		const ev = new EventEmitter()
		store.bind(ev)

		ev.emit('chats.upsert', [{ id: jid, name: 'Original', unreadCount: 0 }])
		ev.emit('contacts.upsert', [{ id: jid, name: 'Contact' }])
		ev.emit('groups.upsert', [{ id: '456@g.us', subject: 'Group', participants: [] }])
		ev.emit('messages.upsert', { messages: [message('m1', 1), message('m2', 2)], type: 'notify' })

		assert.equal(store.chats.get(jid).name, 'Original')
		assert.equal(store.contacts.get(jid).name, 'Contact')
		assert.equal(store.groupMetadata.get('456@g.us').subject, 'Group')
		assert.equal(store.messages.get(jid, 'm1').message.conversation, 'm1')
		assert.equal(store.messages.mostRecent(jid).key.id, 'm2')
		assert.deepEqual(
			store.messages.page(jid, 1).map(m => m.key.id),
			['m2']
		)

		ev.emit('chats.update', [{ id: jid, unreadCount: 3 }])
		ev.emit('contacts.update', [{ id: jid, name: 'Updated' }])
		assert.equal(store.chats.get(jid).name, 'Original')
		assert.equal(store.chats.get(jid).unreadCount, 3)
		assert.equal(store.contacts.get(jid).name, 'Updated')

		ev.emit('messages.update', [{ key: { remoteJid: jid, id: 'm1' }, update: { status: 2 } }])
		assert.equal(store.messages.get(jid, 'm1').status, 2)
		ev.emit('messages.update', [{ key: { remoteJid: jid, id: 'm1' }, update: { status: 1 } }])
		assert.equal(store.messages.get(jid, 'm1').status, 2)

		ev.emit('messages.delete', { keys: [{ remoteJid: jid, id: 'm1' }] })
		assert.equal(store.messages.get(jid, 'm1'), undefined)
		ev.emit('messages.delete', { all: true, jid })
		assert.equal(store.messages.get(jid, 'm2'), undefined)

		ev.emit('chats.delete', [jid])
		assert.equal(store.chats.get(jid), undefined)

		store.close()
		const reopened = await makeSqliteStore({ dbPath })
		handles.push(reopened)
		assert.equal(reopened.contacts.get(jid).name, 'Updated')
		assert.equal(reopened.groupMetadata.get('456@g.us').subject, 'Group')
	})

	it('paginates messages around a cursor', async t => {
		const { dbPath, handles } = await tempDatabase(t)
		const store = await makeSqliteStore({ dbPath })
		handles.push(store)
		const ev = new EventEmitter()
		store.bind(ev)

		const messages = Array.from({ length: 5 }, (_, i) => message(`m${i + 1}`, i + 1))
		ev.emit('messages.upsert', { messages, type: 'append' })

		assert.deepEqual(
			await store.loadMessages(jid, 2).then(rows => rows.map(m => m.key.id)),
			['m5', 'm4']
		)
		assert.deepEqual(
			(await store.loadMessages(jid, 2, { before: { remoteJid: jid, id: 'm4' } })).map(m => m.key.id),
			['m3', 'm2']
		)
		assert.deepEqual(
			(await store.loadMessages(jid, 2, { after: { remoteJid: jid, id: 'm2' } })).map(m => m.key.id),
			['m4', 'm3']
		)
	})

	it('does not skip messages that share a timestamp', async t => {
		const { dbPath, handles } = await tempDatabase(t)
		const store = await makeSqliteStore({ dbPath })
		handles.push(store)
		const ev = new EventEmitter()
		store.bind(ev)

		const messages = [message('m1', 1), message('m2', 2), message('m3', 2), message('m4', 3)]
		ev.emit('messages.upsert', { messages, type: 'append' })

		assert.deepEqual(
			store.messages.page(jid, 10).map(m => m.key.id),
			['m4', 'm3', 'm2', 'm1']
		)
		assert.deepEqual(
			(await store.loadMessages(jid, 2, { before: { remoteJid: jid, id: 'm3' } })).map(m => m.key.id),
			['m2', 'm1']
		)
		assert.deepEqual(
			(await store.loadMessages(jid, 2, { before: { remoteJid: jid, id: 'm2' } })).map(m => m.key.id),
			['m1']
		)
		assert.deepEqual(
			(await store.loadMessages(jid, 2, { after: { remoteJid: jid, id: 'm2' } })).map(m => m.key.id),
			['m4', 'm3']
		)
		assert.deepEqual(
			(await store.loadMessages(jid, 2, { after: { remoteJid: jid, id: 'm3' } })).map(m => m.key.id),
			['m4']
		)
	})

	it('stores messages under remoteJidAlt when present', async t => {
		const { dbPath, handles } = await tempDatabase(t)
		const store = await makeSqliteStore({ dbPath })
		handles.push(store)
		const ev = new EventEmitter()
		store.bind(ev)

		const alt = '999@lid'
		ev.emit('messages.upsert', {
			messages: [{ ...message('m1', 1), key: { remoteJid: jid, remoteJidAlt: alt, id: 'm1' } }],
			type: 'append'
		})
		assert.equal(store.messages.get(alt, 'm1').message.conversation, 'm1')
	})
})
