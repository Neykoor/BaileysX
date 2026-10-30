import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { initAuthCreds } from '../lib/Utils/auth-utils.js'
import { encodeBigEndian } from '../lib/Utils/generics.js'
import {
	extractDeviceJids,
	extractE2ESessionFromRetryReceipt,
	generateOrGetPreKeys,
	getNextPreKeys,
	getNextPreKeysNode,
	getPreKeys,
	parseAndInjectE2ESessions,
	xmppPreKey
} from '../lib/Utils/signal.js'
import { jidEncode } from '../lib/WABinary/jid-utils.js'
import { createMemoryKeyStore } from './support/signal.mjs'

const leaf = (tag, content, attrs = {}) => ({ tag, attrs, content })

function userNode(jid, registrationId, { preKey = true } = {}) {
	const content = [
		leaf('registration', encodeBigEndian(registrationId, 4)),
		leaf('identity', Buffer.alloc(32, 1)),
		{
			tag: 'skey',
			attrs: {},
			content: [
				leaf('id', encodeBigEndian(5, 3)),
				leaf('value', Buffer.alloc(32, 2)),
				leaf('signature', Buffer.alloc(64, 3))
			]
		}
	]

	if (preKey) {
		content.push({
			tag: 'key',
			attrs: {},
			content: [leaf('id', encodeBigEndian(7, 3)), leaf('value', Buffer.alloc(32, 4))]
		})
	}

	return { tag: 'user', attrs: { jid }, content }
}

describe('parseAndInjectE2ESessions', () => {
	it('injects every valid device in the response', async () => {
		const sessions = []
		const repository = {
			async injectE2ESession(input) {
				sessions.push(input)
			}
		}

		const users = [
			userNode('111@s.whatsapp.net', 1234),
			userNode('222:5@s.whatsapp.net', 4321)
		]
		await parseAndInjectE2ESessions({ tag: 'iq', attrs: {}, content: [{ tag: 'list', attrs: {}, content: users }] }, repository)

		assert.equal(sessions.length, 2)
		assert.equal(sessions[0].jid, '111@s.whatsapp.net')
		assert.equal(sessions[0].session.registrationId, 1234)
		assert.equal(sessions[0].session.identityKey.length, 33)
		assert.equal(sessions[0].session.signedPreKey.keyId, 5)
		assert.equal(sessions[0].session.signedPreKey.publicKey.length, 33)
		assert.equal(sessions[0].session.preKey.keyId, 7)
		assert.equal(sessions[0].session.preKey.publicKey.length, 33)
		assert.equal(sessions[1].jid, '222:5@s.whatsapp.net')
	})

	it('skips users with a missing or zero registration id', async () => {
		const sessions = []
		const repository = {
			async injectE2ESession(input) {
				sessions.push(input)
			}
		}

		const invalid = userNode('333@s.whatsapp.net', 0)
		const missing = userNode('444@s.whatsapp.net', 1)
		missing.content = missing.content.filter(node => node.tag !== 'registration')

		await parseAndInjectE2ESessions(
			{ tag: 'iq', attrs: {}, content: [{ tag: 'list', attrs: {}, content: [invalid, missing] }] },
			repository
		)

		assert.equal(sessions.length, 0)
	})
})

describe('extractE2ESessionFromRetryReceipt', () => {
	const registrationId = 9876
	function receipt({ type = 5, preKey = true } = {}) {
		const keys = [
			leaf('type', Buffer.from([type])),
			leaf('identity', Buffer.alloc(32, 1)),
			{
				tag: 'skey',
				attrs: {},
				content: [
					leaf('id', encodeBigEndian(5, 3)),
					leaf('value', Buffer.alloc(32, 2)),
					leaf('signature', Buffer.alloc(64, 3))
				]
			}
		]

		if (preKey) {
			keys.push({
				tag: 'key',
				attrs: {},
				content: [leaf('id', encodeBigEndian(7, 3)), leaf('value', Buffer.alloc(32, 4))]
			})
		}

		return {
			tag: 'receipt',
			attrs: {},
			content: [leaf('registration', encodeBigEndian(registrationId, 4)), { tag: 'keys', attrs: {}, content: keys }]
		}
	}

	it('parses a complete retry receipt', () => {
		const bundle = extractE2ESessionFromRetryReceipt(receipt())
		assert.equal(bundle.registrationId, registrationId)
		assert.equal(bundle.identityKey.length, 33)
		assert.equal(bundle.signedPreKey.keyId, 5)
		assert.equal(bundle.signedPreKey.publicKey.length, 33)
		assert.equal(bundle.signedPreKey.signature.length, 64)
		assert.equal(bundle.preKey.keyId, 7)
		assert.equal(bundle.preKey.publicKey.length, 33)
	})

	it('allows a receipt without a one-time prekey', () => {
		const bundle = extractE2ESessionFromRetryReceipt(receipt({ preKey: false }))
		assert.equal(bundle.preKey, undefined)
	})

	it('rejects invalid bundle versions and missing keys', () => {
		assert.equal(extractE2ESessionFromRetryReceipt(receipt({ type: 4 })), null)
		assert.equal(extractE2ESessionFromRetryReceipt({ tag: 'receipt', attrs: {}, content: [] }), null)
	})
})

describe('extractDeviceJids', () => {
	it('keeps hosted and non-hosted devices independent', () => {
		const result = [
			{
				id: '123@s.whatsapp.net',
				devices: {
					deviceList: [
						{ id: 99, keyIndex: 1, isHosted: true },
						{ id: 5, keyIndex: 2, isHosted: false }
					]
				}
			}
		]

		const devices = extractDeviceJids(result, '999:1@s.whatsapp.net', '888@lid', false)
		assert.deepEqual(
			devices.map(device => jidEncode(device.user, device.server, device.device)),
			['123:99@hosted', '123:5@s.whatsapp.net']
		)
		assert.deepEqual(
			devices.map(device => device.domainType),
			[128, 0]
		)
	})

	it('preserves the LID domain for non-hosted devices', () => {
		const result = [
			{
				id: '123@lid',
				devices: {
					deviceList: [
						{ id: 99, keyIndex: 1, isHosted: true },
						{ id: 5, keyIndex: 2, isHosted: false }
					]
				}
			}
		]

		const devices = extractDeviceJids(result, '999:1@s.whatsapp.net', '888@lid', false)
		assert.deepEqual(
			devices.map(device => jidEncode(device.user, device.server, device.device)),
			['123:99@hosted.lid', '123:5@lid']
		)
		assert.deepEqual(
			devices.map(device => device.domainType),
			[129, 1]
		)
	})

	it('excludes zero devices and requires key indexes for other devices', () => {
		const result = [
			{
				id: '123@s.whatsapp.net',
				devices: {
					deviceList: [
						{ id: 0, keyIndex: 1, isHosted: false },
						{ id: 5, keyIndex: undefined, isHosted: false },
						{ id: 6, keyIndex: 3, isHosted: false }
					]
				}
			}
		]

		const devices = extractDeviceJids(result, '999:1@s.whatsapp.net', '888@lid', true)
		assert.deepEqual(
			devices.map(device => jidEncode(device.user, device.server, device.device)),
			['123:6@s.whatsapp.net']
		)
	})
})

describe('prekey generation', () => {
	it('returns the requested number of wrapped prekeys', async () => {
		const state = { creds: initAuthCreds(), keys: createMemoryKeyStore() }
		const { update, preKeys } = await getNextPreKeys(state, 3)
		assert.equal(Object.keys(preKeys).length, 3)
		assert.equal(update.nextPreKeyId, 4)
		assert.equal(update.firstUnuploadedPreKeyId, 4)
	})

	it('builds an upload node containing registration, identity and keys', async () => {
		const state = { creds: initAuthCreds(), keys: createMemoryKeyStore() }
		const { node, update } = await getNextPreKeysNode(state, 2)
		const list = node.content.find(child => child.tag === 'list')
		assert.equal(list.content.length, 2)
		assert.ok(list.content.every(child => child.tag === 'key'))
		assert.equal(node.content.filter(child => child.tag === 'registration').length, 1)
		assert.equal(node.content.filter(child => child.tag === 'type').length, 1)
		assert.equal(node.content.filter(child => child.tag === 'identity').length, 1)
		assert.equal(update.nextPreKeyId, 3)
	})

	it('loads existing and newly generated prekeys by range', async () => {
		const store = createMemoryKeyStore()
		await store.set({
			'pre-key': {
				1: { public: Buffer.alloc(32, 1), private: Buffer.alloc(32, 1) },
				2: { public: Buffer.alloc(32, 2), private: Buffer.alloc(32, 2) }
			}
		})

		const loaded = await getPreKeys(store, 1, 3)
		assert.deepEqual(Object.keys(loaded), ['1', '2'])
	})

	it('reuses available prekeys and only generates the missing ones', () => {
		const creds = { ...initAuthCreds(), nextPreKeyId: 10, firstUnuploadedPreKeyId: 8 }
		const { newPreKeys, lastPreKeyId, preKeysRange } = generateOrGetPreKeys(creds, 4)
		assert.equal(lastPreKeyId, 11)
		assert.equal(preKeysRange[0], 8)
		assert.equal(preKeysRange[1], 4)
		assert.deepEqual(Object.keys(newPreKeys), ['10', '11'])
	})

	it('wraps prekey ids at the protocol limit', () => {
		const creds = { ...initAuthCreds(), nextPreKeyId: 0xffffff, firstUnuploadedPreKeyId: 0xffffff }
		const { newPreKeys } = generateOrGetPreKeys(creds, 3)
		assert.deepEqual(
			Object.keys(newPreKeys)
				.map(Number)
				.sort((a, b) => a - b),
			[1, 2, 16777215]
		)
	})
})

describe('xmppPreKey', () => {
	it('encodes the id in three bytes', () => {
		const node = xmppPreKey({ public: Buffer.alloc(32, 9), private: Buffer.alloc(32) }, 0x010203)
		assert.deepEqual([...node.content[0].content], [1, 2, 3])
		assert.equal(node.content[1].content.length, 32)
	})
})
