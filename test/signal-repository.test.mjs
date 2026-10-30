import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Curve, makeBundle, makeRecipient, prefixKey } from './support/signal.mjs'

const aliceJid = '111@s.whatsapp.net'
const bobJid = '222@s.whatsapp.net'
const groupJid = '123456789@g.us'

async function setupConversation() {
	const alice = await makeRecipient({ preKeyId: 11 })
	const bob = await makeRecipient({ preKeyId: 7 })
	await alice.repository.injectE2ESession({
		jid: bobJid,
		session: makeBundle(bob.identity, bob.preKey, bob.preKeyId)
	})
	return { alice, bob }
}

describe('makeLibSignalRepository', () => {
	it('establishes a 1:1 session and exchanges messages both ways', async () => {
		const { alice, bob } = await setupConversation()

		const first = await alice.repository.encryptMessage({ jid: bobJid, data: Buffer.from('hello bob') })
		assert.equal(first.type, 'pkmsg')
		const firstPlaintext = await bob.repository.decryptMessage({
			jid: aliceJid,
			type: first.type,
			ciphertext: first.ciphertext
		})
		assert.equal(Buffer.from(firstPlaintext).toString(), 'hello bob')

		const reply = await bob.repository.encryptMessage({ jid: aliceJid, data: Buffer.from('hello alice') })
		const replyPlaintext = await alice.repository.decryptMessage({
			jid: bobJid,
			type: reply.type,
			ciphertext: reply.ciphertext
		})
		assert.equal(Buffer.from(replyPlaintext).toString(), 'hello alice')

		const established = await alice.repository.encryptMessage({ jid: bobJid, data: Buffer.from('session ready') })
		assert.equal(established.type, 'msg')
		const establishedPlaintext = await bob.repository.decryptMessage({
			jid: aliceJid,
			type: established.type,
			ciphertext: established.ciphertext
		})
		assert.equal(Buffer.from(establishedPlaintext).toString(), 'session ready')

		const info = await alice.repository.getSessionInfo(bobJid)
		assert.ok(info.baseKey instanceof Uint8Array)
		assert.equal(typeof info.registrationId, 'number')
		assert.deepEqual(await alice.repository.validateSession(bobJid), { exists: true })
	})

	it('replaces a stale session when the remote identity changes', async () => {
		const { alice, bob } = await setupConversation()

		const first = await alice.repository.encryptMessage({ jid: bobJid, data: Buffer.from('first') })
		await bob.repository.decryptMessage({ jid: aliceJid, type: first.type, ciphertext: first.ciphertext })

		const bob2 = await makeRecipient({ preKeyId: 21 })
		await bob2.repository.injectE2ESession({
			jid: aliceJid,
			session: makeBundle(alice.identity, alice.preKey, alice.preKeyId)
		})

		const changed = await bob2.repository.encryptMessage({ jid: aliceJid, data: Buffer.from('new identity') })
		assert.equal(changed.type, 'pkmsg')
		const plaintext = await alice.repository.decryptMessage({
			jid: bobJid,
			type: changed.type,
			ciphertext: changed.ciphertext
		})
		assert.equal(Buffer.from(plaintext).toString(), 'new identity')
	})

	it('normalizes registration ids that exceed 14 bits', async () => {
		const alice = await makeRecipient({ preKeyId: 11 })
		const bob = await makeRecipient({ preKeyId: 7 })
		const bundle = makeBundle(bob.identity, bob.preKey, bob.preKeyId)
		bundle.registrationId = 0x4002

		await alice.repository.injectE2ESession({ jid: bobJid, session: bundle })
		assert.equal(bundle.registrationId, 2)

		const zeroBundle = makeBundle(bob.identity, bob.preKey, bob.preKeyId)
		zeroBundle.registrationId = 0
		await alice.repository.injectE2ESession({ jid: bobJid, session: zeroBundle })
		assert.equal(zeroBundle.registrationId, 1)
	})

	it('deletes sessions', async () => {
		const { alice } = await setupConversation()
		assert.deepEqual(await alice.repository.validateSession(bobJid), { exists: true })
		await alice.repository.deleteSession([bobJid])
		assert.deepEqual(await alice.repository.validateSession(bobJid), { exists: false, reason: 'no session' })
		assert.equal(await alice.repository.getSessionInfo(bobJid), null)
	})

	it('maps JIDs to Signal protocol addresses', async () => {
		const { alice } = await setupConversation()
		assert.equal(alice.repository.jidToSignalProtocolAddress('123@s.whatsapp.net'), '123.0')
		assert.equal(alice.repository.jidToSignalProtocolAddress('123:5@s.whatsapp.net'), '123.5')
		assert.equal(alice.repository.jidToSignalProtocolAddress('123@lid'), '123_1.0')
		assert.equal(alice.repository.jidToSignalProtocolAddress('123@hosted'), '123_128.0')
		assert.equal(alice.repository.jidToSignalProtocolAddress('123@hosted.lid'), '123_129.0')
		assert.equal(alice.repository.jidToSignalProtocolAddress('123:99@hosted'), '123_128.99')
		assert.throws(() => alice.repository.jidToSignalProtocolAddress('123:99@s.whatsapp.net'))
		assert.throws(() => alice.repository.jidToSignalProtocolAddress('@s.whatsapp.net'))
	})

	it('migrates an established PN session to a LID address', async () => {
		const { alice } = await setupConversation()
		const first = await alice.repository.encryptMessage({ jid: bobJid, data: Buffer.from('migrate me') })
		assert.equal(first.type, 'pkmsg')

		await alice.keys.set({ 'device-list': { 222: ['0'] } })
		const result = await alice.repository.migrateSession(bobJid, '999@lid')
		assert.deepEqual(result, { migrated: 1, skipped: 0, total: 1 })

		const lidSession = await alice.keys.get('session', ['999_1.0'])
		assert.ok(lidSession['999_1.0'])
		assert.deepEqual(await alice.keys.get('session', ['222.0']), {})
		assert.ok(await alice.repository.getSessionInfo('999@lid'))
		assert.deepEqual(await alice.repository.validateSession(bobJid), { exists: false, reason: 'no session' })
	})

	it('creates, rotates and distributes group sender keys', async () => {
		const { alice, bob } = await setupConversation()

		assert.equal(await alice.repository.hasSenderKey({ group: groupJid, meId: aliceJid }), false)
		const first = await alice.repository.encryptGroupMessage({
			group: groupJid,
			meId: aliceJid,
			data: Buffer.from('hello group')
		})
		assert.ok(first.senderKeyDistributionMessage.length > 0)
		assert.equal(await alice.repository.hasSenderKey({ group: groupJid, meId: aliceJid }), true)

		await bob.repository.processSenderKeyDistributionMessage({
			authorJid: aliceJid,
			item: { groupId: groupJid, axolotlSenderKeyDistributionMessage: first.senderKeyDistributionMessage }
		})
		const plaintext = await bob.repository.decryptGroupMessage({
			group: groupJid,
			authorJid: aliceJid,
			msg: first.ciphertext
		})
		assert.equal(Buffer.from(plaintext).toString(), 'hello group')

		const beforeRotation = await alice.repository.getSenderKeyDistributionMessage({ group: groupJid, meId: aliceJid })
		const rotated = await alice.repository.rotateSenderKey({ group: groupJid, meId: aliceJid })
		assert.ok(rotated.length > 0)
		assert.notDeepEqual(rotated, beforeRotation)

		const second = await alice.repository.encryptGroupMessage({
			group: groupJid,
			meId: aliceJid,
			data: Buffer.from('after rotation')
		})
		await bob.repository.processSenderKeyDistributionMessage({
			authorJid: aliceJid,
			item: { groupId: groupJid, axolotlSenderKeyDistributionMessage: second.senderKeyDistributionMessage }
		})
		const secondPlaintext = await bob.repository.decryptGroupMessage({
			group: groupJid,
			authorJid: aliceJid,
			msg: second.ciphertext
		})
		assert.equal(Buffer.from(secondPlaintext).toString(), 'after rotation')
	})

	it('rejects sender key distribution messages without a group id', async () => {
		const { bob } = await setupConversation()
		await assert.rejects(
			bob.repository.processSenderKeyDistributionMessage({
				authorJid: aliceJid,
				item: { axolotlSenderKeyDistributionMessage: Buffer.from([1]) }
			}),
			/Group ID is required/
		)
	})

	it('removes sender keys for participants', async () => {
		const { alice } = await setupConversation()
		await alice.repository.encryptGroupMessage({ group: groupJid, meId: aliceJid, data: Buffer.from('x') })
		assert.equal(await alice.repository.hasSenderKey({ group: groupJid, meId: aliceJid }), true)
		await alice.repository.removeGroupParticipantSessions({ group: groupJid, participants: [aliceJid] })
		assert.equal(await alice.repository.hasSenderKey({ group: groupJid, meId: aliceJid }), false)
	})

	it('exposes a shared signature helper', () => {
		const pair = Curve.generateKeyPair()
		const message = Buffer.from('x')
		assert.equal(Curve.verify(pair.public, message, Curve.sign(pair.private, message)), true)
		assert.equal(prefixKey(pair.public).length, 33)
	})
})
