export type RetryOptions = {
	maxAttempts?: number
	baseDelayMs?: number
	maxDelayMs?: number
	factor?: number
	jitter?: boolean
	shouldRetry?: (error: unknown, attempt: number) => boolean
	onRetry?: (error: unknown, attempt: number, delayMs: number) => void
	sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export const retryDelay = (
	attempt: number,
	baseDelayMs = 100,
	maxDelayMs = 30_000,
	factor = 2,
	jitter = false
): number => {
	const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(factor, Math.max(0, attempt - 1)))
	if (!jitter) {
		return exponential
	}

	return Math.min(maxDelayMs, Math.round(exponential * (0.5 + Math.random() * 0.5)))
}

/**
 * Runs `fn` with exponential backoff. The first call is attempt 1.
 */
export const withRetry = async <T>(
	fn: (attempt: number) => Promise<T>,
	opts: RetryOptions = {}
): Promise<T> => {
	const maxAttempts = Math.max(1, opts.maxAttempts ?? 3)
	const baseDelayMs = opts.baseDelayMs ?? 100
	const maxDelayMs = opts.maxDelayMs ?? 30_000
	const factor = opts.factor ?? 2
	const sleep = opts.sleep ?? defaultSleep
	let attempt = 0

	while (true) {
		attempt++
		try {
			return await fn(attempt)
		} catch (error) {
			if (attempt >= maxAttempts || (opts.shouldRetry && !opts.shouldRetry(error, attempt))) {
				throw error
			}

			const delay = retryDelay(attempt, baseDelayMs, maxDelayMs, factor, opts.jitter)
			opts.onRetry?.(error, attempt, delay)
			await sleep(delay)
		}
	}
}

export type RetryTask<T> = {
	id: string
	run: () => Promise<T>
	attempts: number
	maxAttempts: number
	baseDelayMs: number
	maxDelayMs: number
	factor: number
	nextAt: number
	onSuccess?: (value: T, attempts: number) => void
	onError?: (error: unknown, attempts: number) => void
	onRetry?: (error: unknown, attempt: number, delayMs: number) => void
}

export type RetryQueueOptions = {
	now?: () => number
	sleep?: (ms: number) => Promise<void>
	checkIntervalMs?: number
}

/**
 * In-memory retry queue. Useful for transient send/media failures; durable
 * outbox workloads should use the SQLite/Redis/Postgres scheduled stores.
 */
export class RetryQueue<T = unknown> {
	private readonly tasks = new Map<string, RetryTask<T>>()
	private timer?: NodeJS.Timeout
	private processing = false
	private readonly now: () => number
	private readonly sleep: (ms: number) => Promise<void>
	private readonly checkIntervalMs: number

	constructor(opts: RetryQueueOptions = {}) {
		this.now = opts.now ?? Date.now
		this.sleep = opts.sleep ?? defaultSleep
		this.checkIntervalMs = opts.checkIntervalMs ?? 1000
	}

	add(
		id: string,
		run: () => Promise<T>,
		opts: Omit<RetryTask<T>, 'id' | 'run' | 'attempts' | 'nextAt' | 'maxAttempts' | 'baseDelayMs' | 'maxDelayMs' | 'factor'> & {
			maxAttempts?: number
			baseDelayMs?: number
			maxDelayMs?: number
			factor?: number
		} = {}
	): void {
		if (this.tasks.has(id)) {
			throw new Error(`retry task "${id}" already exists`)
		}

		this.tasks.set(id, {
			id,
			run,
			attempts: 0,
			maxAttempts: Math.max(1, opts.maxAttempts ?? 3),
			baseDelayMs: opts.baseDelayMs ?? 100,
			maxDelayMs: opts.maxDelayMs ?? 30_000,
			factor: opts.factor ?? 2,
			nextAt: this.now(),
			onSuccess: opts.onSuccess,
			onError: opts.onError,
			onRetry: opts.onRetry
		})
		this.ensureTimer()
	}

	remove(id: string): boolean {
		return this.tasks.delete(id)
	}

	get(id: string): RetryTask<T> | undefined {
		return this.tasks.get(id)
	}

	size(): number {
		return this.tasks.size
	}

	async processOnce(): Promise<number> {
		if (this.processing) {
			return 0
		}

		this.processing = true
		let processed = 0
		try {
			const current = this.now()
			for (const [id, task] of Array.from(this.tasks)) {
				if (task.nextAt > current) {
					continue
				}

				processed++
				task.attempts++
				try {
					const value = await task.run()
					this.tasks.delete(id)
					task.onSuccess?.(value, task.attempts)
				} catch (error) {
					if (task.attempts >= task.maxAttempts) {
						this.tasks.delete(id)
						task.onError?.(error, task.attempts)
					} else {
						const delay = retryDelay(
							task.attempts,
							task.baseDelayMs,
							task.maxDelayMs,
							task.factor,
							false
						)
						task.nextAt = this.now() + delay
						task.onRetry?.(error, task.attempts, delay)
					}
				}
			}
		} finally {
			this.processing = false
			if (this.tasks.size === 0) {
				this.stop()
			}
		}

		return processed
	}

	start(): void {
		if (this.timer) {
			return
		}

		this.timer = setInterval(() => {
			void this.processOnce()
		}, this.checkIntervalMs)
		this.timer.unref?.()
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = undefined
		}
	}

	private ensureTimer(): void {
		this.start()
	}

	/** Waits for the next due task. Mostly useful for tests and deterministic runners. */
	async drain(): Promise<void> {
		while (this.tasks.size > 0) {
			const next = Math.min(...Array.from(this.tasks.values()).map(task => task.nextAt))
			const wait = Math.max(0, next - this.now())
			if (wait > 0) {
				await this.sleep(wait)
			}

			await this.processOnce()
		}
	}
}
