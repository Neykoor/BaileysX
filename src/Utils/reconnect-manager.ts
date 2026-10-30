import { Boom } from '@neykoor/boom'
import makeWASocket from '../Socket/index.js'
import { DisconnectReason, type UserFacingSocketConfig } from '../Types'
import { ConnectionWatchdog, type ConnectionWatchdogOptions } from './connection-watchdog'
import type { ILogger } from './logger'

type WASocket = ReturnType<typeof makeWASocket>

export type ReconnectOptions = {
	config: UserFacingSocketConfig
	shouldReconnect?: (statusCode: number | undefined) => boolean
	minDelayMs?: number
	maxDelayMs?: number
	maxAttempts?: number
	onSocket?: (sock: WASocket) => void
	onMaxAttemptsReached?: () => void
	onStopped?: (statusCode: number | undefined) => void
	logger?: ILogger
	/** Injectable socket factory, useful for deterministic tests. */
	socketFactory?: (config: UserFacingSocketConfig) => WASocket
	/** Extra backoff policy. Liveness checking is opt-in via `enableLiveness`. */
	watchdog?: Omit<ConnectionWatchdogOptions, 'logger'>
	/** Detect half-open/zombie sockets. Disabled by default. */
	enableLiveness?: boolean
}

const DISCONNECT_STATUS_LOGGED_OUT = 401

const defaultShouldReconnect = (statusCode: number | undefined) => statusCode !== DISCONNECT_STATUS_LOGGED_OUT

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export const makeResilientSocket = (opts: ReconnectOptions) => {
	const minDelay = opts.minDelayMs ?? 1000
	const maxDelay = opts.maxDelayMs ?? 60000
	const shouldReconnect = opts.shouldReconnect ?? defaultShouldReconnect
	const watchdog = new ConnectionWatchdog({
		baseDelayMs: minDelay,
		maxDelayMs: maxDelay,
		...(opts.watchdog ?? {}),
		logger: opts.logger
	})
	const createSocket = opts.socketFactory ?? makeWASocket

	let attempt = 0
	let stopped = false
	let currentSock: WASocket | undefined

	const stopWatchdog = () => watchdog.stopLivenessCheck()

	const connect = () => {
		const sock = createSocket(opts.config)
		currentSock = sock
		opts.onSocket?.(sock)

		sock.ev.on('messages.upsert', () => watchdog.notifyActivity())
		sock.ev.on('messages.update', () => watchdog.notifyActivity())

		sock.ev.on('connection.update', update => {
			const { connection, lastDisconnect } = update
			if (connection) {
				watchdog.notifyActivity()
			}

			if (connection === 'open') {
				attempt = 0
				watchdog.notifyConnected()
				if (opts.enableLiveness) {
					watchdog.startLivenessCheck(() => {
						opts.logger?.warn('connection watchdog detected a zombie socket, forcing reconnect')
						try {
							currentSock?.end(undefined)
						} catch (error) {
							opts.logger?.warn({ error }, 'failed to close zombie socket')
						}
					})
				}
			}

			if (connection === 'close' && !stopped) {
				stopWatchdog()
				const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
				if (!shouldReconnect(statusCode)) {
					stopped = true
					opts.logger?.warn({ statusCode }, 'reconnect not allowed for this status code, stopping')
					opts.onStopped?.(statusCode)
					return
				}

				if (opts.maxAttempts !== undefined && attempt >= opts.maxAttempts) {
					stopped = true
					opts.logger?.error({ attempt }, 'max reconnect attempts reached')
					opts.onMaxAttemptsReached?.()
					return
				}

				if (statusCode === DisconnectReason.restartRequired) {
					attempt = 0
					opts.logger?.info({ statusCode }, 'restart required, reconnecting immediately')
					connect()
					return
				}

				const decision = watchdog.decide(statusCode)
				if (decision.action === 'stop') {
					stopped = true
					opts.logger?.error({ statusCode, reason: decision.reason }, 'watchdog stopped reconnecting')
					opts.onStopped?.(statusCode)
					return
				}

				const wait = decision.delayMs
				attempt += 1
				opts.logger?.warn({ attempt, wait, statusCode }, 'reconnecting')
				delay(wait).then(() => {
					if (!stopped) {
						connect()
					}
				})
			}
		})

		return sock
	}

	connect()

	return {
		get socket() {
			return currentSock as WASocket
		},
		watchdog,
		stop: () => {
			stopped = true
			stopWatchdog()
			try {
				currentSock?.end(undefined)
			} catch (error) {
				opts.logger?.warn({ error }, 'failed to close resilient socket')
			}
		}
	}
}
