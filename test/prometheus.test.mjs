import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createPrometheusExporter, renderPrometheusMetrics } from '../lib/Utils/prometheus.js'

const metrics = {
	connection: 'open',
	messagesReceived: 3,
	messagesSent: 4,
	sendFailures: 1,
	messagesUpdated: 2,
	messagesDeleted: 1,
	mediaDownloads: 5,
	connectionOpens: 2,
	disconnects: 1,
	uptimeMs: 12_500,
	connectedForMs: 10_000,
	scheduler: { pending: 2, restored: true, persistent: false },
	mediaCache: { size: 6, bytes: 2048 }
}

describe('prometheus exporter', () => {
	it('renders counters, gauges and labelled connection state', () => {
		const text = renderPrometheusMetrics(metrics, 'baileysx')
		assert.match(text, /baileysx_messages_received_total 3/)
		assert.match(text, /baileysx_messages_sent_total 4/)
		assert.match(text, /baileysx_send_failures_total 1/)
		assert.match(text, /baileysx_uptime_seconds 12\.5/)
		assert.match(text, /baileysx_connection_state\{state="open"\} 1/)
		assert.match(text, /baileysx_connection_state\{state="close"\} 0/)
		assert.match(text, /baileysx_scheduler_pending 2/)
		assert.match(text, /baileysx_media_cache_bytes 2048/)
	})

	it('sanitizes the metric prefix and works with the exporter wrapper', () => {
		const exporter = createPrometheusExporter({
			sock: { getMetrics: () => metrics },
			prefix: 'my-app!'
		})
		assert.match(exporter.contentType, /text\/plain/)
		const text = exporter.render()
		assert.match(text, /my_app__messages_received_total 3/)
	})

	it('skips missing and non-finite values', () => {
		const text = renderPrometheusMetrics({ messagesReceived: Number.NaN }, 'x')
		assert.doesNotMatch(text, /x_messages_received_total/)
		assert.doesNotMatch(text, /x_uptime_seconds/)
	})
})
