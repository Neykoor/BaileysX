import assert from 'node:assert/strict'
import * as libsignal from 'libsignal'
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js'
import { Curve, generateSignalPubKey, signedKeyPair } from '../lib/Utils/crypto.js'

const KEY_BUNDLE_TYPE = Buffer.from([5])
const prefixKey = value => (value.length === 33 ? Buffer.from(value) : Buffer.concat([KEY_BUNDLE_TYPE, value]))

const noop = () => {}
const logger = {
	trace: noop,
	debug: noop,
	info: noop,
	warn: noop,
	error: noop,
	child: () => logger
}

function createKeyStore() {
	const data = new Map()

	const get = async (type, ids) => {
		const bucket = data.get(type) || {}
		const result = {}
		for (const id of ids) {
			if (Object.prototype.hasOwnProperty.call(bucket, id)) {
				result[id] = bucket[id]
			}
		}
		return result
	}

	const set = async updates => {
		for (const [type, values] of Object.entries(updates)) {
			let bucket = data.get(type)
			if (!bucket) {
				bucket = {}
				data.set(type, bucket)
			}

			for (const [id, value] of Object.entries(values)) {
				if (value === null || value === undefined) {
					delete bucket[id]
				} else {
					bucket[id] = value
				}
			}
		}
	}

	return {
		get,
		set,
		isInTransaction: () => false,
		transaction: async work => work()
	}
}

function makeIdentity() {
	const identity = Curve.generateKeyPair()
	const signedPreKey = signedKeyPair(identity, 1)
	return {
		identity,
		signedPreKey,
		creds: {
			signedIdentityKey: identity,
			signedPreKey,
			registrationId: libsignal.keyhelper.generateRegistrationId()
		}
	}
}

const identityForSignature = Curve.generateKeyPair()
const signedPreKeyForSignature = signedKeyPair(identityForSignature, 9)
assert.equal(
	Curve.verify(
		identityForSignature.public,
		generateSignalPubKey(signedPreKeyForSignature.keyPair.public),
		signedPreKeyForSignature.signature
	),
	true
)
assert.equal(
	libsignal.curve.verifySignature(
		generateSignalPubKey(identityForSignature.public),
		generateSignalPubKey(signedPreKeyForSignature.keyPair.public),
		signedPreKeyForSignature.signature
	),
	true
)
const sharedA = Curve.generateKeyPair()
const sharedB = Curve.generateKeyPair()
assert.deepEqual(Curve.sharedKey(sharedA.private, sharedB.public), Curve.sharedKey(sharedB.private, sharedA.public))
assert.equal(libsignal.keyhelper.wrapPreKeyId(1), 1)
assert.equal(libsignal.keyhelper.wrapPreKeyId(0x1000000), 1)
assert.equal(libsignal.keyhelper.shouldRotateSignedPreKey(Date.now()), false)
assert.equal(libsignal.keyhelper.shouldRotateSignedPreKey(Date.now() - 8 * 24 * 60 * 60 * 1000), true)

function makeRepository(creds, keys) {
	return makeLibSignalRepository({ creds, keys }, logger)
}

const aliceJid = '111@s.whatsapp.net'
const bobJid = '222@s.whatsapp.net'
const groupJid = '123456789@g.us'

const aliceKeys = createKeyStore()
const bobKeys = createKeyStore()
const alice = makeIdentity()
const bob = makeIdentity()

const bobPreKey = Curve.generateKeyPair()
const bobPreKeyId = 7
await bobKeys.set({
	'pre-key': {
		[String(bobPreKeyId)]: {
			public: Buffer.from(bobPreKey.public),
			private: Buffer.from(bobPreKey.private)
		}
	}
})

const alicePreKey = Curve.generateKeyPair()
const alicePreKeyId = 11
await aliceKeys.set({
	'pre-key': {
		[String(alicePreKeyId)]: {
			public: Buffer.from(alicePreKey.public),
			private: Buffer.from(alicePreKey.private)
		}
	}
})

const aliceRepository = makeRepository(alice.creds, aliceKeys)
const bobRepository = makeRepository(bob.creds, bobKeys)

await aliceRepository.injectE2ESession({
	jid: bobJid,
	session: {
		registrationId: bob.creds.registrationId,
		identityKey: prefixKey(bob.identity.public),
		signedPreKey: {
			keyId: bob.signedPreKey.keyId,
			publicKey: prefixKey(bob.signedPreKey.keyPair.public),
			signature: Buffer.from(bob.signedPreKey.signature)
		},
		preKey: {
			keyId: bobPreKeyId,
			publicKey: prefixKey(bobPreKey.public)
		}
	}
})

const first = await aliceRepository.encryptMessage({ jid: bobJid, data: Buffer.from('hello bob') })
assert.equal(first.type, 'pkmsg')
const firstPlaintext = await bobRepository.decryptMessage({
	jid: aliceJid,
	type: first.type,
	ciphertext: first.ciphertext
})
assert.equal(Buffer.from(firstPlaintext).toString(), 'hello bob')

const second = await aliceRepository.encryptMessage({ jid: bobJid, data: Buffer.from('second message') })
assert.equal(second.type, 'pkmsg')
const secondPlaintext = await bobRepository.decryptMessage({
	jid: aliceJid,
	type: second.type,
	ciphertext: second.ciphertext
})
assert.equal(Buffer.from(secondPlaintext).toString(), 'second message')

const reply = await bobRepository.encryptMessage({ jid: aliceJid, data: Buffer.from('hello alice') })
const replyPlaintext = await aliceRepository.decryptMessage({
	jid: bobJid,
	type: reply.type,
	ciphertext: reply.ciphertext
})
assert.equal(Buffer.from(replyPlaintext).toString(), 'hello alice')

const third = await aliceRepository.encryptMessage({ jid: bobJid, data: Buffer.from('session established') })
assert.equal(third.type, 'msg')
const thirdPlaintext = await bobRepository.decryptMessage({
	jid: aliceJid,
	type: third.type,
	ciphertext: third.ciphertext
})
assert.equal(Buffer.from(thirdPlaintext).toString(), 'session established')

const groupMessage = await aliceRepository.encryptGroupMessage({
	group: groupJid,
	meId: aliceJid,
	data: Buffer.from('hello group')
})
await bobRepository.processSenderKeyDistributionMessage({
	authorJid: aliceJid,
	item: {
		groupId: groupJid,
		axolotlSenderKeyDistributionMessage: groupMessage.senderKeyDistributionMessage
	}
})
const groupPlaintext = await bobRepository.decryptGroupMessage({
	group: groupJid,
	authorJid: aliceJid,
	msg: groupMessage.ciphertext
})
assert.equal(Buffer.from(groupPlaintext).toString(), 'hello group')

const groupReply = await bobRepository.encryptGroupMessage({
	group: groupJid,
	meId: bobJid,
	data: Buffer.from('hello group from bob')
})
await aliceRepository.processSenderKeyDistributionMessage({
	authorJid: bobJid,
	item: {
		groupId: groupJid,
		axolotlSenderKeyDistributionMessage: groupReply.senderKeyDistributionMessage
	}
})
const groupReplyPlaintext = await aliceRepository.decryptGroupMessage({
	group: groupJid,
	authorJid: bobJid,
	msg: groupReply.ciphertext
})
assert.equal(Buffer.from(groupReplyPlaintext).toString(), 'hello group from bob')

assert.equal(await aliceRepository.hasSenderKey({ group: groupJid, meId: aliceJid }), true)
assert.equal(await bobRepository.hasSenderKey({ group: groupJid, meId: bobJid }), true)
assert.ok((await aliceRepository.getSenderKeyDistributionMessage({ group: groupJid, meId: aliceJid })).length > 0)
assert.ok((await aliceRepository.rotateSenderKey({ group: groupJid, meId: aliceJid })).length > 0)

const sessionInfo = await aliceRepository.getSessionInfo(bobJid)
assert.ok(sessionInfo?.baseKey?.length)
assert.equal(typeof sessionInfo?.registrationId, 'number')
assert.deepEqual(await aliceRepository.validateSession(bobJid), { exists: true })

const aliceBundle = {
	registrationId: alice.creds.registrationId,
	identityKey: prefixKey(alice.identity.public),
	signedPreKey: {
		keyId: alice.signedPreKey.keyId,
		publicKey: prefixKey(alice.signedPreKey.keyPair.public),
		signature: Buffer.from(alice.signedPreKey.signature)
	},
	preKey: {
		keyId: alicePreKeyId,
		publicKey: prefixKey(alicePreKey.public)
	}
}

const bob2 = makeIdentity()
const bob2Keys = createKeyStore()
const bob2Repository = makeRepository(bob2.creds, bob2Keys)
await bob2Repository.injectE2ESession({ jid: aliceJid, session: aliceBundle })
const changedIdentityMessage = await bob2Repository.encryptMessage({
	jid: aliceJid,
	data: Buffer.from('new identity')
})
assert.equal(changedIdentityMessage.type, 'pkmsg')
const changedIdentityPlaintext = await aliceRepository.decryptMessage({
	jid: bobJid,
	type: changedIdentityMessage.type,
	ciphertext: changedIdentityMessage.ciphertext
})
assert.equal(Buffer.from(changedIdentityPlaintext).toString(), 'new identity')

await aliceRepository.deleteSession([bobJid])
assert.deepEqual(await aliceRepository.validateSession(bobJid), { exists: false, reason: 'no session' })

console.log('libsignal smoke test passed: 1:1, replies, identity change, group send/receive')
