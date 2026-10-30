import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runCli } from '../lib/Cli/index.js'

const makeFetch = () => {
	const calls = []
	const fetch = async (url, init = {}) => {
		calls.push({ url, init })
		const path = new URL(url).pathname
		if (path === '/health') {
			return new Response(JSON.stringify({ status: 'connected' }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		}
		if (path === '/metrics') {
			return new Response('baileysx_messages_sent_total 1\n', {
				status: 200,
				headers: { 'content-type': 'text/plain' }
			})
		}
		if (path === '/webhook') {
			return new Response(JSON.stringify({ ok: true }), { status: 200 })
		}
		if (path === '/send') {
			return new Response(JSON.stringify({ ok: true, message: { key: { id: 'x' } } }), {
				status: 200
			})
		}
		return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
	}
	return { calls, fetch }
}

const capture = () => {
	const lines = []
	return {
		lines,
		write: message => lines.push(message)
	}
}

describe('CLI', () => {
	it('queries health and metrics with a bearer token', async () => {
		const { calls, fetch } = makeFetch()
		const stdout = capture()
		const stderr = capture()

		const code = await runCli(['health', '--url', 'http://gateway', '--token', 'tok'], {
			fetch,
			stdout: stdout.write,
			stderr: stderr.write
		})
		assert.equal(code, 0)
		assert.match(stdout.lines.join('\n'), /"status": "connected"/)
		assert.equal(calls[0].url, 'http://gateway/health')
		assert.equal(calls[0].init.headers.authorization, 'Bearer tok')

		const metricsCode = await runCli(['metrics', '--url', 'http://gateway'], {
			fetch,
			stdout: stdout.write,
			stderr: stderr.write
		})
		assert.equal(metricsCode, 0)
		assert.match(stdout.lines.at(-1), /baileysx_messages_sent_total 1/)
	})

	it('posts webhook and send payloads', async () => {
		const { calls, fetch } = makeFetch()
		const stdout = capture()
		const stderr = capture()

		const webhookCode = await runCli(
			['webhook', '--url', 'http://gateway', '--body', '{"event":"ping"}'],
			{ fetch, stdout: stdout.write, stderr: stderr.write }
		)
		assert.equal(webhookCode, 0)
		assert.equal(calls[0].init.body, '{"event":"ping"}')

		const sendCode = await runCli(
			[
				'send',
				'--url',
				'http://gateway',
				'--jid',
				'123@s.whatsapp.net',
				'--text',
				'hello'
			],
			{ fetch, stdout: stdout.write, stderr: stderr.write }
		)
		assert.equal(sendCode, 0)
		const body = JSON.parse(calls[1].init.body)
		assert.equal(body.jid, '123@s.whatsapp.net')
		assert.equal(body.content.text, 'hello')
	})

	it('handles help, version, unknown commands and HTTP failures', async () => {
		const { fetch } = makeFetch()
		const stdout = capture()
		const stderr = capture()

		assert.equal(await runCli(['help'], { fetch, stdout: stdout.write, stderr: stderr.write }), 0)
		assert.match(stdout.lines.join('\n'), /BaileysX CLI/)
		assert.equal(await runCli(['version'], { fetch, stdout: stdout.write, stderr: stderr.write }), 0)
		assert.equal(stdout.lines.at(-1), 'baileysx')
		assert.equal(await runCli(['unknown'], { fetch, stdout: stdout.write, stderr: stderr.write }), 1)
		assert.match(stderr.lines.at(-1), /unknown command/)

		const failingFetch = async () =>
			new Response(JSON.stringify({ error: 'nope' }), { status: 500 })
		assert.equal(
			await runCli(['health', '--url', 'http://gateway'], {
				fetch: failingFetch,
				stdout: stdout.write,
				stderr: stderr.write
			}),
			1
		)
		assert.match(stderr.lines.at(-1), /HTTP 500/)
	})
})
