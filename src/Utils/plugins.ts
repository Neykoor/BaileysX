import type { BaileysEventEmitter, BaileysEventMap } from '../Types/Events'
import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage } from '../Types/Message'
import type { ILogger } from './logger'
import logger from './logger'
import { extractMessageText } from './messages'
import type { Middleware } from './middleware'

export type PluginSocket = {
	ev: BaileysEventEmitter
	use?: (middleware: Middleware) => (() => void) | void
	sendMessage?: (
		jid: string,
		content: AnyMessageContent,
		options?: MiscMessageGenerationOptions
	) => Promise<unknown>
}

export type PluginMessageContext = {
	jid: string
	senderJid?: string
	message: WAMessage
	text: string
	sock: PluginSocket
	reply: (content: AnyMessageContent, options?: MiscMessageGenerationOptions) => Promise<unknown>
	stop: () => void
}

export type PluginContext = {
	sock: PluginSocket
	logger: ILogger
	config?: Record<string, unknown>
}

export type PluginHooks = {
	onLoad?: (ctx: PluginContext) => void | Promise<void>
	onUnload?: (ctx: PluginContext) => void | Promise<void>
	onMessage?: (ctx: PluginMessageContext) => void | Promise<void>
	onConnectionUpdate?: (
		update: BaileysEventMap['connection.update'],
		ctx: PluginContext
	) => void | Promise<void>
	onCredsUpdate?: (update: BaileysEventMap['creds.update'], ctx: PluginContext) => void | Promise<void>
}

export type Plugin = {
	name: string
	version?: string
	hooks?: PluginHooks
	setup?: (ctx: PluginContext) => void | Promise<void>
}

export type PluginManagerOptions = {
	sock: PluginSocket
	logger?: ILogger
	config?: Record<string, unknown>
}

export type PluginInfo = {
	name: string
	version?: string
}

export const definePlugin = (plugin: Plugin): Plugin => plugin

const jidForMessage = (message: WAMessage): string | undefined =>
	message.key.remoteJidAlt || message.key.remoteJid || undefined

/**
 * Lifecycle manager for message/connection plugins. Plugins are isolated: a
 * throwing hook is logged and never crashes the socket or the other plugins.
 */
export const makePluginManager = (opts: PluginManagerOptions) => {
	const log = opts.logger ?? logger
	const plugins = new Map<string, Plugin>()
	const cleanups = new Map<string, Array<() => void | Promise<void>>>()
	const pluginContext: PluginContext = {
		sock: opts.sock,
		logger: log,
		config: opts.config
	}

	const register = async (plugin: Plugin): Promise<() => Promise<void>> => {
		if (!plugin.name) {
			throw new Error('plugin.name is required')
		}

		if (plugins.has(plugin.name)) {
			throw new Error(`plugin "${plugin.name}" is already registered`)
		}

		plugins.set(plugin.name, plugin)
		const localCleanups: Array<() => void | Promise<void>> = []
		cleanups.set(plugin.name, localCleanups)

		try {
			await plugin.setup?.(pluginContext)
			await plugin.hooks?.onLoad?.(pluginContext)
		} catch (error) {
			plugins.delete(plugin.name)
			cleanups.delete(plugin.name)
			log.error({ error, plugin: plugin.name }, 'plugin setup failed')
			throw error
		}

		const onMessage: Middleware = async ctx => {
			let stopped = false
			const messageContext: PluginMessageContext = {
				jid: ctx.jid,
				senderJid: ctx.message.key.participantAlt || ctx.message.key.participant || ctx.message.key.remoteJid || undefined,
				message: ctx.message,
				text: extractMessageText(ctx.message.message),
				sock: opts.sock,
				reply: async (content, options) => opts.sock.sendMessage?.(ctx.jid, content, options),
				stop: () => {
					stopped = true
				}
			}

			try {
				await plugin.hooks?.onMessage?.(messageContext)
			} catch (error) {
				log.error({ error, plugin: plugin.name, jid: ctx.jid }, 'plugin onMessage failed')
			}

			if (stopped) {
				ctx.stop()
			}
		}

		if (opts.sock.use) {
			const off = opts.sock.use(onMessage)
			if (typeof off === 'function') {
				localCleanups.push(off)
			}
		} else {
			const listener = (payload: BaileysEventMap['messages.upsert']) => {
				if (payload.type !== 'notify') {
					return
				}

				for (const message of payload.messages) {
					const jid = jidForMessage(message)
					if (!jid) {
						continue
					}

					void onMessage({
						jid,
						message,
						stop: () => undefined
					})
				}
			}

			opts.sock.ev.on('messages.upsert', listener)
			localCleanups.push(() => opts.sock.ev.off('messages.upsert', listener))
		}

		const onConnectionUpdate = (update: BaileysEventMap['connection.update']) => {
			try {
				const result = plugin.hooks?.onConnectionUpdate?.(update, pluginContext)
				if (result && typeof (result as Promise<unknown>).catch === 'function') {
					;(result as Promise<unknown>).catch(error =>
						log.error({ error, plugin: plugin.name }, 'plugin onConnectionUpdate failed')
					)
				}
			} catch (error) {
				log.error({ error, plugin: plugin.name }, 'plugin onConnectionUpdate failed')
			}
		}
		const onCredsUpdate = (update: BaileysEventMap['creds.update']) => {
			try {
				const result = plugin.hooks?.onCredsUpdate?.(update, pluginContext)
				if (result && typeof (result as Promise<unknown>).catch === 'function') {
					;(result as Promise<unknown>).catch(error =>
						log.error({ error, plugin: plugin.name }, 'plugin onCredsUpdate failed')
					)
				}
			} catch (error) {
				log.error({ error, plugin: plugin.name }, 'plugin onCredsUpdate failed')
			}
		}

		opts.sock.ev.on('connection.update', onConnectionUpdate)
		opts.sock.ev.on('creds.update', onCredsUpdate)
		localCleanups.push(() => opts.sock.ev.off('connection.update', onConnectionUpdate))
		localCleanups.push(() => opts.sock.ev.off('creds.update', onCredsUpdate))

		return async () => {
			await unregister(plugin.name)
		}
	}

	const unregister = async (name: string): Promise<boolean> => {
		const plugin = plugins.get(name)
		if (!plugin) {
			return false
		}

		const localCleanups = cleanups.get(name) ?? []
		for (const cleanup of localCleanups) {
			try {
				await cleanup()
			} catch (error) {
				log.warn({ error, plugin: name }, 'plugin cleanup failed')
			}
		}

		try {
			await plugin.hooks?.onUnload?.(pluginContext)
		} catch (error) {
			log.warn({ error, plugin: name }, 'plugin onUnload failed')
		}

		cleanups.delete(name)
		plugins.delete(name)
		return true
	}

	const stop = async (): Promise<void> => {
		for (const name of Array.from(plugins.keys())) {
			await unregister(name)
		}
	}

	const list = (): PluginInfo[] =>
		Array.from(plugins.values()).map(plugin => ({ name: plugin.name, version: plugin.version }))

	const get = (name: string): Plugin | undefined => plugins.get(name)

	return {
		register,
		unregister,
		stop,
		list,
		get
	}
}

export type PluginManager = ReturnType<typeof makePluginManager>
