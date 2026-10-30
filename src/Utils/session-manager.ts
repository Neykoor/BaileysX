import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import makeWASocket from '../Socket/index.js'
import type { AuthenticationState, UserFacingSocketConfig } from '../Types'
import { makeResilientSocket, type ReconnectOptions } from './reconnect-manager.js'
import { useMultiFileAuthState } from './use-multi-file-auth-state.js'
import { useSqliteAuthState } from './use-sqlite-auth-state.js'

type WASocket = ReturnType<typeof makeWASocket>

export type SessionStatus = 'starting' | 'connected' | 'reconnecting' | 'disconnected' | 'stopped'

export type SessionEntry = {
	id: string
	readonly sock: WASocket
	readonly status: SessionStatus
	readonly lastSeenAt?: Date
	readonly lastDisconnect?: unknown
	stop: () => Promise<void>
}

export type SessionHealth = {
	id: string
	status: SessionStatus
	connected: boolean
	lastSeenAt?: Date
}

export type SessionManagerHealth = {
	total: number
	connected: number
	starting: number
	reconnecting: number
	disconnected: number
	sessions: SessionHealth[]
}

export type SessionAuthStateHandle = {
	state: AuthenticationState
	saveCreds: () => void
	close?: () => void
}

export type SessionManagerOptions = {
	baseAuthDir: string
	config?: Omit<Partial<UserFacingSocketConfig>, 'auth'>
	/** Auth persistence backend. Defaults to the existing multi-file layout. */
	storage?: 'files' | 'sqlite'
	/** Required to read/write encrypted SQLite auth databases. */
	passphrase?: string
	authStateFactory?: (id: string, authDir: string) => Promise<SessionAuthStateHandle>
	socketFactory?: (config: UserFacingSocketConfig) => WASocket
	/** Automatically reconnect each session with exponential backoff. */
	autoReconnect?: boolean
	reconnectOptions?: Omit<
		ReconnectOptions,
		'config' | 'onSocket' | 'onStopped' | 'onMaxAttemptsReached' | 'logger' | 'socketFactory'
	>
}

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/

const assertSafeId = (id: string): void => {
	if (!id || !SAFE_ID_PATTERN.test(id)) {
		throw new Error(
			`invalid session id "${id}": only alphanumeric characters, "-" and "_" are allowed (no path separators or traversal sequences)`
		)
	}
}

export const makeSessionManager = (opts: SessionManagerOptions) => {
	const sessions = new Map<string, SessionEntry>()
	const pending = new Map<string, Promise<SessionEntry>>()

	const createAuthState = async (id: string, authDir: string): Promise<SessionAuthStateHandle> => {
		await mkdir(opts.baseAuthDir, { recursive: true })

		if (opts.authStateFactory) {
			return opts.authStateFactory(id, authDir)
		}

		if (opts.storage === 'sqlite') {
			const auth = await useSqliteAuthState({
				dbPath: join(opts.baseAuthDir, `${id}.db`),
				passphrase: opts.passphrase
			})
			return {
				state: auth.state,
				saveCreds: auth.saveCreds,
				close: auth.close
			}
		}

		const { state, saveCreds } = await useMultiFileAuthState(authDir)
		return { state, saveCreds }
	}

	const start = async (id: string, overrideConfig?: Omit<Partial<UserFacingSocketConfig>, 'auth'>) => {
		assertSafeId(id)

		const existing = sessions.get(id)
		if (existing) {
			return existing
		}

		const inflight = pending.get(id)
		if (inflight) {
			return inflight
		}

		const creation = (async () => {
			const authDir = join(opts.baseAuthDir, id)
			const auth = await createAuthState(id, authDir)
			const state = {
				status: 'starting' as SessionStatus,
				lastSeenAt: undefined as Date | undefined,
				lastDisconnect: undefined as unknown,
				stopping: false
			}
			const cleanups: Array<() => void> = []
			let sock: WASocket
			let resilient: ReturnType<typeof makeResilientSocket> | undefined

			const attachSocket = (current: WASocket) => {
				const onCredsUpdate = () => auth.saveCreds()
				const onActivity = () => {
					state.lastSeenAt = new Date()
				}
				const onConnectionUpdate = (update: any) => {
					state.lastDisconnect = update.lastDisconnect

					if (update.connection === 'open') {
						state.status = 'connected'
						state.lastSeenAt = new Date()
					} else if (update.connection === 'close' && !state.stopping) {
						state.status = opts.autoReconnect ? 'reconnecting' : 'disconnected'
					}
				}

				current.ev.on('creds.update', onCredsUpdate)
				current.ev.on('connection.update', onConnectionUpdate)
				current.ev.on('messages.upsert', onActivity)
				current.ev.on('messages.update', onActivity)

				cleanups.push(() => {
					current.ev.off('creds.update', onCredsUpdate)
					current.ev.off('connection.update', onConnectionUpdate)
					current.ev.off('messages.upsert', onActivity)
					current.ev.off('messages.update', onActivity)
				})
			}

			const socketConfig: UserFacingSocketConfig = {
				...opts.config,
				...overrideConfig,
				auth: auth.state
			}

			if (opts.autoReconnect) {
				resilient = makeResilientSocket({
					...opts.reconnectOptions,
					config: socketConfig,
					logger: opts.config?.logger,
					socketFactory: opts.socketFactory,
					onSocket: current => {
						if (state.status !== 'starting') {
							state.status = 'reconnecting'
						}

						attachSocket(current)
					},
					onStopped: () => {
						if (!state.stopping) {
							state.status = 'disconnected'
						}
					},
					onMaxAttemptsReached: () => {
						if (!state.stopping) {
							state.status = 'disconnected'
						}
					}
				})
				sock = resilient.socket
			} else {
				sock = (opts.socketFactory ?? makeWASocket)(socketConfig)
				attachSocket(sock)
			}

			const entry: SessionEntry = {
				id,
				get sock() {
					return resilient ? resilient.socket : sock
				},
				get status() {
					return state.status
				},
				get lastSeenAt() {
					return state.lastSeenAt
				},
				get lastDisconnect() {
					return state.lastDisconnect
				},
				stop: async () => {
					if (state.stopping) {
						return
					}

					state.stopping = true
					state.status = 'stopped'
					for (const cleanup of cleanups) {
						try {
							cleanup()
						} catch {}
					}

					try {
						if (resilient) {
							resilient.stop()
						} else {
							sock.end(undefined)
						}
					} catch (error) {
						opts.config?.logger?.warn({ error, id }, 'failed to close session socket')
					} finally {
						try {
							auth.close?.()
						} catch {}
						sessions.delete(id)
					}
				}
			}

			sessions.set(id, entry)
			return entry
		})()

		pending.set(id, creation)

		try {
			return await creation
		} finally {
			pending.delete(id)
		}
	}

	const stop = async (id: string) => {
		const inflight = pending.get(id)
		if (inflight) {
			const entry = await inflight
			await entry.stop()
			return
		}

		const entry = sessions.get(id)
		if (entry) {
			await entry.stop()
		}
	}

	const stopAll = async () => {
		const ids = new Set([...sessions.keys(), ...pending.keys()])
		await Promise.all(Array.from(ids).map(id => stop(id)))
	}

	const get = (id: string) => sessions.get(id)

	const list = () => Array.from(sessions.keys())

	const getHealth = (): SessionManagerHealth => {
		const entries = Array.from(sessions.values()).map(entry => ({
			id: entry.id,
			status: entry.status,
			connected: entry.status === 'connected',
			lastSeenAt: entry.lastSeenAt
		}))

		return {
			total: entries.length,
			connected: entries.filter(entry => entry.status === 'connected').length,
			starting: entries.filter(entry => entry.status === 'starting').length,
			reconnecting: entries.filter(entry => entry.status === 'reconnecting').length,
			disconnected: entries.filter(entry => entry.status === 'disconnected').length,
			sessions: entries
		}
	}

	return {
		start,
		stop,
		stopAll,
		get,
		list,
		getHealth
	}
}

export type SessionManager = ReturnType<typeof makeSessionManager>
