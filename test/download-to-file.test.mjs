import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { writeStreamToFile } from '../lib/Utils/messages-media.js'

describe('writeStreamToFile', () => {
	let dir

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'baileysx-dl-'))
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it('writes the whole stream and returns the path', async () => {
		const file = join(dir, 'ok.bin')
		const result = await writeStreamToFile(Readable.from([Buffer.from('hola '), Buffer.from('mundo')]), file)
		assert.equal(result, file)
		assert.equal((await readFile(file)).toString(), 'hola mundo')
	})

	it('removes the partial file when the stream fails', async () => {
		const file = join(dir, 'broken.bin')
		const stream = new Readable({
			read() {
				this.push(Buffer.from('parcial'))
				setImmediate(() => this.destroy(new Error('conexion cortada')))
			}
		})

		await assert.rejects(() => writeStreamToFile(stream, file), /conexion cortada/)
		assert.equal(existsSync(file), false)
	})
})
