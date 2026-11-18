import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { proto } from '../WAProto/index.js'
import { aesEncryptGCM, hmacSign } from '../lib/Utils/crypto.js'
import { decryptEncReaction, decryptMessageEdit } from '../lib/Utils/process-message.js'

const deriveKey = (secret, msgId, senderJid, actorJid, label) => {
	const sign = Buffer.concat([
		Buffer.from(msgId),
		Buffer.from(senderJid),
		Buffer.from(actorJid),
		Buffer.from(label),
		new Uint8Array([1])
	])
	const key0 = hmacSign(secret, new Uint8Array(32), 'sha256')
	return hmacSign(sign, key0, 'sha256')
}

describe('decryptEncReaction', () => {
	const ctx = {
		targetSenderJid: '5211@s.whatsapp.net',
		targetMsgId: 'MSG123',
		targetEncKey: randomBytes(32),
		reactorJid: '5222@s.whatsapp.net'
	}

	const encrypt = (reaction, overrides = {}) => {
		const c = { ...ctx, ...overrides }
		const key = deriveKey(c.targetEncKey, c.targetMsgId, c.targetSenderJid, c.reactorJid, 'Enc Reaction')
		const encIv = randomBytes(12)
		const aad = Buffer.from(`${c.targetMsgId}\u0000${c.reactorJid}`)
		const plain = proto.Message.ReactionMessage.encode(reaction).finish()
		return { encPayload: aesEncryptGCM(plain, key, encIv, aad), encIv }
	}

	it('decrypts a reaction encrypted with the derived key', () => {
		const enc = encrypt({ text: '👍' })
		assert.equal(decryptEncReaction(enc, ctx).text, '👍')
	})

	it('fails with another reactor or another secret', () => {
		const enc = encrypt({ text: '👍' })
		assert.throws(() => decryptEncReaction(enc, { ...ctx, reactorJid: '5999@s.whatsapp.net' }))
		assert.throws(() => decryptEncReaction(enc, { ...ctx, targetEncKey: randomBytes(32) }))
	})
})

describe('decryptMessageEdit', () => {
	const ctx = {
		originalSenderJid: '5211@s.whatsapp.net',
		originalMsgId: 'MSG456',
		editEncKey: randomBytes(32),
		editorJid: '5211@s.whatsapp.net'
	}

	const encrypt = message => {
		const key = deriveKey(ctx.editEncKey, ctx.originalMsgId, ctx.originalSenderJid, ctx.editorJid, 'Message Edit')
		const encIv = randomBytes(12)
		const plain = proto.Message.encode(message).finish()
		return { encPayload: aesEncryptGCM(plain, key, encIv, Buffer.alloc(0)), encIv }
	}

	it('decrypts the edited message payload', () => {
		const enc = encrypt({
			protocolMessage: {
				type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
				editedMessage: { conversation: 'texto nuevo' }
			}
		})
		const result = decryptMessageEdit(enc, ctx)
		assert.equal(result.protocolMessage.editedMessage.conversation, 'texto nuevo')
	})

	it('fails with another editor', () => {
		const enc = encrypt({ conversation: 'x' })
		assert.throws(() => decryptMessageEdit(enc, { ...ctx, editorJid: '5999@s.whatsapp.net' }))
	})
})
