import { randomBytes, scryptSync } from 'crypto'
import { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '../Types'
import { initAuthCreds } from './auth-utils.js'
import { aesDecryptGCM, aesEncryptGCM } from './crypto.js'
import { BufferJSON } from './generics.js'

import type DatabaseCtor from 'infinitysqlite'

type SqliteDatabase = InstanceType<typeof DatabaseCtor>

export type SqliteAuthStateOptions = (
	| {
			dbPath: string
	  }
	| {
			database: SqliteDatabase
	  }
) & {
	/**
	 * Encrypts credentials and signal keys at rest with AES-256-GCM. The key is
	 * derived with scrypt from this passphrase and a random per-database salt.
	 */
	passphrase?: string
}

export type SqliteAuthState = {
	state: AuthenticationState
	saveCreds: () => void
	close: () => void
	/** Creates a consistent backup. Encrypted databases remain encrypted. */
	backupTo: (path: string) => void
	/** Re-encrypts every credential and signal key with a new passphrase. */
	rekey: (newPassphrase: string) => void
}

async function loadInfinitySqlite(): Promise<typeof DatabaseCtor> {
	try {
		const mod: any = await import('infinitysqlite')
		return mod.default ?? mod
	} catch (err) {
		const helpful = new Error(
			'`infinitysqlite` is required for `useSqliteAuthState`. Install it as a peer dependency: `npm install infinitysqlite` (or `yarn add infinitysqlite`).'
		)

		;(helpful as any).cause = err
		throw helpful
	}
}

const CREDS_ROW_KEY = '__creds__'
const SALT_META_KEY = 'encryption_salt'
const VERSION_META_KEY = 'encryption_version'
const ENCRYPTED_PREFIX = 'enc:v1:'
const ENCRYPTION_AAD = Buffer.from('baileysx-auth-state-v1', 'utf8')

const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS creds (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS signal_keys (
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (type, id)
);
CREATE INDEX IF NOT EXISTS signal_keys_type_idx ON signal_keys(type);
CREATE TABLE IF NOT EXISTS auth_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export async function useSqliteAuthState(opts: SqliteAuthStateOptions): Promise<SqliteAuthState> {
	let db: SqliteDatabase
	if ('database' in opts) {
		db = opts.database
	} else {
		const Database = await loadInfinitySqlite()
		db = new Database(opts.dbPath)
	}

	try {
		db.pragma('journal_mode = WAL')
	db.pragma('synchronous = NORMAL')
	db.pragma('busy_timeout = 5000')
	db.exec(CREATE_SCHEMA_SQL)

	let closed = false

	const stmts = {
		credsSelect: db.prepare<{ value: string }, [string]>('SELECT value FROM creds WHERE key = ?'),
		credsUpsert: db.prepare<unknown, [string, string]>(
			'INSERT INTO creds (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
		),
		credsAll: db.prepare<{ key: string; value: string }, []>('SELECT key, value FROM creds'),
		keySelect: db.prepare<{ value: string }, [string, string]>('SELECT value FROM signal_keys WHERE type = ? AND id = ?'),
		keyUpsert: db.prepare<unknown, [string, string, string]>(
			'INSERT INTO signal_keys (type, id, value) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET value = excluded.value'
		),
		keyDelete: db.prepare<unknown, [string, string]>('DELETE FROM signal_keys WHERE type = ? AND id = ?'),
		keyListIds: db.prepare<{ id: string }, [string]>('SELECT id FROM signal_keys WHERE type = ?'),
		keyList: db.prepare<{ id: string; value: string }, [string]>('SELECT id, value FROM signal_keys WHERE type = ?'),
		keysAll: db.prepare<{ type: string; id: string; value: string }, []>(
			'SELECT type, id, value FROM signal_keys'
		),
		metaSelect: db.prepare<{ value: string }, [string]>('SELECT value FROM auth_meta WHERE key = ?'),
		metaUpsert: db.prepare<unknown, [string, string]>(
			'INSERT INTO auth_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
		),
		clearKeys: db.prepare('DELETE FROM signal_keys')
	}

	const keyBatchSelectCache = new Map<number, ReturnType<typeof db.prepare<{ id: string; value: string }, [string, ...string[]]>>>()
	const getKeyBatchSelect = (count: number) => {
		let stmt = keyBatchSelectCache.get(count)
		if (!stmt) {
			const placeholders = new Array(count).fill('?').join(',')
			stmt = db.prepare<{ id: string; value: string }, [string, ...string[]]>(
				`SELECT id, value FROM signal_keys WHERE type = ? AND id IN (${placeholders})`
			)
			keyBatchSelectCache.set(count, stmt)
		}

		return stmt
	}

	let encryptionKey: Buffer | undefined
	if (opts.passphrase !== undefined) {
		if (!opts.passphrase) {
			throw new Error('`passphrase` must not be empty')
		}

		let saltRow = stmts.metaSelect.get(SALT_META_KEY)
		let salt: Buffer
		if (saltRow) {
			salt = Buffer.from(saltRow.value, 'base64')
		} else {
			salt = randomBytes(16)
			stmts.metaUpsert.run(SALT_META_KEY, salt.toString('base64'))
			stmts.metaUpsert.run(VERSION_META_KEY, '1')
		}

		encryptionKey = scryptSync(opts.passphrase, salt, 32)
	}

	const isEncrypted = (value: string) => value.startsWith('enc:')

	const encryptWithKey = (value: string, key: Buffer | undefined): string => {
		if (!key) {
			return value
		}

		const iv = randomBytes(12)
		const ciphertext = aesEncryptGCM(Buffer.from(value, 'utf8'), key, iv, ENCRYPTION_AAD)
		return `${ENCRYPTED_PREFIX}${iv.toString('base64')}:${Buffer.from(ciphertext).toString('base64')}`
	}

	const decryptWithKey = (value: string, key: Buffer | undefined): string => {
		if (!isEncrypted(value)) {
			// Legacy plaintext databases are read as-is. If a passphrase is
			// configured, migrateEncryption() upgrades them in place below.
			return value
		}

		if (!value.startsWith(ENCRYPTED_PREFIX)) {
			throw new Error('unsupported encrypted auth-state format')
		}

		if (!key) {
			throw new Error('auth database is encrypted; provide `passphrase` to useSqliteAuthState')
		}

		const [ivBase64, ciphertextBase64] = value.slice(ENCRYPTED_PREFIX.length).split(':')
		if (!ivBase64 || !ciphertextBase64) {
			throw new Error('malformed encrypted auth-state value')
		}

		try {
			const plaintext = aesDecryptGCM(
				Buffer.from(ciphertextBase64, 'base64'),
				key,
				Buffer.from(ivBase64, 'base64'),
				ENCRYPTION_AAD
			)
			return Buffer.from(plaintext).toString('utf8')
		} catch (error) {
			const helpful = new Error('failed to decrypt auth state: wrong passphrase or corrupted database')
			;(helpful as any).cause = error
			throw helpful
		}
	}

	const encryptValue = (value: string): string => encryptWithKey(value, encryptionKey)
	const decryptValue = (value: string): string => decryptWithKey(value, encryptionKey)

	const migrateEncryption = () => {
		if (!encryptionKey) {
			return
		}

		const tx = db.transaction(() => {
			for (const row of stmts.credsAll.all()) {
				if (!isEncrypted(row.value)) {
					stmts.credsUpsert.run(row.key, encryptValue(row.value))
				}
			}

			for (const row of stmts.keysAll.all()) {
				if (!isEncrypted(row.value)) {
					stmts.keyUpsert.run(row.type, row.id, encryptValue(row.value))
				}
			}
		})
		tx()
	}

	migrateEncryption()

	const loadCreds = (): AuthenticationCreds => {
		const row = stmts.credsSelect.get(CREDS_ROW_KEY)
		if (!row) {
			return initAuthCreds()
		}

		return JSON.parse(decryptValue(row.value), BufferJSON.reviver)
	}

	const persistCreds = (creds: AuthenticationCreds) => {
		if (closed || !db.open) return
		stmts.credsUpsert.run(CREDS_ROW_KEY, encryptValue(JSON.stringify(creds, BufferJSON.replacer)))
	}

	const creds = loadCreds()

	return {
		state: {
			creds,
			keys: {
				get: async (type, ids) => {
					const data: { [_: string]: SignalDataTypeMap[typeof type] } = {}
					if (closed || !db.open || ids.length === 0) return data

					const parseRow = (id: string, rawValue: string) => {
						let value = JSON.parse(decryptValue(rawValue), BufferJSON.reviver)
						if (type === 'app-state-sync-key' && value) {
							value = proto.Message.AppStateSyncKeyData.fromObject(value)
						}

						data[id] = value
					}

					if (ids.length === 1) {
						const row = stmts.keySelect.get(type, ids[0]!)
						if (row) parseRow(ids[0]!, row.value)
						return data
					}

					const rows = getKeyBatchSelect(ids.length).all(type, ...ids)
					for (const row of rows) {
						parseRow(row.id, row.value)
					}

					return data
				},
				set: async data => {
					if (closed || !db.open) return
					const writeTx = db.transaction(() => {
						for (const category in data) {
							for (const id in data[category as keyof SignalDataTypeMap]) {
								const value = data[category as keyof SignalDataTypeMap]![id]
								if (value) {
									const stringified = JSON.stringify(value, BufferJSON.replacer)
									stmts.keyUpsert.run(category, id, encryptValue(stringified))
								} else {
									stmts.keyDelete.run(category, id)
								}
							}
						}
					})

					writeTx()
				}
			}
		},
		saveCreds: () => {
			persistCreds(creds)
		},
		backupTo: (path: string) => {
			if (closed || !db.open) {
				throw new Error('auth state is closed')
			}

			db.pragma('wal_checkpoint(TRUNCATE)')
			const escapedPath = path.replace(/'/g, "''")
			db.exec(`VACUUM INTO '${escapedPath}'`)
		},
		rekey: (newPassphrase: string) => {
			if (closed || !db.open) {
				throw new Error('auth state is closed')
			}

			if (!newPassphrase) {
				throw new Error('`newPassphrase` must not be empty')
			}

			const credsRows = stmts.credsAll.all()
			const keyRows = stmts.keysAll.all()
			const newSalt = randomBytes(16)
			const newKey = scryptSync(newPassphrase, newSalt, 32)
			const writeTx = db.transaction(() => {
				for (const row of credsRows) {
					stmts.credsUpsert.run(row.key, encryptWithKey(decryptWithKey(row.value, encryptionKey), newKey))
				}

				for (const row of keyRows) {
					stmts.keyUpsert.run(
						row.type,
						row.id,
						encryptWithKey(decryptWithKey(row.value, encryptionKey), newKey)
					)
				}

				stmts.metaUpsert.run(SALT_META_KEY, newSalt.toString('base64'))
				stmts.metaUpsert.run(VERSION_META_KEY, '1')
			})

			writeTx()
			encryptionKey = newKey
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
	} catch (error) {
		try {
			db.close()
		} catch {}
		throw error
	}
}
