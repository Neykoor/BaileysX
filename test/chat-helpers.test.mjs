import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	displayUsername,
	getLidForPhone,
	getPhoneNumber,
	isUsernamePin,
	jidToPhone,
	phoneToJid,
	resolveSenderPn,
	stripUsernamePrefix,
	UsernameValidationError,
	validateE164,
	validateUsername
} from '../lib/Utils/chat-helpers.js'

const makeSock = (pnForLid = {}, lidForPn = {}) => ({
	signalRepository: {
		lidMapping: {
			getPNForLID: async lid => pnForLid[lid] ?? null,
			getLIDForPN: async pn => lidForPn[pn] ?? null
		}
	}
})

describe('getPhoneNumber', () => {
	it('returns the user part of a PN jid', async () => {
		assert.equal(await getPhoneNumber(undefined, '5215512345678@s.whatsapp.net'), '5215512345678')
	})

	it('resolves a LID through the lid mapping store', async () => {
		const sock = makeSock({ '999@lid': '5215512345678@s.whatsapp.net' })
		assert.equal(await getPhoneNumber(sock, '999@lid'), '5215512345678')
	})

	it('returns null for an unmapped LID and for other servers', async () => {
		assert.equal(await getPhoneNumber(makeSock(), '999@lid'), null)
		assert.equal(await getPhoneNumber(makeSock(), '123@g.us'), null)
	})

	it('throws on invalid input or a missing store', async () => {
		await assert.rejects(() => getPhoneNumber(makeSock(), 'nojid'), e => e.output.statusCode === 400)
		await assert.rejects(() => getPhoneNumber(undefined, '999@lid'), e => e.output.statusCode === 400)
	})
})

describe('resolveSenderPn / getLidForPhone', () => {
	it('prefers the participant over the remoteJid', async () => {
		const sock = makeSock({ '111@lid': '5211@s.whatsapp.net' })
		const msg = { key: { remoteJid: '123@g.us', participant: '111@lid' } }
		assert.equal(await resolveSenderPn(sock, msg), '5211')
	})

	it('rejects messages without a sender', async () => {
		await assert.rejects(() => resolveSenderPn(makeSock(), { key: {} }), e => e.output.statusCode === 400)
	})

	it('maps a phone number to its LID', async () => {
		const sock = makeSock({}, { '5211@s.whatsapp.net': '111@lid' })
		assert.equal(await getLidForPhone(sock, '+52 11'), '111@lid')
		assert.equal(await getLidForPhone(sock, '9999'), null)
		assert.equal(await getLidForPhone(sock, '5211'), '111@lid')
		assert.equal(await getLidForPhone(sock, '5211@s.whatsapp.net'), '111@lid')
	})

	it('requires a store and a phone', async () => {
		await assert.rejects(() => getLidForPhone(undefined, '5211'), e => e.output.statusCode === 400)
		await assert.rejects(() => getLidForPhone(makeSock(), ''), e => e.output.statusCode === 400)
	})
})

describe('phone helpers', () => {
	it('validates E.164 numbers', () => {
		assert.equal(validateE164(' +5215512345678 '), '+5215512345678')
		assert.equal(validateE164('5215512345678'), '+5215512345678')
		assert.throws(() => validateE164('0123456'))
		assert.throws(() => validateE164('12345'))
		assert.throws(() => validateE164('+1234567890123456'))
		assert.throws(() => validateE164(123), TypeError)
	})

	it('converts between jids and phones', () => {
		assert.equal(jidToPhone('5211:3@s.whatsapp.net'), '5211')
		assert.equal(jidToPhone('5211@c.us'), '5211')
		assert.equal(jidToPhone('999@lid'), '')
		assert.equal(phoneToJid('+52 (11) 22'), '521122@s.whatsapp.net')
		assert.equal(phoneToJid('123', true), '123@g.us')
		assert.throws(() => phoneToJid('abc'))
	})
})

describe('username helpers', () => {
	it('strips and displays the @ prefix', () => {
		assert.equal(stripUsernamePrefix('@ney'), 'ney')
		assert.equal(stripUsernamePrefix('ney'), 'ney')
		assert.equal(displayUsername('ney'), '@ney')
		assert.equal(displayUsername('@ney'), '@ney')
	})

	it('accepts valid usernames', () => {
		assert.deepEqual(validateUsername('neykoor'), { isValid: true })
		assert.deepEqual(validateUsername('@ney_koor.01'), { isValid: true })
	})

	it('reports the first failing rule', () => {
		const err = value => validateUsername(value).errorType
		assert.equal(err('ne y'), UsernameValidationError.INVALID_CHARACTER)
		assert.equal(err('ab'), UsernameValidationError.INVALID_LENGTH)
		assert.equal(err('a'.repeat(36)), UsernameValidationError.INVALID_LENGTH)
		assert.equal(err('12345'), UsernameValidationError.INVALID_NO_LETTERS)
		assert.equal(err('.ney'), UsernameValidationError.INVALID_PERIODS)
		assert.equal(err('ne..y'), UsernameValidationError.INVALID_PERIODS)
		assert.equal(err('www.ney'), UsernameValidationError.INVALID_WWW_PREFIX)
		assert.equal(err('ney.com'), UsernameValidationError.INVALID_DOMAIN_SUFFIX)
		assert.equal(err('mywhatsapp'), UsernameValidationError.INVALID_WORD)
	})

	it('checks 4 digit pins', () => {
		assert.equal(isUsernamePin('1234'), true)
		assert.equal(isUsernamePin('123'), false)
		assert.equal(isUsernamePin('12a4'), false)
		assert.equal(isUsernamePin(1234), false)
	})
})
