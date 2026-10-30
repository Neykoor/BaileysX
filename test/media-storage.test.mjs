import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
	makeLocalMediaStorage,
	makeMediaStorage,
	makeS3MediaStorage
} from '../lib/Utils/media-storage.js'

const makeS3 = () => {
	const objects = new Map()
	const client = {
		async putObject({ Key, Body }) {
			objects.set(Key, Buffer.from(Body))
		},
		async getObject({ Key }) {
			const body = objects.get(Key)
			if (!body) {
				throw Object.assign(new Error('not found'), { name: 'NotFound' })
			}
			return { Body: body }
		},
		async deleteObject({ Key }) {
			objects.delete(Key)
		},
		async headObject({ Key }) {
			if (!objects.has(Key)) {
				throw Object.assign(new Error('not found'), { name: 'NotFound' })
			}
		},
		async listObjectsV2({ Prefix }) {
			return {
				Contents: Array.from(objects.entries())
					.filter(([key]) => !Prefix || key.startsWith(Prefix))
					.map(([Key, Body]) => ({ Key, Size: Body.length, LastModified: new Date(0) }))
			}
		}
	}
	return { objects, client }
}

describe('media storage', () => {
	it('stores, lists, reads and deletes local media safely', async t => {
		const dir = await mkdtemp(join(tmpdir(), 'baileysx-media-'))
		t.after(async () => {
			await rm(dir, { recursive: true, force: true })
		})

		const storage = await makeLocalMediaStorage({ dir })
		const stored = await storage.put('images/a.jpg', Buffer.from('abc'), {
			contentType: 'image/jpeg',
			metadata: { owner: 'tenant-a' }
		})
		assert.equal(stored.size, 3)
		assert.equal(stored.contentType, 'image/jpeg')
		assert.equal((await storage.get('images/a.jpg')).toString(), 'abc')
		assert.equal(await storage.has('images/a.jpg'), true)

		const list = await storage.list('images/')
		assert.equal(list.length, 1)
		assert.equal(list[0].key, 'images/a.jpg')
		assert.equal(list[0].metadata.owner, 'tenant-a')

		assert.equal(await storage.delete('images/a.jpg'), true)
		assert.equal(await storage.get('images/a.jpg'), undefined)
		assert.equal(await storage.delete('images/a.jpg'), false)
		await assert.rejects(() => storage.put('../escape', Buffer.from('x')), /invalid media key/)
		await assert.rejects(
			() => storage.put('large.bin', Buffer.alloc(10), { maxBytes: 5 }),
			/maxBytes/
		)
	})

	it('supports an S3-compatible client with injectable methods', async () => {
		const { objects, client } = makeS3()
		const storage = makeS3MediaStorage({ client, bucket: 'bucket', prefix: 'media' })

		const stored = await storage.put('a.txt', Buffer.from('hello'), {
			contentType: 'text/plain'
		})
		assert.equal(stored.key, 'a.txt')
		assert.equal(objects.get('media/a.txt').toString(), 'hello')
		assert.equal((await storage.get('a.txt')).toString(), 'hello')
		assert.equal(await storage.has('a.txt'), true)

		const list = await storage.list()
		assert.equal(list.length, 1)
		assert.equal(list[0].key, 'a.txt')
		assert.equal((await storage.list('a')).length, 1)

		assert.equal(await storage.delete('a.txt'), true)
		assert.equal(await storage.get('a.txt'), undefined)
		assert.equal(await storage.has('a.txt'), false)
	})

	it('exposes a backend factory', async t => {
		const dir = await mkdtemp(join(tmpdir(), 'baileysx-media-factory-'))
		t.after(async () => {
			await rm(dir, { recursive: true, force: true })
		})

		const storage = await makeMediaStorage({ type: 'local', dir })
		await storage.put('x/y.bin', Buffer.from([1, 2]))
		assert.deepEqual(Array.from(await storage.get('x/y.bin')), [1, 2])
	})
})
