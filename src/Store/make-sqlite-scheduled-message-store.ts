import type DatabaseCtor from 'infinitysqlite'
import type { AnyMessageContent, MiscMessageGenerationOptions } from '../Types'
import { BufferJSON } from '../Utils/generics.js'
import type { ScheduledMessage, ScheduledMessageStatus, ScheduledMessageStore } from '../Utils/scheduling.js'

export type SqliteScheduledMessageStoreDatabase = InstanceType<typeof DatabaseCtor>

export type SqliteScheduledMessageStoreOptions =
	| {
			dbPath: string
	  }
	| {
			database: SqliteScheduledMessageStoreDatabase
	  }

const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id TEXT PRIMARY KEY,
  jid TEXT NOT NULL,
  content TEXT NOT NULL,
  options TEXT,
  scheduled_time INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  message_id TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS scheduled_messages_status_time_idx
  ON scheduled_messages(status, scheduled_time);
`

async function loadInfinitySqlite(): Promise<typeof DatabaseCtor> {
	try {
		const mod: any = await import('infinitysqlite')
		return mod.default ?? mod
	} catch (err) {
		const helpful = new Error(
			'`infinitysqlite` is required for `makeSqliteScheduledMessageStore`. Install it as a peer dependency: `npm install infinitysqlite`'
		)
		;(helpful as any).cause = err
		throw helpful
	}
}

type ScheduledMessageRow = {
	id: string
	jid: string
	content: string
	options: string | null
	scheduled_time: number
	created_at: number
	status: ScheduledMessageStatus
	message_id: string | null
	error: string | null
}

const toJson = (value: unknown) => JSON.stringify(value, BufferJSON.replacer)
const fromJson = <T>(value: string): T => JSON.parse(value, BufferJSON.reviver)

const rowToScheduledMessage = (row: ScheduledMessageRow): ScheduledMessage => ({
	id: row.id,
	jid: row.jid,
	content: fromJson<AnyMessageContent>(row.content),
	options: row.options ? fromJson<MiscMessageGenerationOptions>(row.options) : undefined,
	scheduledTime: new Date(row.scheduled_time),
	createdAt: new Date(row.created_at),
	status: row.status,
	messageId: row.message_id ?? undefined,
	error: row.error ?? undefined
})

export async function makeSqliteScheduledMessageStore(
	opts: SqliteScheduledMessageStoreOptions
): Promise<ScheduledMessageStore & {
	db: SqliteScheduledMessageStoreDatabase
	get: (id: string) => ScheduledMessage | undefined
	list: () => ScheduledMessage[]
	count: () => number
	clear: () => void
	close: () => void
}> {
	let db: SqliteScheduledMessageStoreDatabase
	if ('database' in opts) {
		db = opts.database
	} else {
		const Database = await loadInfinitySqlite()
		db = new Database(opts.dbPath)
	}

	db.pragma('journal_mode = WAL')
	db.pragma('synchronous = NORMAL')
	db.exec(CREATE_SCHEMA_SQL)

	let closed = false

	const stmts = {
		upsert: db.prepare<
			unknown,
			[string, string, string, string | null, number, number, ScheduledMessageStatus, string | null, string | null]
		>(
			`INSERT INTO scheduled_messages
			 (id, jid, content, options, scheduled_time, created_at, status, message_id, error)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   jid = excluded.jid,
			   content = excluded.content,
			   options = excluded.options,
			   scheduled_time = excluded.scheduled_time,
			   created_at = excluded.created_at,
			   status = excluded.status,
			   message_id = excluded.message_id,
			   error = excluded.error`
		),
		get: db.prepare<ScheduledMessageRow, [string]>('SELECT * FROM scheduled_messages WHERE id = ?'),
		list: db.prepare<ScheduledMessageRow, []>('SELECT * FROM scheduled_messages ORDER BY scheduled_time ASC, created_at ASC'),
		pending: db.prepare<ScheduledMessageRow, []>(
			"SELECT * FROM scheduled_messages WHERE status = 'pending' ORDER BY scheduled_time ASC, created_at ASC"
		),
		delete: db.prepare<unknown, [string]>('DELETE FROM scheduled_messages WHERE id = ?'),
		clear: db.prepare<unknown, []>('DELETE FROM scheduled_messages'),
		count: db.prepare<{ count: number }, []>('SELECT COUNT(*) AS count FROM scheduled_messages')
	}

	const assertOpen = () => {
		if (closed || !db.open) {
			throw new Error('scheduled message store is closed')
		}
	}

	const persist = (scheduled: ScheduledMessage) => {
		assertOpen()
		stmts.upsert.run(
			scheduled.id,
			scheduled.jid,
			toJson(scheduled.content),
			scheduled.options ? toJson(scheduled.options) : null,
			scheduled.scheduledTime.getTime(),
			scheduled.createdAt.getTime(),
			scheduled.status,
			scheduled.messageId ?? null,
			scheduled.error ?? null
		)
	}

	return {
		db,
		loadPending: async () => {
			assertOpen()
			return stmts.pending.all().map(rowToScheduledMessage)
		},
		save: async scheduled => {
			persist(scheduled)
		},
		update: async scheduled => {
			persist(scheduled)
		},
		delete: async id => {
			assertOpen()
			stmts.delete.run(id)
		},
		get: (id: string) => {
			assertOpen()
			const row = stmts.get.get(id)
			return row ? rowToScheduledMessage(row) : undefined
		},
		list: () => {
			assertOpen()
			return stmts.list.all().map(rowToScheduledMessage)
		},
		count: () => {
			assertOpen()
			return stmts.count.get()?.count ?? 0
		},
		clear: () => {
			assertOpen()
			stmts.clear.run()
		},
		close: () => {
			if (closed) {
				return
			}

			closed = true
			try {
				db.pragma('wal_checkpoint(PASSIVE)')
			} catch {}
			try {
				db.close()
			} catch {}
		}
	}
}

export type SqliteScheduledMessageStore = Awaited<ReturnType<typeof makeSqliteScheduledMessageStore>>
