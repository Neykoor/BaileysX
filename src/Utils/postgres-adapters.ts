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

export type PostgresQueryResult = {
	rows: any[]
	rowCount?: number | null
}

export type PostgresClientLike = {
	query: (text: string, values?: unknown[]) => Promise<PostgresQueryResult>
	end?: () => Promise<void>
}

export type PostgresAuthStateOptions = Omit<KeyValueAuthStateOptions, 'storage'> & {
	client: PostgresClientLike
	/** Table used to store auth keys. Defaults to `baileys_auth`. */
	table?: string
	closeClient?: boolean
}

const TABLE_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/

const assertTable = (table: string): string => {
	if (!TABLE_PATTERN.test(table)) {
		throw new Error(`invalid SQL table name "${table}"`)
	}

	return table
}

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, match => `\\${match}`)

const placeholders = (count: number, start = 1): string =>
	Array.from({ length: count }, (_, index) => `$${start + index}`).join(',')

export const makePostgresAuthStorage = (
	client: PostgresClientLike,
	tableName = 'baileys_auth',
	closeClient = false
): AuthKeyValueStorage => {
	const table = assertTable(tableName)
	const ready = client.query(
		`CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
	)

	const list = async (prefix: string): Promise<AuthKeyValueEntry[]> => {
		await ready
		const result = await client.query(
			`SELECT key, value FROM ${table} WHERE key LIKE $1 ESCAPE '\\'`,
			[`${escapeLike(prefix)}%`]
		)
		return result.rows.map(row => ({ key: String(row.key), value: String(row.value) }))
	}

	const storage: AuthKeyValueStorage = {
		get: async key => {
			await ready
			const result = await client.query(`SELECT value FROM ${table} WHERE key = $1`, [key])
			return result.rows[0]?.value as string | undefined
		},
		set: async (key, value) => {
			await ready
			await client.query(
				`INSERT INTO ${table} (key, value) VALUES ($1, $2)
				 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
				[key, value]
			)
		},
		delete: async key => {
			await ready
			await client.query(`DELETE FROM ${table} WHERE key = $1`, [key])
		},
		list,
		getMany: async keys => {
			await ready
			if (keys.length === 0) {
				return new Map()
			}

			const result = await client.query(
				`SELECT key, value FROM ${table} WHERE key IN (${placeholders(keys.length)})`,
				keys
			)
			return new Map(result.rows.map(row => [String(row.key), String(row.value)]))
		},
		setMany: async entries => {
			await ready
			for (const entry of entries) {
				await client.query(
					`INSERT INTO ${table} (key, value) VALUES ($1, $2)
					 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
					[entry.key, entry.value]
				)
			}
		},
		deletePrefix: async prefix => {
			await ready
			await client.query(`DELETE FROM ${table} WHERE key LIKE $1 ESCAPE '\\'`, [
				`${escapeLike(prefix)}%`
			])
		},
		replaceAll: async entries => {
			await ready
			for (const entry of entries) {
				await client.query(
					`INSERT INTO ${table} (key, value) VALUES ($1, $2)
					 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
					[entry.key, entry.value]
				)
			}
		},
		close: async () => {
			if (closeClient) {
				await client.end?.()
			}
		}
	}

	return storage
}

export const usePostgresAuthState = async (opts: PostgresAuthStateOptions): Promise<KeyValueAuthState> => {
	return makeKeyValueAuthState({
		...opts,
		storage: makePostgresAuthStorage(opts.client, opts.table, opts.closeClient)
	})
}

export type PostgresScheduledMessageStoreOptions = {
	client: PostgresClientLike
	table?: string
	closeClient?: boolean
}

export type PostgresScheduledMessageStore = ScheduledMessageStore & {
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

export const makePostgresScheduledMessageStore = (
	opts: PostgresScheduledMessageStoreOptions
): PostgresScheduledMessageStore => {
	const table = assertTable(opts.table ?? 'baileys_scheduled_messages')
	const ready = (async () => {
		await opts.client.query(
			`CREATE TABLE IF NOT EXISTS ${table} (
				id TEXT PRIMARY KEY,
				status TEXT NOT NULL,
				value TEXT NOT NULL
			)`
		)
		await opts.client.query(
			`CREATE INDEX IF NOT EXISTS ${table}_status_idx ON ${table} (status)`
		)
	})()

	const list = async (): Promise<ScheduledMessage[]> => {
		await ready
		const result = await opts.client.query(`SELECT value FROM ${table}`)
		return result.rows.map(row => deserializeScheduled(String(row.value)))
	}

	const close = async () => {
		if (opts.closeClient) {
			await opts.client.end?.()
		}
	}

	const upsert = async (scheduled: ScheduledMessage) => {
		await ready
		await opts.client.query(
			`INSERT INTO ${table} (id, status, value) VALUES ($1, $2, $3)
			 ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, value = EXCLUDED.value`,
			[scheduled.id, scheduled.status, serializeScheduled(scheduled)]
		)
	}

	return {
		loadPending: async () => {
			await ready
			const result = await opts.client.query(
				`SELECT value FROM ${table} WHERE status = 'pending'`
			)
			return result.rows.map(row => deserializeScheduled(String(row.value)))
		},
		save: upsert,
		update: upsert,
		delete: async id => {
			await ready
			await opts.client.query(`DELETE FROM ${table} WHERE id = $1`, [id])
		},
		list,
		close
	}
}

export type PostgresIdempotencyStoreOptions = {
	client: PostgresClientLike
	table?: string
	now?: () => number
}

export const makePostgresIdempotencyStore = (
	opts: PostgresIdempotencyStoreOptions
): IdempotencyStore => {
	const table = assertTable(opts.table ?? 'baileys_idempotency')
	const now = opts.now ?? Date.now
	const ready = (async () => {
		await opts.client.query(
			`CREATE TABLE IF NOT EXISTS ${table} (
				key TEXT PRIMARY KEY,
				expires_at BIGINT NOT NULL
			)`
		)
	})()

	return {
		tryAcquire: async (key, ttlMs) => {
			await ready
			const current = now()
			await opts.client.query(
				`DELETE FROM ${table} WHERE key = $1 AND expires_at <= $2`,
				[key, current]
			)
			const result = await opts.client.query(
				`INSERT INTO ${table} (key, expires_at) VALUES ($1, $2)
				 ON CONFLICT (key) DO NOTHING
				 RETURNING key`,
				[key, current + Math.max(1, ttlMs)]
			)
			return result.rows.length > 0
		},
		release: async key => {
			await ready
			await opts.client.query(`DELETE FROM ${table} WHERE key = $1`, [key])
		}
	}
}
