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
	const owners = new Set((opts.owners || []).map(String))
	const cmds = new Map<string, BotCommand>()
	const cd = new Map<string, number>()

	const register = (c: BotCommand) => {
		cmds.set(c.name.toLowerCase(), c)
		for (const a of c.aliases || []) cmds.set(a.toLowerCase(), c)
	}

	const list = () => [...cmds.values()].filter((v, i, arr) => arr.findIndex(x => x.name === v.name) === i)

	const handle = async (ev: any) => {
		const m = ev?.messages?.[0] || ev
		const text = m?.message?.conversation || m?.message?.extendedTextMessage?.text || m?.message?.imageMessage?.caption || m?.message?.videoMessage?.caption || ''
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

		const jid = m.key?.remoteJidAlt || m.key?.remoteJid
		const isGroup = typeof jid === 'string' && jid.endsWith('@g.us')
		const sender = m.key?.participantAlt || m.key?.participant || jid

		if (c.groupOnly && !isGroup) return false
		if (c.privateOnly && isGroup) return false

		let isAdmin = false, isSuperAdmin = false
		if (isGroup && jid) {
			const admins = (await opts.getGroupAdmins?.(jid)) || []
			const supers = (await opts.getGroupSuperAdmins?.(jid)) || []
			isAdmin = admins.includes(sender)
			isSuperAdmin = supers.includes(sender) || isAdmin
		}

		const isOwner = owners.has(sender)
		if (c.ownerOnly && !isOwner) return false
		if (c.superAdminOnly && !(isSuperAdmin || isOwner)) return false
		if (c.adminOnly && !(isAdmin || isSuperAdmin || isOwner)) return false

		const key = `${jid}:${sender}:${c.name}`
		const now = Date.now()
		const last = cd.get(key)
		if (c.cooldownMs && typeof last === 'number' && now - last < c.cooldownMs) return true
		if (c.cooldownMs) cd.set(key, now)

		const ctx: BotCommandCtx = {
			sock: ev.sock || ev,
			jid,
			groupJid: isGroup ? jid : undefined,
			senderJid: sender,
			isGroup,
			isAdmin,
			isSuperAdmin,
			isOwner,
			args: rest,
			text: body,
			mentioned: [],
			reply: async (content: any, opts2?: any) => (ev.sock || ev).sendMessage?.(jid, content, opts2),
			send: async (content: any, opts2?: any) => (ev.sock || ev).sendMessage?.(jid, content, opts2)
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
