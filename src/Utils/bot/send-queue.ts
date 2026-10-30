export type SendTask = {
	id: string
	jid: string
	content: any
	options?: any
	attempts: number
	maxAttempts: number
	nextAt: number
	resolve: (v: any) => void
	reject: (e: any) => void
}

export type SendQueueOptions = {
	concurrency?: number
	minDelayMs?: number
	maxDelayMs?: number
	retryOnError?: boolean
	logger?: any
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

export const makeSendQueue = (sock: any, opts: SendQueueOptions = {}) => {
	const concurrency = opts.concurrency ?? 2
	const minDelayMs = opts.minDelayMs ?? 250
	const maxDelayMs = opts.maxDelayMs ?? 5000
	const retryOnError = opts.retryOnError ?? true
	const log = opts.logger

	const queue: SendTask[] = []
	const active = new Set<string>()
	let running = 0
	let stopped = false

	const genId = () => Math.random().toString(36).slice(2) + Date.now().toString(36)

	const enqueue = (jid: string, content: any, options?: any, maxAttempts = 3): Promise<any> => {
		return new Promise((resolve, reject) => {
			queue.push({
				id: genId(),
				jid,
				content,
				options,
				attempts: 0,
				maxAttempts,
				nextAt: Date.now(),
				resolve,
				reject
			})
			void tick()
		})
	}

	const tick = async () => {
		if (stopped) return
		const now = Date.now()
		while (running < concurrency && queue.length) {
			const idx = queue.findIndex(t => t.nextAt <= now)
			if (idx === -1) break
			const removed = queue.splice(idx, 1)
			const task = removed[0]
			if (!task || active.has(task.id)) continue
			active.add(task.id)
			running++
			void runTask(task)
		}
		if (queue.some(t => t.nextAt > now)) {
			const next = queue.reduce((a, b) => (a.nextAt < b.nextAt ? a : b)).nextAt
			setTimeout(tick, Math.max(50, next - now)).unref?.()
		}
	}

	const runTask = async (task: SendTask) => {
		try {
			task.attempts++
			const res = await sock.sendMessage(task.jid, task.content, task.options)
			active.delete(task.id)
			running--
			task.resolve(res)
			await delay(minDelayMs)
			void tick()
		} catch (err) {
			active.delete(task.id)
			running--
			if (retryOnError && task.attempts < task.maxAttempts) {
				const backoff = Math.min(maxDelayMs, minDelayMs * 2 ** (task.attempts - 1))
				const jitter = backoff * 0.2 * (Math.random() * 2 - 1)
				task.nextAt = Date.now() + Math.max(minDelayMs, Math.round(backoff + jitter))
				queue.push(task)
				log?.warn?.({ err, jid: task.jid, attempt: task.attempts }, 'send failed, retrying')
			} else {
				log?.error?.({ err, jid: task.jid }, 'send failed, giving up')
				task.reject(err)
			}
			void tick()
		}
	}

	const stop = () => {
		stopped = true
	}

	return { enqueue, stop, size: () => queue.length + active.size }
}

export type SendQueue = ReturnType<typeof makeSendQueue>
