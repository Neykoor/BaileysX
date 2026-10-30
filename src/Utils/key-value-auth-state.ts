import { randomBytes, scryptSync } from 'crypto'
import { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '../Types'
import { initAuthCreds } from './auth-utils.js'
import { aesDecryptGCM, aesEncryptGCM } from './crypto.js'
import { BufferJSON } from './generics.js'
import type { ILogger } from './logger'

export type AuthKeyValueEntry = {
	key: string
	value: string
}

/**
 * Minimal async key/value contract used by the Redis and Postgres auth
 * adapters. Implementations should make `set`/`delete` durable before
 * resolving.
 */
export type AuthKeyValueStorage = {
	get: (key: string) => Promise<string | null | undefined>
	set: (key: string, value: string) => Promise<void>
	delete: (key: string) => Promise<void>
	/** List every entry whose key starts with `prefix`. */
	list: (prefix: string) => Promise<AuthKeyValueEntry[]>
	getMany?: (keys: string[]) => Promise<Map<string, string>>
	setMany?: (entries: AuthKeyValueEntry[]) => Promise<void>
	deletePrefix?: (prefix: string) => Promise<void>
	/**
	 * Optional atomic replacement used by `rekey()`. When absent, rekey writes
	 * values sequentially and then updates the salt.
	 */
	replaceAll?: (entries: AuthKeyValueEntry[]) => Promise<void>
	close?: () => Promise<void>
}

export type KeyValueAuthStateOptions = {
	storage: AuthKeyValueStorage
	/** Namespace for all keys. Defaults to `baileys:auth`. */
	prefix?: string
	/** Enables AES-256-GCM encryption with a scrypt-derived key. */
	passphrase?: string
	logger?: ILogger
}

export type KeyValueAuthState = {
	state: AuthenticationState
	saveCreds: () => Promise<void>
	rekey: (newPassphrase: string) => Promise<void>
	close: () => Promise<void>
}

const CREDS_SUFFIX = 'creds'
const KEY_SUFFIX = 'key'
const SALT_SUFFIX = 'meta:salt'
const VERSION_SUFFIX = 'meta:version'
const ENCRYPTED_PREFIX = 'enc:v1:'
const AUTH_AAD = Buffer.from('baileysx-key-value-auth-v1', 'utf8')

const normalizePrefix = (prefix: string): string => {
	const normalized = prefix.replace(/:+$/, '')
	if (!normalized) {
		throw new Error('auth key-value prefix must not be empty')
	}

	return normalized
}

const isEncrypted = (value: string) => value.startsWith('enc:')

const encryptWith = (value: string, key: Buffer): string => {
	const iv = randomBytes(12)
	const ciphertext = aesEncryptGCM(Buffer.from(value, 'utf8'), key, iv, AUTH_AAD)
	return `${ENCRYPTED_PREFIX}${iv.toString('base64')}:${Buffer.from(ciphertext).toString('base64')}`
}

const decryptWith = (value: string, key: Buffer | undefined): string => {
	if (!isEncrypted(value)) {
		return value
	}

	if (!value.startsWith(ENCRYPTED_PREFIX)) {
		throw new Error('unsupported encrypted auth-state format')
	}

	if (!key) {
		throw new Error('auth state is encrypted; provide a passphrase')
	}

	const [ivBase64, ciphertextBase64] = value.slice(ENCRYPTED_PREFIX.length).split(':')
	if (!ivBase64 || !ciphertextBase64) {
		throw new Error('malformed encrypted auth-state value')
	}

	try {
		return Buffer.from(
			aesDecryptGCM(
				Buffer.from(ciphertextBase64, 'base64'),
				key,
				Buffer.from(ivBase64, 'base64'),
				AUTH_AAD
			)
		).toString('utf8')
	} catch (error) {
		const helpful = new Error('failed to decrypt auth state: wrong passphrase or corrupted data')
		;(helpful as any).cause = error
		throw helpful
	}
}

/**
 * Authentication state backed by any async key/value store. Redis and Postgres
 * adapters use this implementation so credentials, signal keys and encrypted
 * rekeying behave consistently across backends.
 */
export const makeKeyValueAuthState = async (opts: KeyValueAuthStateOptions): Promise<KeyValueAuthState> => {
	const base = normalizePrefix(opts.prefix ?? 'baileys:auth')
	const credsKey = `${base}:${CREDS_SUFFIX}`
	const keyPrefix = `${base}:${KEY_SUFFIX}:`
	const saltKey = `${base}:${SALT_SUFFIX}`
	const versionKey = `${base}:${VERSION_SUFFIX}`
	const { storage } = opts

	let encryptionKey: Buffer | undefined
	if (opts.passphrase !== undefined) {
		if (!opts.passphrase) {
			throw new Error('`passphrase` must not be empty')
		}

		const storedSalt = await storage.get(saltKey)
		const salt = storedSalt ? Buffer.from(storedSalt, 'base64') : randomBytes(16)
		if (!storedSalt) {
			await storage.set(saltKey, salt.toString('base64'))
			await storage.set(versionKey, '1')
		}

		encryptionKey = scryptSync(opts.passphrase, salt, 32)
	}

	const encryptValue = (value: string): string =>
		encryptionKey ? encryptWith(value, encryptionKey) : value
	const decryptValue = (value: string): string => decryptWith(value, encryptionKey)

	const parseCreds = (raw: string): AuthenticationCreds =>
		JSON.parse(decryptValue(raw), BufferJSON.reviver) as AuthenticationCreds

	const loadCreds = async (): Promise<AuthenticationCreds> => {
		const raw = await storage.get(credsKey)
		return raw ? parseCreds(raw) : initAuthCreds()
	}

	const creds = await loadCreds()
	let closed = false

	const saveCreds = async (): Promise<void> => {
		if (closed) {
			return
		}

		await storage.set(credsKey, encryptValue(JSON.stringify(creds, BufferJSON.replacer)))
	}

	const getMany = async (keys: string[]): Promise<Map<string, string>> => {
		if (keys.length === 0) {
			return new Map()
		}

		if (storage.getMany) {
			return storage.getMany(keys)
		}

		const entries = await Promise.all(keys.map(async key => [key, await storage.get(key)] as const))
		const result = new Map<string, string>()
		for (const [key, value] of entries) {
			if (value !== null && value !== undefined) {
				result.set(key, value)
			}
		}

		return result
	}

	const setMany = async (entries: AuthKeyValueEntry[]): Promise<void> => {
		if (entries.length === 0) {
			return
		}

		if (storage.setMany) {
			await storage.setMany(entries)
			return
		}

		for (const entry of entries) {
			await storage.set(entry.key, entry.value)
		}
	}

	const keys = {
		get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
			const data: { [id: string]: SignalDataTypeMap[T] } = {}
			if (closed || ids.length === 0) {
				return data
			}

			const values = await getMany(ids.map(id => `${keyPrefix}${type}:${id}`))
			for (const id of ids) {
				const raw = values.get(`${keyPrefix}${type}:${id}`)
				if (raw === undefined) {
					continue
				}

				let value = JSON.parse(decryptValue(raw), BufferJSON.reviver)
				if (type === 'app-state-sync-key' && value) {
					value = proto.Message.AppStateSyncKeyData.fromObject(value)
				}

				data[id] = value as SignalDataTypeMap[T]
			}

			return data
		},
		set: async (data: { [T in keyof SignalDataTypeMap]?: { [id: string]: SignalDataTypeMap[T] | null } }) => {
			if (closed) {
				return
			}

			const entries: AuthKeyValueEntry[] = []
			const deletions: string[] = []
			for (const type in data) {
				const typed = data[type as keyof SignalDataTypeMap]
				if (!typed) {
					continue
				}

				for (const id in typed) {
					const value = typed[id as keyof typeof typed]
					const key = `${keyPrefix}${type}:${id}`
					if (value === null || value === undefined) {
						deletions.push(key)
					} else {
						entries.push({
							key,
							value: encryptValue(JSON.stringify(value, BufferJSON.replacer))
						})
					}
				}
			}

			await setMany(entries)
			await Promise.all(deletions.map(key => storage.delete(key)))
		},
		clear: async () => {
			if (closed) {
				return
			}

			if (storage.deletePrefix) {
				await storage.deletePrefix(keyPrefix)
				return
			}

			const entries = await storage.list(keyPrefix)
			await Promise.all(entries.map(entry => storage.delete(entry.key)))
		}
	}

	const rekey = async (newPassphrase: string): Promise<void> => {
		if (closed) {
			throw new Error('auth state is closed')
		}

		if (!newPassphrase) {
			throw new Error('`newPassphrase` must not be empty')
		}

		const currentCreds = await storage.get(credsKey)
		const currentKeys = await storage.list(keyPrefix)
		const newSalt = randomBytes(16)
		const newKey = scryptSync(newPassphrase, newSalt, 32)
		const next: AuthKeyValueEntry[] = []

		if (currentCreds) {
			next.push({
				key: credsKey,
				value: encryptWith(decryptValue(currentCreds), newKey)
			})
		}

		for (const entry of currentKeys) {
			next.push({
				key: entry.key,
				value: encryptWith(decryptValue(entry.value), newKey)
			})
		}

		next.push({ key: saltKey, value: newSalt.toString('base64') })
		next.push({ key: versionKey, value: '1' })

		if (storage.replaceAll) {
			await storage.replaceAll(next)
		} else {
			for (const entry of next) {
				await storage.set(entry.key, entry.value)
			}
		}

		encryptionKey = newKey
	}

	return {
		state: { creds, keys },
		saveCreds,
		rekey,
		close: async () => {
			if (closed) {
				return
			}

			closed = true
			await storage.close?.()
		}
	}
}
