import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage } from '../Types/Message'
import type { ILogger } from './logger'
import logger from './logger'
import { extractMessageText } from './messages'
import type { Middleware } from './middleware'

export type CommandContext = {
	command: string
	args: string[]
	text: string
	jid: string
	senderJid?: string
	message: WAMessage
	reply: (content: AnyMessageContent, options?: MiscMessageGenerationOptions) => Promise<unknown>
}

export type CommandHandler = (ctx: CommandContext) => void | Promise<void>

export type CommandDefinition = {
	name: string
	aliases?: string[]
	description?: string
	permission?: (ctx: CommandContext) => boolean | Promise<boolean>
	cooldownMs?: number
	handler: CommandHandler
}

export type CommandRouterOptions = {
	/** One or more command prefixes. Defaults to `/`. */
	prefix?: string | string[]
	sendMessage?: (
		jid: string,
		content: AnyMessageContent,
		options?: MiscMessageGenerationOptions
	) => Promise<unknown>
	logger?: ILogger
	now?: () => number
	/** Stop the incoming middleware chain after a command is handled. */
	stopOnCommand?: boolean
}

export type CommandResultReason = 'no-prefix' | 'not-found' | 'forbidden' | 'cooldown' | 'error'

export type CommandHandleResult = {
	handled: boolean
	command?: string
	reason?: CommandResultReason
}

export type CommandRouter = ReturnType<typeof makeCommandRouter>

const senderForMessage = (message: WAMessage): string | undefined =>
	message.key.participantAlt || message.key.participant || message.key.remoteJid || undefined

export const makeCommandRouter = (opts: CommandRouterOptions = {}) => {
	const log = opts.logger ?? logger
	const now = opts.now ?? Date.now
	const prefixes = (Array.isArray(opts.prefix) ? opts.prefix : [opts.prefix ?? '/'])
		.filter(prefix => prefix.length > 0)
		.sort((a, b) => b.length - a.length)
	const commands = new Map<string, CommandDefinition>()
	const cooldowns = new Map<string, number>()

	if (prefixes.length === 0) {
		throw new Error('at least one non-empty command prefix is required')
	}

	const register = (definition: CommandDefinition): (() => void) => {
		const name = definition.name.toLowerCase()
		if (!name) {
			throw new Error('command name is required')
		}

		if (commands.has(name)) {
			throw new Error(`command "${definition.name}" is already registered`)
		}

		commands.set(name, definition)
		for (const alias of definition.aliases ?? []) {
			const key = alias.toLowerCase()
			if (commands.has(key)) {
				throw new Error(`command alias "${alias}" is already registered`)
			}

			commands.set(key, definition)
		}

		return () => {
			for (const [key, value] of commands) {
				if (value === definition) {
					commands.delete(key)
				}
			}
		}
	}

	const handle = async (
		message: WAMessage,
		extra: { jid?: string; sendMessage?: CommandRouterOptions['sendMessage'] } = {}
	): Promise<CommandHandleResult> => {
		const jid = extra.jid || message.key.remoteJidAlt || message.key.remoteJid || undefined
		if (!jid) {
			return { handled: false, reason: 'not-found' }
		}

		const text = extractMessageText(message.message)
		const prefix = prefixes.find(candidate => text.startsWith(candidate))
		if (!prefix) {
			return { handled: false, reason: 'no-prefix' }
		}

		const body = text.slice(prefix.length).trim()
		const [rawCommand, ...args] = body.split(/\s+/).filter(Boolean)
		if (!rawCommand) {
			return { handled: false, reason: 'not-found' }
		}

		const definition = commands.get(rawCommand.toLowerCase())
		if (!definition) {
			return { handled: false, reason: 'not-found' }
		}

		const send = extra.sendMessage ?? opts.sendMessage
		const context: CommandContext = {
			command: definition.name,
			args,
			text: body,
			jid,
			senderJid: senderForMessage(message),
			message,
			reply: async (content, options) => (send ? send(jid, content, options) : undefined)
		}

		if (definition.permission) {
			try {
				if (!(await definition.permission(context))) {
					return { handled: false, command: definition.name, reason: 'forbidden' }
				}
			} catch (error) {
				log.error({ error, command: definition.name, jid }, 'command permission check failed')
				return { handled: false, command: definition.name, reason: 'error' }
			}
		}

		const cooldown = definition.cooldownMs ?? 0
		if (cooldown > 0) {
			const key = `${context.senderJid ?? jid}|${definition.name}`
			const current = now()
			const availableAt = cooldowns.get(key) ?? 0
			if (availableAt > current) {
				return { handled: false, command: definition.name, reason: 'cooldown' }
			}

			cooldowns.set(key, current + cooldown)
		}

		try {
			await definition.handler(context)
			return { handled: true, command: definition.name }
		} catch (error) {
			log.error({ error, command: definition.name, jid }, 'command handler failed')
			return { handled: false, command: definition.name, reason: 'error' }
		}
	}

	const middleware = (): Middleware => async ctx => {
		const result = await handle(ctx.message, { jid: ctx.jid })
		if (result.handled && opts.stopOnCommand) {
			ctx.stop()
		}
	}

	const list = (): Array<Omit<CommandDefinition, 'handler' | 'permission'>> =>
		Array.from(new Set(commands.values())).map(definition => ({
			name: definition.name,
			aliases: definition.aliases,
			description: definition.description,
			cooldownMs: definition.cooldownMs
		}))

	const get = (name: string): CommandDefinition | undefined => commands.get(name.toLowerCase())

	return {
		command: register,
		use: register,
		handle,
		middleware,
		list,
		get
	}
}
