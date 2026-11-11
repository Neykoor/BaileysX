import { LRUCache } from 'lru-cache'

export const S_WHATSAPP_NET = '@s.whatsapp.net'
export const OFFICIAL_BIZ_JID = '16505361212@c.us'
export const SERVER_JID = 'server@c.us'
export const PSA_WID = '0@c.us'
export const STORIES_JID = 'status@broadcast'
export const META_AI_JID = '13135550002@c.us'

export type JidServer =
	| 'c.us'
	| 'g.us'
	| 'broadcast'
	| 's.whatsapp.net'
	| 'call'
	| 'lid'
	| 'newsletter'
	| 'bot'
	| 'hosted'
	| 'hosted.lid'

export enum WAJIDDomains {
	WHATSAPP = 0,
	LID = 1,
	HOSTED = 128,
	HOSTED_LID = 129
}

export type JidWithDevice = {
	user: string
	device?: number
}

export type FullJid = JidWithDevice & {
	server: JidServer
	domainType?: number
}

export const getServerFromDomainType = (initialServer: string, domainType?: WAJIDDomains): JidServer => {
	switch (domainType) {
		case WAJIDDomains.LID:
			return 'lid'
		case WAJIDDomains.HOSTED:
			return 'hosted'
		case WAJIDDomains.HOSTED_LID:
			return 'hosted.lid'
		case WAJIDDomains.WHATSAPP:
		default:
			return initialServer as JidServer
	}
}

export const jidEncode = (user: string | number | null, server: JidServer, device?: number, agent?: number) => {
	return `${user || ''}${!!agent ? `_${agent}` : ''}${!!device ? `:${device}` : ''}@${server}`
}

export const jidDecode = (jid: string | undefined): FullJid | undefined => {
	const sepIdx = typeof jid === 'string' ? jid.indexOf('@') : -1
	if (sepIdx < 0) {
		return undefined
	}

	const server = jid!.slice(sepIdx + 1)
	const userCombined = jid!.slice(0, sepIdx)

	let userAgent = userCombined
	let device: string | undefined
	const colonIdx = userCombined.indexOf(':')
	if (colonIdx >= 0) {
		userAgent = userCombined.slice(0, colonIdx)
		const nextColon = userCombined.indexOf(':', colonIdx + 1)
		device = userCombined.slice(colonIdx + 1, nextColon < 0 ? undefined : nextColon)
	}

	let user = userAgent
	let agent: string | undefined
	const underscoreIdx = userAgent.indexOf('_')
	if (underscoreIdx >= 0) {
		user = userAgent.slice(0, underscoreIdx)
		const nextUnderscore = userAgent.indexOf('_', underscoreIdx + 1)
		agent = userAgent.slice(underscoreIdx + 1, nextUnderscore < 0 ? undefined : nextUnderscore)
	}

	let domainType = WAJIDDomains.WHATSAPP
	if (server === 'lid') {
		domainType = WAJIDDomains.LID
	} else if (server === 'hosted') {
		domainType = WAJIDDomains.HOSTED
	} else if (server === 'hosted.lid') {
		domainType = WAJIDDomains.HOSTED_LID
	} else if (agent) {
		domainType = parseInt(agent)
	}

	return {
		server: server as JidServer,
		user,
		domainType,
		device: device ? +device : undefined
	}
}

export const areJidsSameUser = (jid1: string | undefined, jid2: string | undefined) =>
	jidDecode(jid1)?.user === jidDecode(jid2)?.user
export const isJidMetaAI = (jid: string | undefined) => jid?.endsWith('@bot')
export const isPnUser = (jid: string | undefined) => jid?.endsWith('@s.whatsapp.net')
export const isLidUser = (jid: string | undefined) => jid?.endsWith('@lid')
export const isJidBroadcast = (jid: string | undefined) => jid?.endsWith('@broadcast')
export const isJidGroup = (jid: string | undefined) => jid?.endsWith('@g.us')
export const isJidStatusBroadcast = (jid: string) => jid === 'status@broadcast'
export const isJidNewsletter = (jid: string | undefined) => jid?.endsWith('@newsletter')
export const isHostedPnUser = (jid: string | undefined) => jid?.endsWith('@hosted')
export const isHostedLidUser = (jid: string | undefined) => jid?.endsWith('@hosted.lid')

const botRegexp = /^1313555\d{4}$|^131655500\d{2}$/

export const isJidBot = (jid: string | undefined) => jid && botRegexp.test(jid.split('@')[0]!) && jid.endsWith('@c.us')

export const jidNormalizedUser = (jid: string | undefined) => {
	const result = jidDecode(jid)
	if (!result) {
		return ''
	}

	const { user, server } = result
	return jidEncode(user, server === 'c.us' ? 's.whatsapp.net' : (server as JidServer))
}

export const transferDevice = (fromJid: string, toJid: string) => {
	const fromDecoded = jidDecode(fromJid)
	const deviceId = fromDecoded?.device || 0
	const { server, user } = jidDecode(toJid)!
	return jidEncode(user, server, deviceId)
}

const LID_PHONE_CACHE_MAX_SIZE = 3000
const LID_PHONE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type LidPhoneCache = {
	set(lid: string | undefined, phoneJid: string | undefined): void
	delete(lid: string | undefined, phoneJid: string | undefined): void
	get(key: string | undefined): string | undefined
	getLidForPhone(phoneJid: string | undefined): string | undefined
	getPhoneForLid(lid: string | undefined): string | undefined
	clear(): void
	readonly size: number
}

export function createLidPhoneCache(): LidPhoneCache {
	const cache = new LRUCache<string, string>({
		max: LID_PHONE_CACHE_MAX_SIZE * 2,
		ttl: LID_PHONE_CACHE_TTL_MS,
		ttlAutopurge: true,
		updateAgeOnGet: true
	})

	return {
		set(lid, phoneJid) {
			if (!lid || !phoneJid || typeof lid !== 'string' || typeof phoneJid !== 'string') return
			if (!phoneJid.includes('@')) phoneJid = phoneJid + S_WHATSAPP_NET

			cache.set(lid, phoneJid)
			cache.set(phoneJid, lid)
		},
		delete(lid, phoneJid) {
			if (!lid || !phoneJid) return
			cache.delete(lid)
			cache.delete(phoneJid)
		},
		get(key) {
			if (!key) return undefined
			return cache.get(key)
		},
		getLidForPhone(phoneJid) {
			if (!phoneJid) return undefined
			const val = cache.get(phoneJid)
			return val && (isLidUser(val) || isHostedLidUser(val)) ? val : undefined
		},
		getPhoneForLid(lid) {
			if (!lid) return undefined
			const val = cache.get(lid)
			return val && (isPnUser(val) || isHostedPnUser(val)) ? val : undefined
		},
		clear() {
			cache.clear()
		},
		get size() {
			return cache.size
		}
	}
}
 
