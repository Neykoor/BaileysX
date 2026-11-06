import { extractMentions, normalizeJid } from './jid'

export type BotCommandCtx = {
	sock: any
	jid: string
	groupJid?: string
	senderJid?: string
	isGroup: boolean
	isAdmin: boolean
	isSuperAdmin: boolean
	isOwner: boolean
	args: string[]
	text: string
	mentioned: string[]
	reply: (content: any, opts?: any) => Promise<any>
	send: (content: any, opts?: any) => Promise<any>
}

export type BotCommand = {
	name: string
	aliases?: string[]
	desc?: string
	usage?: string
	category?: string
	adminOnly?: boolean
	superAdminOnly?: boolean
	ownerOnly?: boolean
	groupOnly?: boolean
	privateOnly?: boolean
	cooldownMs?: number
	hidden?: boolean
	exec: (ctx: BotCommandCtx) => void | Promise<void>
}

export type BotRouterOpts = {
	prefix?: string
	owners?: string[]
	getGroupAdmins?: (groupJid: string) => Promise<string[]>
	getGroupSuperAdmins?: (groupJid: string) => Promise<string[]>
	logger?: any
}

export const makeBotRouter = (opts: BotRouterOpts = {}) => {
	const prefix = opts.prefix ?? '.'
	const owners = new Set(
		(opts.owners || []).map(owner => normalizeJid(String(owner)) ?? String(owner))
	)
	const cmds = new Map<string, BotCommand>()
	const cd = new Map<string, number>()

	const register = (c: BotCommand) => {
		const name = c.name.toLowerCase()
		const previous = cmds.get(name)
		if (previous && previous !== c) {
			for (const alias of previous.aliases || []) {
				const key = alias.toLowerCase()
				if (key !== name && cmds.get(key) === previous) cmds.delete(key)
			}
		}

		cmds.set(name, c)
		for (const a of c.aliases || []) cmds.set(a.toLowerCase(), c)
	}

	const list = () => [...new Set(cmds.values())]

	const handle = async (ev: any) => {
		const raw = ev?.messages?.[0] || ev
		const pluginCtx = raw?.message?.key ? raw : undefined
		const m = pluginCtx?.message ?? raw
		const content = m?.message

		let text =
			content?.conversation ||
			content?.extendedTextMessage?.text ||
			content?.imageMessage?.caption ||
			content?.videoMessage?.caption ||
			''
		if (typeof text !== 'string' || !text) {
			text = typeof raw?.text === 'string' ? raw.text : text
		}
		if (typeof text !== 'string') return false
		if (!text.trim().startsWith(prefix)) return false
		const body = text.trim().slice(prefix.length).trim()
		if (!body) return false
		const parts = body.split(/\s+/)
		const name = parts[0]
		if (!name) return false
		const rest = parts.slice(1)
		const c = cmds.get(name.toLowerCase())
		if (!c) return false

		const rawJid = pluginCtx?.jid || m?.key?.remoteJidAlt || m?.key?.remoteJid
		const jid = normalizeJid(rawJid) ?? rawJid
		const isGroup = typeof jid === 'string' && jid.endsWith('@g.us')
		const rawSender = pluginCtx?.senderJid || m?.key?.participantAlt || m?.key?.participant || rawJid
		const sender = normalizeJid(rawSender) ?? rawSender

		if (c.groupOnly && !isGroup) return false
		if (c.privateOnly && isGroup) return false

		let isAdmin = false, isSuperAdmin = false
		if (isGroup && jid) {
			const admins = ((await opts.getGroupAdmins?.(jid)) || []).map(a => normalizeJid(a) ?? a)
			const supers = ((await opts.getGroupSuperAdmins?.(jid)) || []).map(a => normalizeJid(a) ?? a)
			isAdmin = admins.includes(sender)
			isSuperAdmin = supers.includes(sender)
		}

		const isOwner = typeof sender === 'string' && owners.has(sender)
		if (c.ownerOnly && !isOwner) return false
		if (c.superAdminOnly && !(isSuperAdmin || isOwner)) return false
		if (c.adminOnly && !(isAdmin || isSuperAdmin || isOwner)) return false

		const key = `${jid}:${sender}:${c.name}`
		const now = Date.now()
		const last = cd.get(key)
		if (c.cooldownMs && typeof last === 'number' && now - last < c.cooldownMs) return true
		if (c.cooldownMs) cd.set(key, now)

		const sock =
			ev?.sock || pluginCtx?.sock || (typeof ev?.sendMessage === 'function' ? ev : undefined)
		const reply =
			typeof pluginCtx?.reply === 'function'
				? (content2: any, opts2?: any) => pluginCtx.reply(content2, opts2)
				: async (content2: any, opts2?: any) => sock?.sendMessage?.(jid, content2, opts2)

		const ctx: BotCommandCtx = {
			sock,
			jid: jid as string,
			groupJid: isGroup ? (jid as string) : undefined,
			senderJid: sender,
			isGroup,
			isAdmin,
			isSuperAdmin,
			isOwner,
			args: rest,
			text: body,
			mentioned: extractMentions(m),
			reply,
			send: async (content2: any, opts2?: any) => sock?.sendMessage?.(jid, content2, opts2)
		}

		try {
			await c.exec(ctx)
		} catch (err) {
			opts.logger?.error?.({ err, cmd: c.name }, 'bot command error')
		}
		return true
	}

	return { register, list, handle, commands: cmds }
}

export type BotRouter = ReturnType<typeof makeBotRouter>
