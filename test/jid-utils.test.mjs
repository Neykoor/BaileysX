import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	areJidsSameUser,
	createLidPhoneCache,
	isHostedLidUser,
	isHostedPnUser,
	isJidBot,
	isJidBroadcast,
	isJidGroup,
	isJidMetaAI,
	isJidNewsletter,
	isJidStatusBroadcast,
	isLidUser,
	isPnUser,
	jidDecode,
	jidEncode,
	jidNormalizedUser,
	S_WHATSAPP_NET,
	transferDevice,
	WAJIDDomains
} from '../lib/WABinary/jid-utils.js'

describe('jidDecode / jidEncode', () => {
	it('decodes and encodes user JIDs', () => {
		const decoded = jidDecode('123456:7@s.whatsapp.net')
		assert.deepEqual(decoded, {
			server: 's.whatsapp.net',
			user: '123456',
			domainType: WAJIDDomains.WHATSAPP,
			device: 7
		})
		assert.equal(jidEncode(decoded.user, decoded.server, decoded.device), '123456:7@s.whatsapp.net')
	})

	it('decodes LID, hosted and hosted LID servers', () => {
		assert.equal(jidDecode('123@lid').domainType, WAJIDDomains.LID)
		assert.equal(jidDecode('123@hosted').domainType, WAJIDDomains.HOSTED)
		assert.equal(jidDecode('123@hosted.lid').domainType, WAJIDDomains.HOSTED_LID)
	})

	it('decodes agent/domain suffixes', () => {
		const decoded = jidDecode('123_128:4@hosted')
		assert.equal(decoded.user, '123')
		assert.equal(decoded.device, 4)
		assert.equal(decoded.domainType, WAJIDDomains.HOSTED)
		assert.equal(decoded.server, 'hosted')
	})

	it('returns undefined for strings without a server', () => {
		assert.equal(jidDecode('invalid'), undefined)
		assert.equal(jidDecode(undefined), undefined)
		assert.equal(jidNormalizedUser('invalid'), '')
	})

	it('normalizes JIDs by stripping device and mapping c.us to s.whatsapp.net', () => {
		assert.equal(jidNormalizedUser('123456:9@c.us'), '123456@s.whatsapp.net')
		assert.equal(jidNormalizedUser('123456:9@s.whatsapp.net'), '123456@s.whatsapp.net')
		assert.equal(jidNormalizedUser('123456@lid'), '123456@lid')
	})

	it('compares users regardless of device and server aliases', () => {
		assert.equal(areJidsSameUser('123:1@c.us', '123:99@s.whatsapp.net'), true)
		assert.equal(areJidsSameUser('123@lid', '456@lid'), false)
	})

	it('transfers devices between JIDs', () => {
		assert.equal(transferDevice('123:5@s.whatsapp.net', '456@lid'), '456:5@lid')
		assert.equal(transferDevice('123@s.whatsapp.net', '456@lid'), '456@lid')
	})
})

describe('JID predicates', () => {
	it('recognizes user and server types', () => {
		assert.equal(isPnUser('123@s.whatsapp.net'), true)
		assert.equal(isLidUser('123@lid'), true)
		assert.equal(isHostedPnUser('123@hosted'), true)
		assert.equal(isHostedLidUser('123@hosted.lid'), true)
		assert.equal(isJidGroup('123@g.us'), true)
		assert.equal(isJidBroadcast('123@broadcast'), true)
		assert.equal(isJidStatusBroadcast('status@broadcast'), true)
		assert.equal(isJidNewsletter('123@newsletter'), true)
		assert.equal(isJidMetaAI('123@bot'), true)
		assert.equal(isJidBot('13135550002@c.us'), true)
		assert.equal(isJidBot('13135550002@s.whatsapp.net'), false)
		assert.equal(isPnUser('123@lid'), false)
	})
})

describe('LID/phone cache', () => {
	it('stores and resolves both directions', () => {
		const cache = createLidPhoneCache()
		cache.set('111@lid', '222')
		assert.equal(cache.get('111@lid'), `222${S_WHATSAPP_NET}`)
		assert.equal(cache.get(`222${S_WHATSAPP_NET}`), '111@lid')
		assert.equal(cache.getLidForPhone('222@s.whatsapp.net'), '111@lid')
		assert.equal(cache.getPhoneForLid('111@lid'), '222@s.whatsapp.net')
		assert.equal(cache.size, 2)
	})

	it('ignores invalid values and clears entries', () => {
		const cache = createLidPhoneCache()
		cache.set(undefined, '222@s.whatsapp.net')
		cache.set('111@lid', undefined)
		cache.set('', '222@s.whatsapp.net')
		assert.equal(cache.size, 0)
		cache.set('111@lid', '222@s.whatsapp.net')
		cache.clear()
		assert.equal(cache.size, 0)
		assert.equal(cache.getLidForPhone('222@s.whatsapp.net'), undefined)
	})
})
