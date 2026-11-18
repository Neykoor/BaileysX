import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hasValidAlbumMedia, isViewOnceMessage, markViewOnce } from '../lib/Utils/message-flags.js'

describe('hasValidAlbumMedia', () => {
	it('accepts images and videos only', () => {
		assert.equal(hasValidAlbumMedia({ imageMessage: {} }), true)
		assert.equal(hasValidAlbumMedia({ videoMessage: {} }), true)
		assert.equal(hasValidAlbumMedia({ documentMessage: {} }), false)
		assert.equal(hasValidAlbumMedia({ conversation: 'hola' }), false)
	})
})

describe('markViewOnce', () => {
	it('flags image, video and audio messages', () => {
		for (const type of ['imageMessage', 'videoMessage', 'audioMessage']) {
			const message = { [type]: {} }
			markViewOnce(message)
			assert.equal(message[type].viewOnce, true, type)
		}
	})

	it('ignores messages without a viewOnce field or without content', () => {
		const text = { conversation: 'hola' }
		markViewOnce(text)
		assert.deepEqual(text, { conversation: 'hola' })

		const empty = {}
		markViewOnce(empty)
		assert.deepEqual(empty, {})
	})
})

describe('isViewOnceMessage', () => {
	it('detects the wrapper messages', () => {
		assert.equal(isViewOnceMessage({ viewOnceMessage: { message: { imageMessage: {} } } }), true)
		assert.equal(isViewOnceMessage({ viewOnceMessageV2: { message: { imageMessage: {} } } }), true)
		assert.equal(isViewOnceMessage({ viewOnceMessageV2Extension: { message: { imageMessage: {} } } }), true)
	})

	it('detects the inline viewOnce flag', () => {
		assert.equal(isViewOnceMessage({ imageMessage: { viewOnce: true } }), true)
		assert.equal(isViewOnceMessage({ imageMessage: { viewOnce: false } }), false)
	})

	it('is false for normal and empty messages', () => {
		assert.equal(isViewOnceMessage({ conversation: 'hola' }), false)
		assert.equal(isViewOnceMessage(null), false)
		assert.equal(isViewOnceMessage(undefined), false)
	})
})
