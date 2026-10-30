export type CliDependencies = {
	fetch?: typeof fetch
	stdout?: (message: string) => void
	stderr?: (message: string) => void
	env?: Record<string, string | undefined>
}

type ParsedArgs = {
	command?: string
	flags: Map<string, string | true>
	positionals: string[]
}

const parseArgs = (argv: string[]): ParsedArgs => {
	const flags = new Map<string, string | true>()
	const positionals: string[] = []
	let command: string | undefined

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!
		if (arg === '--') {
			positionals.push(...argv.slice(i + 1))
			break
		}

		if (arg.startsWith('--')) {
			const [rawKey, inlineValue] = arg.slice(2).split('=', 2)
			if (!rawKey) {
				continue
			}

			if (inlineValue !== undefined) {
				flags.set(rawKey, inlineValue)
			} else {
				const next = argv[i + 1]
				if (next !== undefined && !next.startsWith('-')) {
					flags.set(rawKey, next)
					i++
				} else {
					flags.set(rawKey, true)
				}
			}
			continue
		}

		if (!command) {
			command = arg
		} else {
			positionals.push(arg)
		}
	}

	return { command, flags, positionals }
}

const flagString = (flags: Map<string, string | true>, name: string): string | undefined => {
	const value = flags.get(name)
	return typeof value === 'string' ? value : undefined
}

const flagBool = (flags: Map<string, string | true>, name: string): boolean => flags.has(name)

const helpText = `BaileysX CLI

Usage:
  baileysx health   [--url http://127.0.0.1:3000] [--token TOKEN]
  baileysx metrics  [--url ...] [--token TOKEN]
  baileysx webhook  [--url ...] [--token TOKEN] --body '{"event":"ping"}'
  baileysx send     [--url ...] [--token TOKEN] --jid 123@s.whatsapp.net --text "hello"
  baileysx help

Environment:
  BAILEYSX_GATEWAY_URL   Default gateway URL
  BAILEYSX_TOKEN         Default bearer token
`

const responseText = async (response: Response): Promise<string> => {
	const text = await response.text()
	try {
		return JSON.stringify(JSON.parse(text), null, 2)
	} catch {
		return text
	}
}

export const runCli = async (argv: string[], deps: CliDependencies = {}): Promise<number> => {
	const out = deps.stdout ?? (message => process.stdout.write(`${message}\n`))
	const err = deps.stderr ?? (message => process.stderr.write(`${message}\n`))
	const env = deps.env ?? process.env
	const fetchImpl = deps.fetch ?? fetch
	const { command, flags } = parseArgs(argv)

	if (!command || command === 'help' || flagBool(flags, 'help')) {
		out(helpText)
		return 0
	}

	if (command === 'version' || flagBool(flags, 'version')) {
		out('baileysx')
		return 0
	}

	const baseUrl = (flagString(flags, 'url') ?? env.BAILEYSX_GATEWAY_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '')
	const token = flagString(flags, 'token') ?? env.BAILEYSX_TOKEN
	const headers: Record<string, string> = {}
	if (token) {
		headers.authorization = `Bearer ${token}`
	}

	const request = async (path: string, init?: RequestInit): Promise<Response> => {
		const response = await fetchImpl(`${baseUrl}${path}`, {
			...init,
			headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) }
		})
		if (!response.ok) {
			err(`HTTP ${response.status}: ${await response.text()}`)
			return response
		}

		return response
	}

	try {
		if (command === 'health') {
			const response = await request('/health')
			if (!response.ok) {
				return 1
			}
			out(await responseText(response))
			return 0
		}

		if (command === 'metrics') {
			const response = await request('/metrics')
			if (!response.ok) {
				return 1
			}
			out(await response.text())
			return 0
		}

		if (command === 'webhook') {
			const body = flagString(flags, 'body') ?? '{}'
			const response = await request('/webhook', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body
			})
			if (!response.ok) {
				return 1
			}
			out(await responseText(response))
			return 0
		}

		if (command === 'send') {
			const jid = flagString(flags, 'jid')
			const text = flagString(flags, 'text')
			const contentFlag = flagString(flags, 'content')
			if (!jid || (!text && !contentFlag)) {
				err('send requires --jid and either --text or --content')
				return 1
			}

			const content = contentFlag ? JSON.parse(contentFlag) : { text }
			const response = await request('/send', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ jid, content })
			})
			if (!response.ok) {
				return 1
			}
			out(await responseText(response))
			return 0
		}

		err(`unknown command "${command}"`)
		out(helpText)
		return 1
	} catch (error) {
		err(error instanceof Error ? error.message : String(error))
		return 1
	}
}
