import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createHttpGateway } from '../lib/Utils/http-gateway.js'

describe('HTTP gateway', () => {
	it('serves health, metrics, dashboard, webhook and send routes', async t => {
		const sent = []
		const webhookBodies = []
		const gateway = createHttpGateway({
			sock: {
				getHealth: () => ({ status: 'connected', messages: 2 }),
				getMetrics: () => ({
					connection: 'open',
					messagesReceived: 2,
					messagesSent: 1,
					uptimeMs: 1000,
					connectedForMs: 500
				}),
				sendMessage: async (jid, content, options) => {
					sent.push({ jid, content, options })
					return { key: { id: 'sent-1' } }
				}
			},
			port: 0,
			token: 'secret',
			onWebhook: async request => {
				webhookBodies.push(request.body)
				return { received: true, query: request.query.get('source') }
			}
		})

		const { url } = await gateway.start()
		t.after(async () => {
			await gateway.close()
		})

		const unauthorized = await fetch(`${url}/health`)
		assert.equal(unauthorized.status, 401)

		const health = await fetch(`${url}/health`, {
			headers: { authorization: 'Bearer secret' }
		})
		assert.equal(health.status, 200)
		assert.deepEqual(await health.json(), { status: 'connected', messages: 2 })

		const metrics = await fetch(`${url}/metrics`, {
			headers: { 'x-api-key': 'secret' }
		})
		assert.equal(metrics.status, 200)
		const metricsText = await metrics.text()
		assert.match(metricsText, /baileysx_messages_received_total 2/)
		assert.match(metricsText, /baileysx_connection_state\{state="open"\} 1/)

		const dashboard = await fetch(`${url}/`)
		assert.equal(dashboard.status, 200)
		assert.match(await dashboard.text(), /BaileysX Gateway/)

		const webhook = await fetch(`${url}/webhook?source=test`, {
			method: 'POST',
			headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
			body: JSON.stringify({ event: 'ping' })
		})
		assert.equal(webhook.status, 200)
		assert.deepEqual(await webhook.json(), { ok: true, result: { received: true, query: 'test' } })
		assert.deepEqual(webhookBodies, [{ event: 'ping' }])

		const send = await fetch(`${url}/send`, {
			method: 'POST',
			headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
			body: JSON.stringify({ jid: '123@s.whatsapp.net', content: { text: 'hello' } })
		})
		assert.equal(send.status, 200)
		assert.deepEqual(await send.json(), { ok: true, message: { key: { id: 'sent-1' } } })
		assert.equal(sent.length, 1)
		assert.equal(sent[0].content.text, 'hello')

		const notFound = await fetch(`${url}/missing`, {
			headers: { authorization: 'Bearer secret' }
		})
		assert.equal(notFound.status, 404)
	})

	it('reports missing webhook handlers and validates send payloads', async t => {
		const gateway = createHttpGateway({
			sock: { sendMessage: async () => ({}) },
			port: 0,
			dashboard: false
		})
		const { url } = await gateway.start()
		t.after(async () => {
			await gateway.close()
		})

		assert.equal((await fetch(`${url}/`)).status, 404)
		assert.equal((await fetch(`${url}/webhook`, { method: 'POST' })).status, 501)
		const invalid = await fetch(`${url}/send`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jid: '123@s.whatsapp.net' })
		})
		assert.equal(invalid.status, 400)
	})
})
