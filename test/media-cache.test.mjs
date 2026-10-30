import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { makeMediaCache } from '../lib/Utils/media-cache.js'

const mediaMessage = (sha, id = 'm1') => ({
	key: { remoteJid: '123@s.whatsapp.net', fromMe: false, id },
	message: { imageMessage: { fileSha256: Buffer.from(sha), mimetype: 'image/jpeg' } },
	messageTimestamp: 1
})

describe('makeMediaCache', () => {
	it('deduplicates concurrent downloads and serves cache hits', async () => {
		let calls = 0
		const cache = makeMediaCache({
			downloadMedia: async () => {
				calls++
				await new Promise(resolve => setTimeout(resolve, 5))
				return Buffer.from('media')
			}
		})

		const message = mediaMessage('same')
		const [first, second] = await Promise.all([cache.download(message, {}), cache.download(message, {})])

		assert.equal(calls, 1)
		assert.equal(first.toString(), 'media')
		assert.equal(second.toString(), 'media')
		assert.equal(cache.has(message), true)
		assert.equal(cache.size(), 1)

		const third = await cache.download(message, {})
		assert.equal(calls, 1)
		assert.equal(third.toString(), 'media')
	})

	it('does not reuse entries for different media hashes', async () => {
		let calls = 0
		const cache = makeMediaCache({
			downloadMedia: async () => {
				calls++
				return Buffer.from(`media-${calls}`)
			}
		})

		await cache.download(mediaMessage('one'), {})
		await cache.download(mediaMessage('two'), {})
		assert.equal(calls, 2)
		assert.equal(cache.size(), 2)
	})

	it('bypasses the cache when the message has no media hash', async () => {
		let calls = 0
		const cache = makeMediaCache({
			downloadMedia: async () => {
				calls++
				return Buffer.from('raw')
			}
		})

		const message = {
			key: { remoteJid: '123@s.whatsapp.net', id: 'm1' },
			message: { conversation: 'not media' }
		}

		await cache.download(message, {})
		await cache.download(message, {})
		assert.equal(calls, 2)
		assert.equal(cache.has(message), false)
	})

	it('clears cached bytes and in-flight state', async () => {
		const cache = makeMediaCache({
			downloadMedia: async () => Buffer.from('media')
		})
		const message = mediaMessage('clear')
		await cache.download(message, {})
		assert.equal(cache.has(message), true)
		cache.clear()
		assert.equal(cache.has(message), false)
		assert.equal(cache.size(), 0)
	})
})
