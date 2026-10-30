import type { GroupMetadata } from '../../Types'

export type GroupSettings = {
	prefix?: string
	enabled?: boolean
	welcome?: { text?: string; enabled?: boolean } | string
	goodbye?: { text?: string; enabled?: boolean } | string
	antilink?: boolean
	antispam?: boolean
	warnLimit?: number
	adminOnly?: boolean
	muted?: boolean
	updatedAt?: number
}

export const makeGroupSettings = (store: any) => {
	const get = async (jid: string): Promise<GroupSettings> => {
		try {
			if (store?.groupSettings?.get) return await store.groupSettings.get(jid)
			return {}
		} catch {
			return {}
		}
	}

	const set = async (jid: string, s: Partial<GroupSettings>) => {
		try {
			if (store?.groupSettings?.set) await store.groupSettings.set(jid, s)
		} catch {}
	}

	const all = async () => {
		try {
			if (store?.groupSettings?.all) return await store.groupSettings.all()
			return {}
		} catch {
			return {}
		}
	}

	const del = async (jid: string) => {
		try {
			if (store?.groupSettings?.delete) await store.groupSettings.delete(jid)
		} catch {}
	}

	return { get, set, all, del, delete: del }
}

export type GroupSettingsStore = ReturnType<typeof makeGroupSettings>
