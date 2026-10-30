import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	aesDecrypt,
	aesDecryptCTR,
	aesDecryptGCM,
	aesEncrypt,
	aesEncryptCTR,
	aesEncryptGCM,
	Curve,
	derivePairingCodeKey,
	generateSignalPubKey,
	hmacSign,
	sha256,
	signedKeyPair
} from '../lib/Utils/crypto.js'

describe('Curve', () => {
	it('generates 32-byte X25519 key pairs', () => {
		const pair = Curve.generateKeyPair()
		assert.equal(pair.public.length, 32)
		assert.equal(pair.private.length, 32)
	})

	it('prefixes public keys exactly once', () => {
		const pair = Curve.generateKeyPair()
		const prefixed = generateSignalPubKey(pair.public)
		assert.equal(prefixed.length, 33)
		assert.equal(prefixed[0], 5)
		assert.equal(generateSignalPubKey(prefixed), prefixed)
	})

	it('derives the same shared secret from both sides', () => {
		const a = Curve.generateKeyPair()
		const b = Curve.generateKeyPair()
		assert.deepEqual(Curve.sharedKey(a.private, b.public), Curve.sharedKey(b.private, a.public))
	})

	it('verifies valid signatures', () => {
		const pair = Curve.generateKeyPair()
		const message = Buffer.from('signed payload')
		const signature = Curve.sign(pair.private, message)
		assert.equal(Curve.verify(pair.public, message, signature), true)
	})

	it('rejects modified signatures', () => {
		const pair = Curve.generateKeyPair()
		const message = Buffer.from('signed payload')
		const signature = Buffer.from(Curve.sign(pair.private, message))
		signature[0] ^= 0xff
		assert.equal(Curve.verify(pair.public, message, signature), false)
	})

	it('rejects signatures for a different message', () => {
		const pair = Curve.generateKeyPair()
		const signature = Curve.sign(pair.private, Buffer.from('original'))
		assert.equal(Curve.verify(pair.public, Buffer.from('tampered'), signature), false)
	})

	it('rejects malformed input instead of throwing', () => {
		assert.equal(Curve.verify(Buffer.alloc(3), Buffer.from('message'), Buffer.alloc(64)), false)
	})

	it('signs signed prekeys with the identity key', () => {
		const identity = Curve.generateKeyPair()
		const signed = signedKeyPair(identity, 9)
		assert.equal(
			Curve.verify(identity.public, generateSignalPubKey(signed.keyPair.public), signed.signature),
			true
		)
	})
})

describe('AES helpers', () => {
	const key = Buffer.alloc(32, 1)
	const iv = Buffer.alloc(16, 2)
	const aad = Buffer.from('additional data')
	const plaintext = Buffer.from('hello whatsapp')

	it('round-trips AES-256-GCM and rejects tampering', () => {
		const ciphertext = aesEncryptGCM(plaintext, key, iv, aad)
		assert.deepEqual(aesDecryptGCM(ciphertext, key, iv, aad), plaintext)

		const tampered = Buffer.from(ciphertext)
		tampered[0] ^= 0xff
		assert.throws(() => aesDecryptGCM(tampered, key, iv, aad))
	})

	it('round-trips AES-256-CTR', () => {
		const ciphertext = aesEncryptCTR(plaintext, key, iv)
		assert.deepEqual(aesDecryptCTR(ciphertext, key, iv), plaintext)
	})

	it('round-trips AES-256-CBC with a prefixed IV', () => {
		const ciphertext = aesEncrypt(plaintext, key)
		assert.deepEqual(aesDecrypt(ciphertext, key), plaintext)
	})
})

describe('hashing helpers', () => {
	it('computes HMAC and SHA-256', () => {
		assert.equal(hmacSign(Buffer.from('x'), Buffer.from('key')).length, 32)
		assert.equal(sha256(Buffer.from('x')).length, 32)
	})

	it('derives a deterministic pairing key', async () => {
		const salt = Buffer.alloc(16, 7)
		const first = await derivePairingCodeKey('ABCD-EFGH', salt)
		const second = await derivePairingCodeKey('ABCD-EFGH', salt)
		assert.equal(first.length, 32)
		assert.deepEqual(first, second)
	})
})
