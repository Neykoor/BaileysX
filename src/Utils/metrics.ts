import type { BaileysEventEmitter } from '../Types/Events'

export type SocketConnectionState = 'connecting' | 'open' | 'close'

export type SocketMetricsSnapshot = {
	connection: SocketConnectionState
	messagesReceived: number
	messagesSent: number
	sendFailures: number
	messagesUpdated: number
	messagesDeleted: number
	mediaDownloads: number
	connectionOpens: number
	disconnects: number
	startedAt: number
	lastActivityAt?: number
	connectedAt?: number
	uptimeMs: number
	connectedForMs: number
}

type MutableMetrics = Omit<
	SocketMetricsSnapshot,
	'uptimeMs' | 'connectedForMs'
>

/**
 * Lightweight, dependency-free counters for a socket instance.
 *
 * The monitor only observes public Baileys events and a few explicit calls from
 * the send/media paths. It intentionally does not expose user content.
 */
export class SocketMetrics {
	private state: MutableMetrics = {
		connection: 'connecting',
		messagesReceived: 0,
		messagesSent: 0,
		sendFailures: 0,
		messagesUpdated: 0,
		messagesDeleted: 0,
		mediaDownloads: 0,
		connectionOpens: 0,
		disconnects: 0,
		startedAt: Date.now()
	}

	private listeners: Array<() => void> = []

	attach(ev: BaileysEventEmitter) {
		this.detach()

		const onConnectionUpdate = (update: { connection?: SocketConnectionState; lastDisconnect?: unknown }) => {
			if (!update.connection) {
				return
			}

			this.state.connection = update.connection
			this.state.lastActivityAt = Date.now()

			if (update.connection === 'open') {
				this.state.connectionOpens++
				this.state.connectedAt = Date.now()
			} else if (update.connection === 'close') {
				this.state.disconnects++
				this.state.connectedAt = undefined
			}
		}

		const onMessagesUpsert = ({ messages }: { messages: unknown[] }) => {
			this.state.messagesReceived += messages.length
			this.state.lastActivityAt = Date.now()
		}

		const onMessagesUpdate = (updates: unknown[]) => {
			this.state.messagesUpdated += updates.length
			this.state.lastActivityAt = Date.now()
		}

		const onMessagesDelete = (item: { keys?: unknown[]; all?: boolean }) => {
			this.state.messagesDeleted += item.all ? 1 : (item.keys?.length ?? 0)
			this.state.lastActivityAt = Date.now()
		}

		ev.on('connection.update', onConnectionUpdate)
		ev.on('messages.upsert', onMessagesUpsert)
		ev.on('messages.update', onMessagesUpdate)
		ev.on('messages.delete', onMessagesDelete)

		this.listeners = [
			() => ev.off('connection.update', onConnectionUpdate),
			() => ev.off('messages.upsert', onMessagesUpsert),
			() => ev.off('messages.update', onMessagesUpdate),
			() => ev.off('messages.delete', onMessagesDelete)
		]
	}

	detach() {
		for (const remove of this.listeners) {
			try {
				remove()
			} catch {
				// The emitter may already have been destroyed.
			}
		}

		this.listeners = []
	}

	recordSent() {
		this.state.messagesSent++
		this.state.lastActivityAt = Date.now()
	}

	recordSendFailure() {
		this.state.sendFailures++
		this.state.lastActivityAt = Date.now()
	}

	recordMediaDownload() {
		this.state.mediaDownloads++
		this.state.lastActivityAt = Date.now()
	}

	snapshot(): SocketMetricsSnapshot {
		const now = Date.now()
		return {
			...this.state,
			uptimeMs: Math.max(0, now - this.state.startedAt),
			connectedForMs: this.state.connectedAt ? Math.max(0, now - this.state.connectedAt) : 0
		}
	}
}

export const makeSocketMetrics = () => new SocketMetrics()
