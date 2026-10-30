import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { ILogger } from './logger'

export type MediaStoragePutOptions = {
	contentType?: string
	metadata?: Record<string, string>
	maxBytes?: number
}

export type StoredMedia = {
	key: string
	size: number
	contentType?: string
	metadata?: Record<string, string>
	createdAt: number
}

export interface MediaStorage {
	put: (key: string, data: Uint8Array, options?: MediaStoragePutOptions) => Promise<StoredMedia>
	get: (key: string) => Promise<Buffer | undefined>
	delete: (key: string) => Promise<boolean>
	has: (key: string) => Promise<boolean>
	list: (prefix?: string) => Promise<StoredMedia[]>
	close?: () => Promise<void>
}

export type LocalMediaStorageOptions = {
	dir: string
	logger?: ILogger
}

export type S3ObjectBody =
	| Uint8Array
	| {
			transformToByteArray?: () => Promise<Uint8Array>
	  }

export type S3ClientLike = {
	putObject: (input: {
		Bucket: string
		Key: string
		Body: Uint8Array
		ContentType?: string
		Metadata?: Record<string, string>
	}) => Promise<unknown>
	getObject: (input: { Bucket: string; Key: string }) => Promise<{
		Body?: S3ObjectBody
		ContentType?: string
		Metadata?: Record<string, string>
	}>
	deleteObject: (input: { Bucket: string; Key: string }) => Promise<unknown>
	headObject: (input: { Bucket: string; Key: string }) => Promise<unknown>
	listObjectsV2?: (input: { Bucket: string; Prefix?: string }) => Promise<{
		Contents?: Array<{ Key?: string; Size?: number; LastModified?: Date }>
	}>
}

export type S3MediaStorageOptions = {
	client: S3ClientLike
	bucket: string
	prefix?: string
}

const normalizeKey = (key: string): string => {
	if (!key || key.includes('\0')) {
		throw new Error('media key must not be empty')
	}

	const normalized = key.replace(/\\/g, '/')
	if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
		throw new Error(`invalid media key "${key}"`)
	}

	const parts = normalized.split('/')
	if (parts.some(part => !part || part === '.' || part === '..')) {
		throw new Error(`invalid media key "${key}"`)
	}

	return parts.join('/')
}

const isNotFound = (error: unknown): boolean => {
	if (typeof error !== 'object' || error === null) {
		return false
	}

	const name = (error as { name?: unknown }).name
	const code = (error as { code?: unknown }).code
	return name === 'NoSuchKey' || name === 'NotFound' || code === 'ENOENT' || code === 'NoSuchKey'
}

const bodyToBuffer = async (body: S3ObjectBody | undefined): Promise<Buffer | undefined> => {
	if (!body) {
		return undefined
	}

	if (Buffer.isBuffer(body)) {
		return body
	}

	if (body instanceof Uint8Array) {
		return Buffer.from(body)
	}

	if (body.transformToByteArray) {
		return Buffer.from(await body.transformToByteArray())
	}

	throw new Error('unsupported S3 response body')
}

export const makeLocalMediaStorage = async (
	opts: LocalMediaStorageOptions
): Promise<MediaStorage> => {
	const root = resolve(opts.dir)
	await mkdir(root, { recursive: true })

	const pathFor = (key: string): { key: string; path: string; metaPath: string } => {
		const normalized = normalizeKey(key)
		const path = resolve(root, normalized)
		if (path !== root && !path.startsWith(`${root}${sep}`)) {
			throw new Error(`media key escapes the storage directory: "${key}"`)
		}

		return { key: normalized, path, metaPath: `${path}.meta.json` }
	}

	const readMetadata = async (metaPath: string): Promise<Partial<StoredMedia>> => {
		try {
			return JSON.parse(await readFile(metaPath, 'utf8')) as Partial<StoredMedia>
		} catch {
			return {}
		}
	}

	const listRecursive = async (dir: string, prefix = ''): Promise<StoredMedia[]> => {
		const entries = await readdir(dir, { withFileTypes: true })
		const result: StoredMedia[] = []
		for (const entry of entries) {
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name
			if (entry.isDirectory()) {
				result.push(...(await listRecursive(join(dir, entry.name), relative)))
			} else if (!entry.name.endsWith('.meta.json')) {
				const path = join(dir, entry.name)
				const info = await stat(path)
				const meta = await readMetadata(`${path}.meta.json`)
				result.push({
					key: relative,
					size: info.size,
					contentType: meta.contentType,
					metadata: meta.metadata,
					createdAt: meta.createdAt ?? info.birthtimeMs
				})
			}
		}

		return result
	}

	return {
		put: async (key, data, options = {}) => {
			const target = pathFor(key)
			const buffer = Buffer.from(data)
			if (options.maxBytes !== undefined && buffer.length > options.maxBytes) {
				throw new Error(`media object exceeds maxBytes (${buffer.length} > ${options.maxBytes})`)
			}

			await mkdir(dirname(target.path), { recursive: true })
			const temp = `${target.path}.tmp-${randomBytes(6).toString('hex')}`
			await writeFile(temp, buffer)
			await rename(temp, target.path)
			const stored: StoredMedia = {
				key: target.key,
				size: buffer.length,
				contentType: options.contentType,
				metadata: options.metadata,
				createdAt: Date.now()
			}
			await writeFile(target.metaPath, JSON.stringify(stored), 'utf8')
			return stored
		},
		get: async key => {
			const target = pathFor(key)
			try {
				return await readFile(target.path)
			} catch (error) {
				if (isNotFound(error)) {
					return undefined
				}

				throw error
			}
		},
		delete: async key => {
			const target = pathFor(key)
			let deleted = false
			try {
				await unlink(target.path)
				deleted = true
			} catch (error) {
				if (!isNotFound(error)) {
					throw error
				}
			}

			try {
				await unlink(target.metaPath)
			} catch {}

			return deleted
		},
		has: async key => {
			try {
				await stat(pathFor(key).path)
				return true
			} catch (error) {
				if (isNotFound(error)) {
					return false
				}

				throw error
			}
		},
		list: async prefix => {
			const entries = await listRecursive(root)
			return prefix ? entries.filter(entry => entry.key.startsWith(prefix)) : entries
		},
		close: async () => undefined
	}
}

const s3KeyFor = (prefix: string, key: string): string => {
	const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, '')
	return normalizedPrefix ? `${normalizedPrefix}/${normalizeKey(key)}` : normalizeKey(key)
}

export const makeS3MediaStorage = (opts: S3MediaStorageOptions): MediaStorage => {
	const prefix = opts.prefix ?? ''

	return {
		put: async (key, data, options = {}) => {
			const buffer = Buffer.from(data)
			if (options.maxBytes !== undefined && buffer.length > options.maxBytes) {
				throw new Error(`media object exceeds maxBytes (${buffer.length} > ${options.maxBytes})`)
			}

			const stored: StoredMedia = {
				key: normalizeKey(key),
				size: buffer.length,
				contentType: options.contentType,
				metadata: options.metadata,
				createdAt: Date.now()
			}
			await opts.client.putObject({
				Bucket: opts.bucket,
				Key: s3KeyFor(prefix, key),
				Body: buffer,
				ContentType: options.contentType,
				Metadata: options.metadata
			})
			return stored
		},
		get: async key => {
			try {
				const result = await opts.client.getObject({
					Bucket: opts.bucket,
					Key: s3KeyFor(prefix, key)
				})
				return await bodyToBuffer(result.Body)
			} catch (error) {
				if (isNotFound(error)) {
					return undefined
				}

				throw error
			}
		},
		delete: async key => {
			try {
				await opts.client.deleteObject({
					Bucket: opts.bucket,
					Key: s3KeyFor(prefix, key)
				})
				return true
			} catch (error) {
				if (isNotFound(error)) {
					return false
				}

				throw error
			}
		},
		has: async key => {
			try {
				await opts.client.headObject({
					Bucket: opts.bucket,
					Key: s3KeyFor(prefix, key)
				})
				return true
			} catch (error) {
				if (isNotFound(error)) {
					return false
				}

				throw error
			}
		},
		list: async listPrefix => {
			if (!opts.client.listObjectsV2) {
				return []
			}

			const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, '')
			const requestedPrefix = listPrefix ? normalizeKey(listPrefix) : ''
			const objectPrefix = normalizedPrefix
				? requestedPrefix
					? `${normalizedPrefix}/${requestedPrefix}`
					: `${normalizedPrefix}/`
				: requestedPrefix
			const result = await opts.client.listObjectsV2({
				Bucket: opts.bucket,
				Prefix: objectPrefix || undefined
			})
			return (result.Contents ?? [])
				.filter(item => item.Key)
				.map(item => ({
					key: item.Key!.slice(normalizedPrefix ? `${normalizedPrefix}/`.length : 0),
					size: item.Size ?? 0,
					createdAt: item.LastModified?.getTime() ?? 0
				}))
		},
		close: async () => undefined
	}
}

export type MediaStorageConfig =
	| ({ type: 'local' } & LocalMediaStorageOptions)
	| ({ type: 's3' } & S3MediaStorageOptions)

export const makeMediaStorage = async (config: MediaStorageConfig): Promise<MediaStorage> => {
	if (config.type === 'local') {
		return makeLocalMediaStorage(config)
	}

	return makeS3MediaStorage(config)
}
