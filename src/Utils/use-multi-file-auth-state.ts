import { Mutex } from 'async-mutex'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '../Types'
import { initAuthCreds } from './auth-utils'
import { BufferJSON } from './generics'

const fileLocks = new Map<string, { mutex: Mutex; refs: number }>()

const withFileLock = async <T>(path: string, task: () => Promise<T>): Promise<T> => {
	let entry = fileLocks.get(path)
	if (!entry) {
		entry = { mutex: new Mutex(), refs: 0 }
		fileLocks.set(path, entry)
	}

	entry.refs++
	try {
		return await entry.mutex.runExclusive(task)
	} finally {
		if (--entry.refs === 0) {
			fileLocks.delete(path)
		}
	}
}

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException =>
	typeof error === 'object' && error !== null && 'code' in error

export const useMultiFileAuthState = async (
	folder: string
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
	const fixFileName = (file: string) => file.replace(/[/\\]/g, '__').replace(/:/g, '-')

		const writeData = async (data: any, file: string) => {
		const filePath = join(folder, fixFileName(file))
		const tempPath = `${filePath}.tmp`

		return withFileLock(filePath, async () => {
						try {
				await writeFile(tempPath, JSON.stringify(data, BufferJSON.replacer))
				await rename(tempPath, filePath)
			} catch (error) {
				await unlink(tempPath).catch(() => {})
				throw error
			}
		})
	}

	
	const readData = async (file: string, strict = false) => {
		const filePath = join(folder, fixFileName(file))

		return withFileLock(filePath, async () => {
			try {
				const data = await readFile(filePath, { encoding: 'utf-8' })
				return JSON.parse(data, BufferJSON.reviver)
			} catch (error) {
				if (isErrnoException(error) && error.code === 'ENOENT') {
					return null
				}

				if (strict) {
					throw new Error(
						`could not read auth file ${filePath}: ${(error as Error).message}. ` +
							'Refusing to create new credentials over it; fix or delete the file if you want to start over.'
					)
				}

				return null
			}
		})
	}

	const removeData = async (file: string) => {
		const filePath = join(folder, fixFileName(file))

		return withFileLock(filePath, async () => {
			try {
				await unlink(filePath)
			} catch (error) {
				if (!isErrnoException(error) || error.code !== 'ENOENT') {
					throw error
				}
			}
		})
	}

	const folderInfo = await stat(folder).catch(() => {})
	if (folderInfo) {
		if (!folderInfo.isDirectory()) {
			throw new Error(
				`found something that is not a directory at ${folder}, either delete it or specify a different location`
			)
		}
	} else {
		await mkdir(folder, { recursive: true })
	}

	const creds: AuthenticationCreds = (await readData('creds.json', true)) || initAuthCreds()

	return {
		state: {
			creds,
			keys: {
				get: async (type, ids) => {
					const data: { [_: string]: SignalDataTypeMap[typeof type] } = {}
					await Promise.all(
						ids.map(async id => {
							let value = await readData(`${type}-${id}.json`)
							if (type === 'app-state-sync-key' && value) {
								value = proto.Message.AppStateSyncKeyData.fromObject(value)
							}

							data[id] = value
						})
					)

					return data
				},
				set: async data => {
					const tasks: Promise<void>[] = []
					for (const category in data) {
						for (const id in data[category as keyof SignalDataTypeMap]) {
							const value = data[category as keyof SignalDataTypeMap]![id]
							const file = `${category}-${id}.json`
							tasks.push(value ? writeData(value, file) : removeData(file))
						}
					}

					await Promise.all(tasks)
				}
			}
		},
		saveCreds: async () => {
			return writeData(creds, 'creds.json')
		}
	}
								 }
	
