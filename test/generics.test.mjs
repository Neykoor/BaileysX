import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	BufferJSON,
	bytesToCrockford,
	encodeBigEndian,
	generateMessageID,
	generateMessageIDV2,
	generateParticipantHashV2,
	generateRegistrationId,
	getKeyAuthor,
	isStringNullOrEmpty,
	toNumber,
	unixTimestampSeconds,
	unpadRandomMax16,
	writeRandomPadMax16
} from '../lib/Utils/generics.js'
import { sha256 } from '../lib/Utils/crypto.js'

describe('BufferJSON', () => {
	it('round-trips Buffers and Uint8Arrays', () => {
		const source = {
			buffer: Buffer.from([1, 2, 3]),
			uint8: new Uint8Array([4, 5, 6]),
			nested: { value: Buffer.from('hello') },
			plain: 'text'
		}
		const decoded = JSON.parse(JSON.stringify(source, BufferJSON.replacer), BufferJSON.reviver)
		assert.deepEqual(decoded.buffer, source.buffer)
		assert.deepEqual(decoded.uint8, Buffer.from([4, 5, 6]))
		assert.deepEqual(decoded.nested.value, Buffer.from('hello'))
		assert.equal(decoded.plain, 'text')
	})

	it('accepts serialized Buffer objects and numeric byte maps', () => {
		const serialized = JSON.parse(
			JSON.stringify({ value: { type: 'Buffer', data: Buffer.from([7, 8, 9]).toString('base64') } }),
			BufferJSON.reviver
		)
		assert.deepEqual(serialized.value, Buffer.from([7, 8, 9]))

		const numeric = JSON.parse(JSON.stringify({ 0: 7, 1: 8, 2: 9 }), BufferJSON.reviver)
		assert.deepEqual(numeric, Buffer.from([7, 8, 9]))
	})
})

describe('padding', () => {
	it('round-trips random PKCS#7 padding', () => {
		for (let i = 0; i < 100; i++) {
			const message = Buffer.from(`message-${i}`)
			const padded = writeRandomPadMax16(message)
			assert.ok(padded.length > message.length)
			assert.ok(padded.length - message.length <= 16)
			assert.deepEqual(Buffer.from(unpadRandomMax16(padded)), message)
		}
	})

	it('rejects empty input and impossible padding', () => {
		assert.throws(() => unpadRandomMax16(Buffer.alloc(0)))
		assert.throws(() => unpadRandomMax16(Buffer.from([0, 255])))
	})
})

describe('identifiers and timestamps', () => {
	it('encodes big-endian integers', () => {
		assert.deepEqual([...encodeBigEndian(0x010203, 3)], [1, 2, 3])
		assert.deepEqual([...encodeBigEndian(1)], [0, 0, 0, 1])
		assert.deepEqual([...encodeBigEndian(0x12345678)], [0x12, 0x34, 0x56, 0x78])
	})

	it('generates 14-bit registration IDs', () => {
		for (let i = 0; i < 200; i++) {
			const id = generateRegistrationId()
			assert.ok(Number.isInteger(id))
			assert.ok(id >= 0 && id <= 16383)
		}
	})

	it('generates WhatsApp message IDs', () => {
		const legacy = generateMessageID()
		const modern = generateMessageIDV2('123@s.whatsapp.net')
		assert.match(legacy, /^3EB0[0-9A-F]{36}$/)
		assert.match(modern, /^3EB0[0-9A-F]{18}$/)
		assert.notEqual(legacy, generateMessageID())
		assert.notEqual(modern, generateMessageIDV2('123@s.whatsapp.net'))
	})

	it('converts seconds and Long-like values', () => {
		assert.equal(unixTimestampSeconds(new Date(1_700_000_000_000)), 1_700_000_000)
		assert.equal(toNumber(undefined), 0)
		assert.equal(toNumber(42), 42)
		assert.equal(toNumber({ toNumber: () => 7 }), 7)
		assert.equal(toNumber({ low: 9 }), 9)
	})
})

describe('message helpers', () => {
	it('derives a stable participant hash independently of order', () => {
		const a = ['123@s.whatsapp.net', '456@s.whatsapp.net']
		const b = ['456@s.whatsapp.net', '123@s.whatsapp.net']
		const expected = '2:' + sha256(Buffer.from([...a].sort().join(''))).toString('base64').slice(0, 6)
		assert.equal(generateParticipantHashV2(a), expected)
		assert.equal(generateParticipantHashV2(b), expected)
	})

	it('resolves the message author', () => {
		assert.equal(getKeyAuthor({ fromMe: true, remoteJid: '1@s.whatsapp.net' }, 'me@s.whatsapp.net'), 'me@s.whatsapp.net')
		assert.equal(
			getKeyAuthor({ fromMe: false, remoteJid: '1@s.whatsapp.net', participantAlt: '2@lid' }, 'me'),
			'2@lid'
		)
		assert.equal(getKeyAuthor({ fromMe: false, remoteJid: '1@s.whatsapp.net' }, 'me'), '1@s.whatsapp.net')
		assert.equal(getKeyAuthor(null), '')
	})

	it('detects null/empty strings', () => {
		assert.equal(isStringNullOrEmpty(undefined), true)
		assert.equal(isStringNullOrEmpty(null), true)
		assert.equal(isStringNullOrEmpty(''), true)
		assert.equal(isStringNullOrEmpty('x'), false)
	})

	it('encodes Crockford base32', () => {
		assert.equal(bytesToCrockford(Buffer.alloc(0)), '')
		assert.equal(bytesToCrockford(Buffer.from([0])), '11')
		assert.equal(bytesToCrockford(Buffer.from([0xff])), 'ZW')
	})
})
