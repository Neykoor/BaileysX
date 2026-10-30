import type { ScheduledMessage, ScheduledMessageStore } from './scheduling'
import { BufferJSON } from './generics'
import type { IdempotencyStore } from './idempotency'
import {
	makeKeyValueAuthState,
	type AuthKeyValueEntry,
	type AuthKeyValueStorage,
	type KeyValueAuthState,
	type KeyValueAuthStateOptions
} from './key-value-auth-state'

export type RedisSetOptions = {
	NX?: boolean
	PX?: number
	EX?: number
}

export type RedisMultiLike = {
	set: (key: string, value: string) => unknown
	del: (...keys: string[]) => unknown
	exec: () => Promise<unknown>
}

export type RedisClientLike = {
	get: (key: string) => Promise<string | null>
	set: (key: string, value: string, options?: RedisSetOptions) => Promise<unknown>
	del: (...keys: string[]) => Promise<unknown>
	mGet?: (keys: string[]) => Promise<Array<string | null>>
	mget?: (keys: string[]) => Promise<Array<string | null>>
	keys?: (pattern: string) => Promise<string[]>
	scanIterator?: (options: { MATCH: string; COUNT?: number }) => AsyncIterable<string>
	multi?: () => RedisMultiLike
	quit?: () => Promise<unknown>
	disconnect?: () => void
}

export type RedisAuthStateOptions = Omit<KeyValueAuthStateOptions, 'storage'> & {
	client: RedisClientLike
	/** Close the Redis client when the auth state is closed. Defaults to false. */
	closeClient?: boolean
}

const escapeGlob = (value: string): string => value.replace(/[*?[\]\\]/g, '\\$&')

const chunk = <T>(items: T[], size: number): T[][] => {
	const chunks: T[][] = []
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size))
	}

	return chunks
}

const listKeys = async (client: RedisClientLike, pattern: string): Promise<string[]> => {
	if (client.scanIterator) {
		const keys: string[] = []
		for await (const key of client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
			keys.push(key)
		}

		return keys
	}

	if (client.keys) {
		return client.keys(pattern)
	}

	throw new Error('Redis client must implement scanIterator() or keys()')
}

const getMany = async (client: RedisClientLike, keys: string[]): Promise<Map<string, string>> => {
	const result = new Map<string, string>()
	if (keys.length === 0) {
		return result
	}

	const mget = client.mGet ?? client.mget
	const values = mget ? await mget.call(client, keys) : await Promise.all(keys.map(key => client.get(key)))
	for (let i = 0; i < keys.length; i++) {
		const value = values[i]
		if (value !== null && value !== undefined) {
			result.set(keys[i]!, value)
		}
	}

	return result
}

export const makeRedisAuthStorage = (
	client: RedisClientLike,
	prefix: string,
	closeClient = false
): AuthKeyValueStorage => {
	const base = prefix.replace(/:+$/, '')
	const list = async (listPrefix: string): Promise<AuthKeyValueEntry[]> => {
		const keys = await listKeys(client, `${escapeGlob(listPrefix)}*`)
		const values = await getMany(client, keys)
		return keys
			.filter(key => values.has(key))
			.map(key => ({ key, value: values.get(key)! }))
	}

	const storage: AuthKeyValueStorage = {
		get: key => client.get(key),
		set: async (key, value) => {
			await client.set(key, value)
		},
		delete: async key => {
			await client.del(key)
		},
		list,
		getMany: keys => getMany(client, keys),
		setMany: async entries => {
			if (client.multi) {
				const multi = client.multi()
				for (const entry of entries) {
					multi.set(entry.key, entry.value)
				}
				await multi.exec()
				return
			}

			for (const entry of entries) {
				await client.set(entry.key, entry.value)
			}
		},
		deletePrefix: async deletePrefix => {
			const keys = await listKeys(client, `${escapeGlob(deletePrefix)}*`)
			for (const group of chunk(keys, 100)) {
				await client.del(...group)
			}
		},
		replaceAll: async entries => {
			if (client.multi) {
				const multi = client.multi()
				for (const entry of entries) {
					multi.set(entry.key, entry.value)
				}
				await multi.exec()
				return
			}

			for (const entry of entries) {
				await client.set(entry.key, entry.value)
			}
		},
		close: async () => {
			if (!closeClient) {
				return
			}

			try {
				await client.quit?.()
			} catch {
				client.disconnect?.()
			}
		}
	}

	// Keep the base prefix available for callers that want to inspect keys.
	void base
	return storage
}

export const useRedisAuthState = async (opts: RedisAuthStateOptions): Promise<KeyValueAuthState> => {
	const prefix = opts.prefix ?? 'baileys:auth'
	return makeKeyValueAuthState({
		...opts,
		prefix,
		storage: makeRedisAuthStorage(opts.client, prefix, opts.closeClient)
	})
}

export type RedisScheduledMessageStoreOptions = {
	client: RedisClientLike
	prefix?: string
	closeClient?: boolean
}

export type RedisScheduledMessageStore = ScheduledMessageStore & {
	list: () => Promise<ScheduledMessage[]>
	close: () => Promise<void>
}

const serializeScheduled = (scheduled: ScheduledMessage): string =>
	JSON.stringify(
		{
			...scheduled,
			scheduledTime: scheduled.scheduledTime.toISOString(),
			createdAt: scheduled.createdAt.toISOString()
		},
		BufferJSON.replacer
	)

const deserializeScheduled = (raw: string): ScheduledMessage => {
	const parsed = JSON.parse(raw, BufferJSON.reviver) as ScheduledMessage & {
		scheduledTime: string | Date
		createdAt: string | Date
	}
	return {
		...parsed,
		scheduledTime: new Date(parsed.scheduledTime),
		createdAt: new Date(parsed.createdAt)
	}
}

export const makeRedisScheduledMessageStore = (
	opts: RedisScheduledMessageStoreOptions
): RedisScheduledMessageStore => {
	const prefix = `${(opts.prefix ?? 'baileys:outbox').replace(/:+$/, '')}:scheduled`
	const keyFor = (id: string) => `${prefix}:${id}`

	const list = async (): Promise<ScheduledMessage[]> => {
		const keys = await listKeys(opts.client, `${escapeGlob(prefix)}:*`)
		const values = await getMany(opts.client, keys)
		return Array.from(values.values()).map(deserializeScheduled)
	}

	const close = async () => {
		if (!opts.closeClient) {
			return
		}

		try {
			await opts.client.quit?.()
		} catch {
			opts.client.disconnect?.()
		}
	}

	return {
		loadPending: async () => (await list()).filter(scheduled => scheduled.status === 'pending'),
		save: async scheduled => {
			await opts.client.set(keyFor(scheduled.id), serializeScheduled(scheduled))
		},
		update: async scheduled => {
			await opts.client.set(keyFor(scheduled.id), serializeScheduled(scheduled))
		},
		delete: async id => {
			await opts.client.del(keyFor(id))
		},
		list,
		close
	}
}

export type RedisIdempotencyStoreOptions = {
	client: RedisClientLike
	prefix?: string
	closeClient?: boolean
}

export const makeRedisIdempotencyStore = (opts: RedisIdempotencyStoreOptions): IdempotencyStore => {
	const prefix = `${(opts.prefix ?? 'baileys:idempotency').replace(/:+$/, '')}:`
	return {
		tryAcquire: async (key, ttlMs) => {
			const result = await opts.client.set(`${prefix}${key}`, '1', {
				NX: true,
				PX: Math.max(1, ttlMs)
			})
			return result === 'OK' || result === 1 || result === true
		},
		release: async key => {
			await opts.client.del(`${prefix}${key}`)
		}
	}
}
