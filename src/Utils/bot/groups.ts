import type { GroupMetadata } from '../../Types'
import { normalizeJid } from './jid'

export const getGroupAdmins = (meta: GroupMetadata): string[] => {
	const arr = meta?.participants || []
	return arr
		.filter(p => p.admin === 'admin' || p.admin === 'superadmin')
		.map(p => normalizeJid(p.id))
		.filter((x): x is string => !!x)
}

export const getGroupSuperAdmins = (meta: GroupMetadata): string[] => {
	const arr = meta?.participants || []
	return arr
		.filter(p => p.admin === 'superadmin')
		.map(p => normalizeJid(p.id))
		.filter((x): x is string => !!x)
}

export const isGroupAdmin = (meta: GroupMetadata, jid?: string | null) => {
	const n = normalizeJid(jid)
	if (!n) return false
	return (meta?.participants || []).some(p => normalizeJid(p.id) === n && (p.admin === 'admin' || p.admin === 'superadmin'))
}

export const isGroupSuperAdmin = (meta: GroupMetadata, jid?: string | null) => {
	const n = normalizeJid(jid)
	if (!n) return false
	return (meta?.participants || []).some(p => normalizeJid(p.id) === n && p.admin === 'superadmin')
}

export const isBotAdmin = (meta: GroupMetadata, botJid?: string | null) => isGroupAdmin(meta, botJid)

export const getParticipant = (meta: GroupMetadata, jid?: string | null) => {
	const n = normalizeJid(jid)
	if (!n) return undefined
	return (meta?.participants || []).find(p => normalizeJid(p.id) === n)
}
