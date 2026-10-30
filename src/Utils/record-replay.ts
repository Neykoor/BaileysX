import EventEmitter from 'events'
import type { BaileysEvent, BaileysEventEmitter, BaileysEventMap } from '../Types/Events'
import { BufferJSON } from './generics'

export type RecordedEvent = {
	event: BaileysEvent
	data: unknown
	timestamp: number
}

export type EventRecording = {
	version: 1
	startedAt: number
	stoppedAt?: number
	events: RecordedEvent[]
}

export type RecordEventsOptions = {
	/** Restrict recording to these event names. Defaults to every Baileys event. */
	events?: BaileysEvent[]
	/** Return false to skip an event. */
	filter?: (event: BaileysEvent, data: unknown) => boolean
	/** Deep-clone event data so later mutations do not alter the recording. */
	clone?: boolean
}

export type ReplayEventsOptions = {
	/** Delay between events. Set to 0 for an immediate replay. */
	speed?: number
	/** Optional hook invoked before each event is emitted. */
	onEvent?: (event: RecordedEvent) => void | Promise<void>
	/** Injectable sleep function, useful for deterministic tests. */
	sleep?: (ms: number) => Promise<void>
}

export type FakeEventEmitter = BaileysEventEmitter & {
	readonly emitted: RecordedEvent[]
	clear: () => void
}

const cloneData = (data: unknown): unknown => {
	if (data === undefined) {
		return undefined
	}

	return JSON.parse(JSON.stringify(data, BufferJSON.replacer), BufferJSON.reviver)
}

const sleepFor = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const defaultEvents: BaileysEvent[] = [
	'connection.update',
	'creds.update',
	'messaging-history.set',
	'messaging-history.status',
	'chats.upsert',
	'chats.update',
	'chats.delete',
	'lid-mapping.update',
	'presence.update',
	'contacts.upsert',
	'contacts.update',
	'messages.delete',
	'messages.update',
	'messages.media-update',
	'messages.upsert',
	'messages.reaction',
	'message-receipt.update',
	'groups.upsert',
	'groups.update',
	'group-participants.update',
	'group.join-request',
	'group.member-tag.update',
	'blocklist.set',
	'blocklist.update',
	'call',
	'labels.edit',
	'labels.association',
	'newsletter.reaction',
	'newsletter.view',
	'newsletter-participants.update',
	'newsletter-settings.update',
	'message-capping.update',
	'chats.lock',
	'settings.update'
]

/**
 * Records Baileys events from a socket (or any compatible emitter).
 *
 * The returned `recording` is a live object. Call `stop()` to detach the
 * listeners and finalize the recording.
 */
export const recordEvents = (ev: BaileysEventEmitter, opts: RecordEventsOptions = {}) => {
	const recording: EventRecording = {
		version: 1,
		startedAt: Date.now(),
		events: []
	}

	const events = opts.events ?? defaultEvents
	const removeListeners: Array<() => void> = []

	for (const event of events) {
		const listener = (data: unknown) => {
			if (opts.filter && !opts.filter(event, data)) {
				return
			}

			recording.events.push({
				event,
				data: opts.clone === false ? data : cloneData(data),
				timestamp: Date.now()
			})
		}

		ev.on(event, listener as never)
		removeListeners.push(() => ev.off(event, listener as never))
	}

	let stopped = false
	const stop = () => {
		if (stopped) {
			return
		}

		stopped = true
		recording.stoppedAt = Date.now()
		for (const remove of removeListeners) {
			try {
				remove()
			} catch {
				// The emitter may already have been destroyed.
			}
		}
	}

	return { recording, stop }
}

/**
 * Re-emits a recording into another Baileys emitter.
 */
export const replayEvents = async (
	ev: BaileysEventEmitter,
	recording: EventRecording,
	opts: ReplayEventsOptions = {}
): Promise<void> => {
	const sleep = opts.sleep ?? sleepFor
	let previous = recording.events[0]?.timestamp

	for (const recorded of recording.events) {
		if (previous !== undefined && opts.speed !== 0) {
			const delay = Math.max(0, recorded.timestamp - previous)
			const scaled = opts.speed && opts.speed > 0 ? delay / opts.speed : delay
			if (scaled > 0) {
				await sleep(scaled)
			}
		}

		await opts.onEvent?.(recorded)
		ev.emit(recorded.event, cloneData(recorded.data) as never)
		previous = recorded.timestamp
	}
}

export const serializeRecording = (recording: EventRecording): string =>
	JSON.stringify(recording, BufferJSON.replacer)

export const deserializeRecording = (serialized: string): EventRecording =>
	JSON.parse(serialized, BufferJSON.reviver) as EventRecording

/**
 * Small typed event emitter used by fake sockets and replay tests.
 */
export const makeFakeEventEmitter = (): FakeEventEmitter => {
	const emitter = new EventEmitter()
	const emitted: RecordedEvent[] = []

	const ev: FakeEventEmitter = {
		on: (event, listener) => {
			emitter.on(event, listener)
		},
		off: (event, listener) => {
			emitter.off(event, listener)
		},
		removeAllListeners: event => {
			emitter.removeAllListeners(event)
		},
		emit: (event, data) => {
			emitted.push({ event, data, timestamp: Date.now() })
			return emitter.emit(event, data)
		},
		emitted,
		clear: () => {
			emitted.length = 0
		}
	}

	return ev
}

export type RecordedEventMap<T extends BaileysEvent> = BaileysEventMap[T]
