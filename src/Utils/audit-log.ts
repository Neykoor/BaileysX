export type AuditOutcome = 'success' | 'failure'

export type AuditEvent = {
	action: string
	tenantId?: string
	sessionId?: string
	actor?: string
	outcome?: AuditOutcome
	metadata?: Record<string, unknown>
	timestamp?: number
}

export type AuditRecord = AuditEvent & {
	timestamp: number
}

export type AuditSink = (event: AuditRecord) => void | Promise<void>

export type AuditLogOptions = {
	sink: AuditSink
	now?: () => number
	/** Metadata keys redacted recursively. Defaults to common secret names. */
	redactKeys?: string[]
}

const DEFAULT_REDACT_KEYS = ['passphrase', 'password', 'token', 'secret', 'authorization', 'apikey', 'api_key']

const redactValue = (value: unknown, keys: Set<string>): unknown => {
	if (Array.isArray(value)) {
		return value.map(item => redactValue(item, keys))
	}

	if (value && typeof value === 'object') {
		const result: Record<string, unknown> = {}
		for (const [key, item] of Object.entries(value)) {
			result[key] = keys.has(key.toLowerCase()) ? '[redacted]' : redactValue(item, keys)
		}

		return result
	}

	return value
}

export const makeAuditLog = (opts: AuditLogOptions) => {
	const now = opts.now ?? Date.now
	const redactKeys = new Set((opts.redactKeys ?? DEFAULT_REDACT_KEYS).map(key => key.toLowerCase()))

	const record = async (event: AuditEvent): Promise<AuditRecord> => {
		const record: AuditRecord = {
			...event,
			metadata: event.metadata ? (redactValue(event.metadata, redactKeys) as Record<string, unknown>) : undefined,
			timestamp: event.timestamp ?? now()
		}
		await opts.sink(record)
		return record
	}

	return { record }
}

export type AuditLog = ReturnType<typeof makeAuditLog>

export const makeMemoryAuditSink = () => {
	const events: AuditRecord[] = []
	const sink: AuditSink = event => {
		events.push(event)
	}

	return {
		events,
		sink,
		clear: () => {
			events.length = 0
		}
	}
}
