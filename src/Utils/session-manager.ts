import makeWASocket from '../Socket/index.js'
import type { UserFacingSocketConfig } from '../Types'
import { useMultiFileAuthState } from './use-multi-file-auth-state.js'

type WASocket = ReturnType<typeof makeWASocket>

export type SessionEntry = {
	id: string
	sock: WASocket
	stop: () => Promise<void>
}

export type SessionManagerOptions = {
	baseAuthDir: string
	config?: Omit<Partial<UserFacingSocketConfig>, 'auth'>
}

export const makeSessionManager = (opts: SessionManagerOptions) => {
	const sessions = new Map<string, SessionEntry>()

	const start = async (id: string, overrideConfig?: Omit<Partial<UserFacingSocketConfig>, 'auth'>) => {
		const existing = sessions.get(id)
		if (existing) {
			return existing
		}

		const authDir = `${opts.baseAuthDir}/${id}`
		const { state, saveCreds } = await useMultiFileAuthState(authDir)

		const sock = makeWASocket({
			...opts.config,
			...overrideConfig,
			auth: state
		})

		sock.ev.on('creds.update', saveCreds)

		const entry: SessionEntry = {
			id,
			sock,
			stop: async () => {
				sock.ev.removeAllListeners('creds.update')
				sock.end(undefined)
				sessions.delete(id)
			}
		}

		sessions.set(id, entry)
		return entry
	}

	const stop = async (id: string) => {
		const entry = sessions.get(id)
		if (entry) {
			await entry.stop()
		}
	}

	const stopAll = async () => {
		await Promise.all(Array.from(sessions.keys()).map(id => stop(id)))
	}

	const get = (id: string) => sessions.get(id)

	const list = () => Array.from(sessions.keys())

	return {
		start,
		stop,
		stopAll,
		get,
		list
	}
}

export type SessionManager = ReturnType<typeof makeSessionManager>
