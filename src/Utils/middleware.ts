import type { BaileysEventEmitter } from '../Types/Events'
import type { WAMessage } from '../Types/Message'
import type { AnyMessageContent, MiscMessageGenerationOptions } from '../Types/Message'

export type MiddlewareContext = {
	jid: string
	message: WAMessage
	stop: () => void
}

export type Middleware = (ctx: MiddlewareContext) => void | Promise<void>

export type OutgoingMiddlewareContext = {
	jid: string
	content: AnyMessageContent
	options?: MiscMessageGenerationOptions
}

export type OutgoingMiddleware = (ctx: OutgoingMiddlewareContext) => void | Promise<void>

export type MinimalMiddlewareSocket = {
	ev: BaileysEventEmitter
}

export const makeMiddlewareStack = (sock: MinimalMiddlewareSocket) => {
	const incoming: Middleware[] = []
	const outgoing: OutgoingMiddleware[] = []

	const use = (mw: Middleware) => {
		incoming.push(mw)
		return () => {
			const idx = incoming.indexOf(mw)
			if (idx >= 0) {
				incoming.splice(idx, 1)
			}
		}
	}

	const useOutgoing = (mw: OutgoingMiddleware) => {
		outgoing.push(mw)
		return () => {
			const idx = outgoing.indexOf(mw)
			if (idx >= 0) {
				outgoing.splice(idx, 1)
			}
		}
	}

	sock.ev.on('messages.upsert', async ({ messages, type }) => {
		if (type !== 'notify') {
			return
		}

		for (const message of messages) {
			const rawJid = message.key.remoteJidAlt || message.key.remoteJid
			if (!rawJid) {
				continue
			}

			let stopped = false
			const ctx: MiddlewareContext = {
				jid: rawJid,
				message,
				stop: () => {
					stopped = true
				}
			}

			for (const mw of incoming) {
				await mw(ctx)
				if (stopped) {
					break
				}
			}
		}
	})

	const runOutgoing = async (jid: string, content: AnyMessageContent, options?: MiscMessageGenerationOptions) => {
		const ctx: OutgoingMiddlewareContext = { jid, content, options }
		for (const mw of outgoing) {
			await mw(ctx)
		}

		return ctx
	}

	return {
		use,
		useOutgoing,
		runOutgoing
	}
}

export type MiddlewareStack = ReturnType<typeof makeMiddlewareStack>
