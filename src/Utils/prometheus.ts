export type PrometheusSocket = {
	getMetrics: () => Record<string, unknown>
}

export type PrometheusExporterOptions = {
	sock: PrometheusSocket
	prefix?: string
}

export type PrometheusExporter = {
	contentType: string
	render: () => string
}

const sanitizeName = (value: string): string => {
	const sanitized = value.replace(/[^a-zA-Z0-9_:]/g, '_')
	return /^[a-zA-Z_:]/.test(sanitized) ? sanitized : `_${sanitized}`
}

const escapeLabel = (value: string): string => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')

const numberValue = (value: unknown): number | undefined => {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value
	}

	if (typeof value === 'boolean') {
		return value ? 1 : 0
	}

	return undefined
}

const metric = (
	lines: string[],
	name: string,
	help: string,
	value: unknown,
	type: 'counter' | 'gauge' = 'gauge',
	labels?: Record<string, string>
) => {
	const numeric = numberValue(value)
	if (numeric === undefined) {
		return
	}

	lines.push(`# HELP ${name} ${help}`)
	lines.push(`# TYPE ${name} ${type}`)
	const labelText = labels
		? `{${Object.entries(labels)
				.map(([key, labelValue]) => `${key}="${escapeLabel(labelValue)}"`)
				.join(',')}}`
		: ''
	lines.push(`${name}${labelText} ${numeric}`)
}

/**
 * Formats the built-in socket counters as Prometheus text exposition format.
 * No external metrics library is required.
 */
export const renderPrometheusMetrics = (
	metrics: Record<string, unknown>,
	prefix = 'baileysx'
): string => {
	const p = sanitizeName(prefix.replace(/_+$/, ''))
	const lines: string[] = []

	metric(lines, `${p}_messages_received_total`, 'Messages received from WhatsApp.', metrics.messagesReceived, 'counter')
	metric(lines, `${p}_messages_sent_total`, 'Messages sent successfully.', metrics.messagesSent, 'counter')
	metric(lines, `${p}_send_failures_total`, 'Message send failures.', metrics.sendFailures, 'counter')
	metric(lines, `${p}_messages_updated_total`, 'Message update events.', metrics.messagesUpdated, 'counter')
	metric(lines, `${p}_messages_deleted_total`, 'Message delete events.', metrics.messagesDeleted, 'counter')
	metric(lines, `${p}_media_downloads_total`, 'Media downloads.', metrics.mediaDownloads, 'counter')
	metric(lines, `${p}_connection_opens_total`, 'Successful connection opens.', metrics.connectionOpens, 'counter')
	metric(lines, `${p}_disconnects_total`, 'Connection closes.', metrics.disconnects, 'counter')
	metric(lines, `${p}_uptime_seconds`, 'Process uptime for this socket.', typeof metrics.uptimeMs === 'number' ? metrics.uptimeMs / 1000 : undefined)
	metric(
		lines,
		`${p}_connected_seconds`,
		'Time spent connected to WhatsApp.',
		typeof metrics.connectedForMs === 'number' ? metrics.connectedForMs / 1000 : undefined
	)

	if (typeof metrics.connection === 'string') {
		const states = ['connecting', 'open', 'close']
		lines.push(`# HELP ${p}_connection_state Current socket connection state.`)
		lines.push(`# TYPE ${p}_connection_state gauge`)
		for (const state of states) {
			lines.push(`${p}_connection_state{state="${state}"} ${metrics.connection === state ? 1 : 0}`)
		}
	}

	const scheduler = metrics.scheduler as Record<string, unknown> | undefined
	if (scheduler) {
		metric(lines, `${p}_scheduler_pending`, 'Messages waiting in the scheduler.', scheduler.pending)
		metric(lines, `${p}_scheduler_restored`, 'Whether the scheduler restored its outbox.', scheduler.restored)
		metric(lines, `${p}_scheduler_persistent`, 'Whether the scheduler has a persistent store.', scheduler.persistent)
	}

	const mediaCache = metrics.mediaCache as Record<string, unknown> | undefined
	if (mediaCache) {
		metric(lines, `${p}_media_cache_items`, 'Items currently held in the media cache.', mediaCache.size)
		metric(lines, `${p}_media_cache_bytes`, 'Approximate bytes held in the media cache.', mediaCache.bytes)
	}

	return `${lines.join('\n')}\n`
}

export const createPrometheusExporter = (opts: PrometheusExporterOptions): PrometheusExporter => ({
	contentType: 'text/plain; version=0.0.4; charset=utf-8',
	render: () => renderPrometheusMetrics(opts.sock.getMetrics(), opts.prefix)
})
