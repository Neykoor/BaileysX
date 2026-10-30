import { jidNormalizedUser } from '../../WABinary/jid-utils'

export const isGroupJid = (jid?: string | null) => typeof jid === 'string' && jid.endsWith('@g.us')
export const isUserJid = (jid?: string | null) => typeof jid === 'string' && jid.endsWith('@s.whatsapp.net')
export const isLidJid = (jid?: string | null) => typeof jid === 'string' && jid.endsWith('@lid')
export const isNewsletterJid = (jid?: string | null) => typeof jid === 'string' && jid.endsWith('@newsletter')

export const normalizeJid = (jid?: string | null): string | undefined => {
	if (typeof jid !== 'string') return undefined
	return (jidNormalizedUser as any)(jid)
}

export const getJidUser = (jid?: string | null): string | undefined => {
	const n = normalizeJid(jid)
	return n?.split('@')[0]
}

export const getMessageJid = (msg: any): string | undefined => {
	const k = msg?.key || {}
	return normalizeJid(k.remoteJidAlt || k.remoteJid)
}

export const getSenderJid = (msg: any): string | undefined => {
	const k = msg?.key || {}
	const s = k.participantAlt || k.participant || k.remoteJidAlt || k.remoteJid
	return normalizeJid(s)
}

export const isFromMe = (msg: any): boolean => !!msg?.key?.fromMe

export const extractMentions = (msg: any): string[] => {
	const m = msg?.message
	if (!m) return []
	const ctxs = [
		m.extendedTextMessage?.contextInfo,
		m.imageMessage?.contextInfo,
		m.videoMessage?.contextInfo,
		m.documentMessage?.contextInfo,
		m.audioMessage?.contextInfo,
		m.stickerMessage?.contextInfo,
		m.buttonsResponseMessage?.contextInfo,
		m.listResponseMessage?.contextInfo,
		m.templateButtonReplyMessage?.contextInfo,
		m.interactiveResponseMessage?.contextInfo
	]
	const out = new Set<string>()
	for (const c of ctxs) {
		if (Array.isArray(c?.mentionedJid)) {
			for (const j of c.mentionedJid) {
				const n = normalizeJid(j)
				if (n) out.add(n)
			}
		}
	}
	return [...out]
}

export const isMentioned = (msg: any, jid?: string | null) => {
	const n = normalizeJid(jid)
	if (!n) return false
	return extractMentions(msg).includes(n)
}
