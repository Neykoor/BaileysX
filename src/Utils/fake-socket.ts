import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage } from '../Types/Message'
import type { BaileysEventEmitter } from '../Types/Events'
import type { ILogger } from './logger'
import logger from './logger'
import { makeMediaCache, type MediaCacheOptions } from './media-cache'
import type { MediaDownloadOptions } from './messages-media'
import { makeMiddlewareStack } from './middleware'
import { makeSocketMetrics, type SocketMetricsSnapshot } from './metrics'
import { makeFakeEventEmitter, type FakeEventEmitter } from './record-replay'
import { MessageScheduler } from './scheduling'

export type FakeSentMessage = {
	jid: string
	content: AnyMessageContent
	options?: MiscMessageGenerationOptions
	message?: WAMessage
}

export type FakeWASocketOptions = {
	logger?: ILogger
	/** Defaults to false, matching a socket that does not emit its own messages. */
	emitOwnEvents?: boolean
	/** Injected media downloader. Defaults to an empty buffer. */
	downloadMedia?: (message: WAMessage) => Promise<Buffer>
	now?: () => number
}

export type FakeWASocket = {
	ev: FakeEventEmitter
	readonly sentMessages: FakeSentMessage[]
	sendMessage: (
		jid: string,
		content: AnyMessageContent,
		options?: MiscMessageGenerationOptions
	) => Promise<WAMessage | undefined>
	use: ReturnType<typeof makeMiddlewareStack>['use']
	useOutgoing: ReturnType<typeof makeMiddlewareStack>['useOutgoing']
	downloadMedia: (message: WAMessage, options?: MediaDownloadOptions) => Promise<Buffer>
	mediaCache: ReturnType<typeof makeMediaCache>
	messageScheduler: MessageScheduler
	scheduleMessage: (
		jid: string,
		content: AnyMessageContent,
		scheduledTime: Date,
		options?: MiscMessageGenerationOptions
	) => ReturnType<MessageScheduler['schedule']>
	cancelScheduledMessage: (id: string) => boolean
	connect: () => void
	receive: (message: WAMessage | WAMessage[]) => void
	end: (error?: unknown) => void
	getHealth: () => {
		status: 'connecting' | 'connected' | 'disconnected'
		connected: boolean
		uptimeMs: number
		connectedForMs: number
		counters: SocketMetricsSnapshot
		scheduler: ReturnType<MessageScheduler['getStats']>
		mediaCache: { size: number }
	}
	getMetrics: () => SocketMetricsSnapshot & {
		scheduler: ReturnType<MessageScheduler['getStats']>
		mediaCache: { size: number }
	}
}

/**
 * In-memory socket used by the record/replay, plugin and command test harnesses.
 * It intentionally implements the small surface those features need, not the
 * complete WhatsApp transport.
 */
export const makeFakeWASocket = (opts: FakeWASocketOptions = {}): FakeWASocket => {
	const log = opts.logger ?? logger
	const ev = makeFakeEventEmitter()
	const metrics = makeSocketMetrics()
	const middleware = makeMiddlewareStack({ ev }, { logger: log })
	const sentMessages: FakeSentMessage[] = []
	const now = opts.now ?? Date.now

	metrics.attach(ev)

	const mediaCache = makeMediaCache({
		logger: log,
		downloadMedia: (async (message: WAMessage) =>
			opts.downloadMedia ? opts.downloadMedia(message) : Buffer.alloc(0)) as NonNullable<
			MediaCacheOptions['downloadMedia']
		>
	})

	const sendMessage = async (
		jid: string,
		content: AnyMessageContent,
		options?: MiscMessageGenerationOptions
	): Promise<WAMessage | undefined> => {
		const outgoing = await middleware.runOutgoing(jid, content, options)
		if (outgoing.stopped) {
			return undefined
		}

		const message: WAMessage = {
			key: {
				remoteJid: outgoing.jid,
				fromMe: true,
				id: outgoing.options?.messageId ?? `fake_${now()}_${sentMessages.length}`
			},
			message: 'text' in outgoing.content ? { conversation: outgoing.content.text } : (outgoing.content as never),
			messageTimestamp: Math.floor(now() / 1000)
		}

		sentMessages.push({
			jid: outgoing.jid,
			content: outgoing.content,
			options: outgoing.options,
			message
		})
		metrics.recordSent()

		if (opts.emitOwnEvents) {
			ev.emit('messages.upsert', { messages: [message], type: 'notify' })
		}

		return message
	}

	const scheduler = new MessageScheduler(
		async (jid, content, options) => sendMessage(jid, content, options),
		{ logger: log }
	)

	const downloadMedia = async (message: WAMessage, options?: Record<string, unknown>) =>
		mediaCache.download(message, options ?? {})

	const getMetrics = () => ({
		...metrics.snapshot(),
		scheduler: scheduler.getStats(),
		mediaCache: { size: mediaCache.size() }
	})

	const socket: FakeWASocket = {
		ev,
		sentMessages,
		sendMessage,
		use: middleware.use,
		useOutgoing: middleware.useOutgoing,
		downloadMedia,
		mediaCache,
		messageScheduler: scheduler,
		scheduleMessage: (jid, content, scheduledTime, options) =>
			scheduler.schedule(jid, content, scheduledTime, options),
		cancelScheduledMessage: id => scheduler.cancel(id),
		connect: () => {
			ev.emit('connection.update', { connection: 'open' })
		},
		receive: message => {
			const messages = Array.isArray(message) ? message : [message]
			ev.emit('messages.upsert', { messages, type: 'notify' })
		},
		end: error => {
			ev.emit('connection.update', {
				connection: 'close',
				lastDisconnect: error ? { error: error as Error, date: new Date() } : undefined
			})
			metrics.detach()
		},
		getHealth: () => {
			const snapshot = metrics.snapshot()
			const status =
				snapshot.connection === 'open'
					? 'connected'
					: snapshot.connection === 'connecting'
						? 'connecting'
						: 'disconnected'

			return {
				status,
				connected: status === 'connected',
				uptimeMs: snapshot.uptimeMs,
				connectedForMs: snapshot.connectedForMs,
				counters: snapshot,
				scheduler: scheduler.getStats(),
				mediaCache: { size: mediaCache.size() }
			}
		},
		getMetrics
	}

	return socket
}

export type FakeSocketEventEmitter = BaileysEventEmitter
