import P from 'pino'

const REDACTED = '[REDACTED]'
const SENSITIVE_KEYS = new Set([
	'keys',
	'creds',
	'auth',
	'authState',
	'session',
	'token',
	'accesstoken',
	'access_token',
	'password',
	'passphrase',
	'privatekey',
	'private_key',
	'signaturekey',
	'signingkey',
	'registrationid',
	'registration_id',
	'signal',
	'identitykey',
	'prekey',
	'signedprekey',
	'ephemeralkey'
])

const redactValue = (value: unknown): unknown => {
	if (value === null || value === undefined) {
		return value
	}

	if (typeof value === 'string') {
		// Redact long base64/hex like secrets
		if (value.length > 64 && /^[A-Za-z0-9+/=\-_]+$/.test(value)) {
			return REDACTED
		}
		return value
	}

	if (Array.isArray(value)) {
		return value.map(redactValue)
	}

	if (Buffer.isBuffer(value)) {
		return REDACTED
	}

	if (value instanceof Uint8Array) {
		return REDACTED
	}

	if (typeof value === 'object') {
		const obj = value as Record<string, unknown>
		const out: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(obj)) {
			const lower = k.toLowerCase()
			if (SENSITIVE_KEYS.has(lower) || lower.includes('secret') || lower.includes('private')) {
				out[k] = REDACTED
			} else {
				out[k] = redactValue(v)
			}
		}
		return out
	}

	return value
}

const baseLogger = P({ timestamp: () => `,"time":"${new Date().toJSON()}"` })

const wrap = (logger: ILogger): ILogger => ({
	get level() {
		return logger.level
	},
	set level(v: string) {
		;(logger as any).level = v
	},
	child(obj: Record<string, unknown>) {
		return wrap(logger.child(redactValue(obj) as Record<string, unknown>))
	},
	trace(obj: unknown, msg?: string) {
		if (msg !== undefined) {
			logger.trace(redactValue(obj) as any, msg)
		} else {
			logger.trace(redactValue(obj) as any)
		}
	},
	debug(obj: unknown, msg?: string) {
		if (msg !== undefined) {
			logger.debug(redactValue(obj) as any, msg)
		} else {
			logger.debug(redactValue(obj) as any)
		}
	},
	info(obj: unknown, msg?: string) {
		if (msg !== undefined) {
			logger.info(redactValue(obj) as any, msg)
		} else {
			logger.info(redactValue(obj) as any)
		}
	},
	warn(obj: unknown, msg?: string) {
		if (msg !== undefined) {
			logger.warn(redactValue(obj) as any, msg)
		} else {
			logger.warn(redactValue(obj) as any)
		}
	},
	error(obj: unknown, msg?: string) {
		if (msg !== undefined) {
			logger.error(redactValue(obj) as any, msg)
		} else {
			logger.error(redactValue(obj) as any)
		}
	}
})

export interface ILogger {
	level: string
	child(obj: Record<string, unknown>): ILogger
	trace(obj: unknown, msg?: string): void
	debug(obj: unknown, msg?: string): void
	info(obj: unknown, msg?: string): void
	warn(obj: unknown, msg?: string): void
	error(obj: unknown, msg?: string): void
}

const logger = wrap(baseLogger)
export default logger
