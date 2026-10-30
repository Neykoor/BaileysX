import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decodeBinaryNode } from '../lib/WABinary/decode.js'
import { encodeBinaryNode } from '../lib/WABinary/encode.js'

const roundTrip = async node => decodeBinaryNode(encodeBinaryNode(node))

describe('binary node codec', () => {
	it('round-trips attributes, strings and children', async () => {
		const node = {
			tag: 'iq',
			attrs: {
				id: 'abc',
				to: '123:5@s.whatsapp.net',
				from: '456@lid',
				type: 'get',
				xmlns: 'encrypt'
			},
			content: [
				{ tag: 'ping', attrs: {} },
				{ tag: 'value', attrs: { v: '123-456' }, content: 'hello world' },
				{ tag: 'hex', attrs: {}, content: 'ABCDEF' },
				{ tag: 'nested', attrs: {}, content: [{ tag: 'leaf', attrs: {}, content: Buffer.from([1, 2, 3]) }] }
			]
		}

		const decoded = await roundTrip(node)
		assert.equal(decoded.tag, 'iq')
		assert.deepEqual(decoded.attrs, node.attrs)
		assert.equal(decoded.content[0].tag, 'ping')
		assert.equal(decoded.content[0].content, undefined)
		assert.deepEqual(decoded.content[1].content, Buffer.from('hello world'))
		assert.equal(decoded.content[2].content, 'ABCDEF')
		assert.deepEqual(decoded.content[3].content[0].content, Buffer.from([1, 2, 3]))
	})

	it('round-trips binary and empty content', async () => {
		const binary = { tag: 'binary', attrs: {}, content: Buffer.from([0, 1, 2, 255]) }
		assert.deepEqual(await roundTrip(binary), binary)

		const empty = await roundTrip({ tag: 'empty', attrs: {}, content: '' })
		assert.equal(empty.tag, 'empty')
		assert.deepEqual(empty.content, Buffer.alloc(0))
	})

	it('preserves hosted and LID JIDs in attributes', async () => {
		const node = {
			tag: 'message',
			attrs: {
				to: '123:99@hosted',
				from: '456:5@hosted.lid',
				participant: '789:2@lid'
			}
		}
		const decoded = await roundTrip(node)
		assert.equal(decoded.tag, 'message')
		assert.deepEqual(decoded.attrs, node.attrs)
	})

	it('rejects nodes without a tag', () => {
		assert.throws(() => encodeBinaryNode({ attrs: {} }), /tag cannot be undefined/)
	})
})
