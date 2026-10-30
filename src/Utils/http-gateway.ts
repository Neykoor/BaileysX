import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { ILogger } from './logger'
import { createPrometheusExporter, type PrometheusExporter } from './prometheus'

export type GatewaySocket = {
	getHealth?: () => unknown
	getMetrics?: () => Record<string, unknown>
	sendMessage?: (jid: string, content: unknown, options?: unknown) => Promise<unknown>
}

export type WebhookRequest = {
	body: unknown
	rawBody: string
	headers: IncomingHttpHeaders
	query: URLSearchParams
}

export type HttpGatewayOptions = {
	sock: GatewaySocket
	port?: number
	host?: string
	/** When set, API routes require `Authorization: Bearer <token>` or `x-api-key`. */
	token?: string
	webhookPath?: string
	/** Serve a small HTML dashboard at `/`. Defaults to true. */
	dashboard?: boolean
	/** Expose Prometheus text at `/metrics`. Defaults to true. */
	prometheus?: boolean
	maxBodyBytes?: number
	onWebhook?: (request: WebhookRequest) => unknown | Promise<unknown>
	logger?: ILogger
}

export type HttpGateway = {
	server: Server
	start: () => Promise<{ port: number; url: string }>
	close: () => Promise<void>
	address: () => string | undefined
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>BaileysX Gateway</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;background:#0b1020;color:#e8ecf8}
main{max-width:980px;margin:0 auto;padding:32px 20px}
h1{margin:0 0 8px;font-size:28px}
p{color:#9aa8c7}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin-top:24px}
.card{background:#151d36;border:1px solid #263254;border-radius:14px;padding:18px}
.card h2{font-size:14px;color:#9aa8c7;margin:0 0 12px;text-transform:uppercase;letter-spacing:.08em}
pre{white-space:pre-wrap;word-break:break-word;margin:0;font-size:12px;color:#c9d4ef}
input,button{background:#0f1730;color:#e8ecf8;border:1px solid #33436d;border-radius:8px;padding:9px 12px}
button{cursor:pointer}
.row{display:flex;gap:8px;margin-top:20px;flex-wrap:wrap}
</style>
</head>
<body>
<main>
<h1>BaileysX Gateway</h1>
<p>Health and metrics for the running WhatsApp socket.</p>
<div class="row">
<input id="token" placeholder="API token (optional)" />
<button id="refresh">Refresh</button>
</div>
<div class="grid">
<section class="card"><h2>Health</h2><pre id="health">loading...</pre></section>
<section class="card"><h2>Metrics</h2><pre id="metrics">loading...</pre></section>
</div>
</main>
<script>
const token = document.getElementById('token')
const headers = () => token.value ? { authorization: 'Bearer ' + token.value } : {}
async function refresh(){
  try {
    const h = await fetch('/health', { headers: headers() })
    document.getElementById('health').textContent = JSON.stringify(await h.json(), null, 2)
  } catch (error) { document.getElementById('health').textContent = String(error) }
  try {
    const m = await fetch('/metrics', { headers: headers() })
    document.getElementById('metrics').textContent = await m.text()
  } catch (error) { document.getElementById('metrics').textContent = String(error) }
}
document.getElementById('refresh').addEventListener('click', refresh)
refresh()
</script>
</body>
</html>`

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
	const payload = JSON.stringify(body)
	res.statusCode = status
	res.setHeader('content-type', 'application/json; charset=utf-8')
	res.setHeader('content-length', Buffer.byteLength(payload))
	res.end(payload)
}

const sendText = (res: ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8') => {
	res.statusCode = status
	res.setHeader('content-type', contentType)
	res.setHeader('content-length', Buffer.byteLength(body))
	res.end(body)
}

const readBody = (req: IncomingMessage, maxBytes: number): Promise<string> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		let size = 0
		req.on('data', chunk => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
			size += buffer.length
			if (size > maxBytes) {
				reject(Object.assign(new Error('request body too large'), { statusCode: 413 }))
				req.destroy()
				return
			}

			chunks.push(buffer)
		})
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
		req.on('error', reject)
	})

const parseJson = (raw: string): unknown => {
	if (!raw.trim()) {
		return undefined
	}

	return JSON.parse(raw)
}

const getHeader = (headers: IncomingHttpHeaders, name: string): string | undefined => {
	const value = headers[name.toLowerCase()]
	return Array.isArray(value) ? value[0] : value
}

const hasValidToken = (req: IncomingMessage, token?: string): boolean => {
	if (!token) {
		return true
	}

	const authorization = getHeader(req.headers, 'authorization')
	if (authorization?.startsWith('Bearer ') && authorization.slice(7) === token) {
		return true
	}

	return getHeader(req.headers, 'x-api-key') === token
}

/**
 * Dependency-free HTTP gateway for health checks, Prometheus scraping,
 * webhook ingestion and optional outbound sends.
 */
export const createHttpGateway = (opts: HttpGatewayOptions): HttpGateway => {
	const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
	const webhookPath = opts.webhookPath ?? '/webhook'
	const exporter: PrometheusExporter | undefined =
		opts.prometheus === false
			? undefined
			: createPrometheusExporter({
					sock: {
						getMetrics: () => opts.sock.getMetrics?.() ?? {}
					}
				})

	const server = createServer((req, res) => {
		void handle(req, res)
	})

	const handle = async (req: IncomingMessage, res: ServerResponse) => {
		res.setHeader('access-control-allow-origin', '*')
		res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
		res.setHeader('access-control-allow-headers', 'content-type,authorization,x-api-key')

		if (req.method === 'OPTIONS') {
			res.statusCode = 204
			res.end()
			return
		}

		const url = new URL(req.url ?? '/', 'http://localhost')
		const path = url.pathname
		const isPublicDashboard = path === '/' && opts.dashboard !== false

		if (!isPublicDashboard && !hasValidToken(req, opts.token)) {
			sendJson(res, 401, { error: 'unauthorized' })
			return
		}

		try {
			if (req.method === 'GET' && path === '/') {
				if (opts.dashboard === false) {
					sendJson(res, 404, { error: 'not found' })
					return
				}

				sendText(res, 200, dashboardHtml, 'text/html; charset=utf-8')
				return
			}

			if (req.method === 'GET' && path === '/health') {
				sendJson(res, 200, opts.sock.getHealth?.() ?? { status: 'unknown' })
				return
			}

			if (req.method === 'GET' && path === '/metrics') {
				if (exporter) {
					sendText(res, 200, exporter.render(), exporter.contentType)
				} else {
					sendJson(res, 200, opts.sock.getMetrics?.() ?? {})
				}
				return
			}

			if (req.method === 'POST' && path === webhookPath) {
				if (!opts.onWebhook) {
					sendJson(res, 501, { error: 'webhook handler is not configured' })
					return
				}

				const rawBody = await readBody(req, maxBodyBytes)
				const body = parseJson(rawBody)
				const result = await opts.onWebhook({
					body,
					rawBody,
					headers: req.headers,
					query: url.searchParams
				})
				sendJson(res, 200, { ok: true, result })
				return
			}

			if (req.method === 'POST' && path === '/send') {
				if (!opts.sock.sendMessage) {
					sendJson(res, 501, { error: 'sendMessage is not available on this socket' })
					return
				}

				const rawBody = await readBody(req, maxBodyBytes)
				const body = parseJson(rawBody) as
					| { jid?: unknown; content?: unknown; options?: unknown }
					| undefined
				if (!body || typeof body.jid !== 'string' || body.content === undefined) {
					sendJson(res, 400, { error: 'expected JSON body with jid and content' })
					return
				}

				const message = await opts.sock.sendMessage(body.jid, body.content, body.options)
				sendJson(res, 200, { ok: true, message })
				return
			}

			sendJson(res, 404, { error: 'not found' })
		} catch (error) {
			const invalidJson = error instanceof SyntaxError
			const statusCode = invalidJson
				? 400
				: typeof error === 'object' && error !== null && 'statusCode' in error
					? Number((error as { statusCode?: unknown }).statusCode) || 500
					: 500
			opts.logger?.error({ error, path }, 'gateway request failed')
			if (!res.headersSent) {
				sendJson(res, statusCode, {
					error: invalidJson
						? 'invalid JSON body'
						: statusCode === 413
							? 'request body too large'
							: 'internal server error'
				})
			} else {
				res.end()
			}
		}
	}

	let listening = false
	let boundPort: number | undefined

	const start = async (): Promise<{ port: number; url: string }> => {
		if (listening) {
			return { port: boundPort!, url: buildUrl(boundPort!) }
		}

		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				server.off('listening', onListening)
				reject(error)
			}
			const onListening = () => {
				server.off('error', onError)
				resolve()
			}
			server.once('error', onError)
			server.once('listening', onListening)
			server.listen(opts.port ?? 3000, opts.host ?? '127.0.0.1')
		})

		listening = true
		const address = server.address()
		boundPort = typeof address === 'object' && address ? address.port : (opts.port ?? 3000)
		return { port: boundPort, url: buildUrl(boundPort) }
	}

	const buildUrl = (port: number) => {
		const host = opts.host && opts.host !== '0.0.0.0' && opts.host !== '::' ? opts.host : '127.0.0.1'
		return `http://${host}:${port}`
	}

	const close = async (): Promise<void> => {
		if (!listening) {
			return
		}

		await new Promise<void>((resolve, reject) => {
			server.closeAllConnections?.()
			server.close(error => {
				if (error) {
					reject(error)
				} else {
					resolve()
				}
			})
		})
		listening = false
	}

	const address = () => {
		const value = server.address()
		if (!value) {
			return undefined
		}

		return typeof value === 'string' ? value : `http://${value.address}:${value.port}`
	}

	return { server, start, close, address }
}
