import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

process.env.BAILEYS_RUST_CODEC = '1'

const { isRustAreaEnabled } = await import('../lib/Rust/bridge.js')
const { createRustCodec, sameNode, toBridgeNode } = await import('../lib/Rust/codec.js')
const { describeRust } = await import('../lib/Rust/index.js')
const { CODEC_KNOWN_ANSWERS } = await import('../lib/Rust/known-answers.js')
const constants = await import('../lib/WABinary/constants.js')
const { encodeBinaryNode, encodeBinaryNodeJS } = await import('../lib/WABinary/encode.js')
const { decodeBinaryNode, decodeBinaryNodeJS, decodeDecompressedBinaryNode } = await import('../lib/WABinary/decode.js')

const reference = frame => decodeDecompressedBinaryNode(frame.subarray(1), constants)

const countNodes = node => 1 + (Array.isArray(node.content) ? node.content.reduce((sum, child) => sum + countNodes(child), 0) : 0)

const sample = () => ({
	tag: 'iq',
	attrs: { id: 'abc', to: '123:5@s.whatsapp.net', type: 'get', xmlns: 'encrypt' },
	content: [
		{ tag: 'value', attrs: { v: '123-456' }, content: Buffer.from('hello world') },
		{ tag: 'nested', attrs: {}, content: [{ tag: 'leaf', attrs: {}, content: Buffer.from([1, 2, 3]) }] }
	]
})

const toWasm = (node, state, reverseAttrs = false) => {
	const keys = Object.keys(node.attrs ?? {})
	const attrs = {}
	for (const key of reverseAttrs ? keys.reverse() : keys) {
		attrs[key] = node.attrs[key]
	}

	const content = Array.isArray(node.content) ? node.content.map(child => toWasm(child, state, reverseAttrs)) : node.content
	return {
		tag: node.tag,
		attrs,
		content,
		free: () => {
			state.freed++
		}
	}
}

const fromWasm = wasm => ({
	tag: wasm.tag,
	attrs: { ...wasm.attrs },
	content: Array.isArray(wasm.content) ? wasm.content.map(fromWasm) : (wasm.content ?? undefined)
})

const makeBridge = (overrides = {}) => {
	const state = { freed: 0, encodeCalls: 0, decodeCalls: 0, reverseAttrs: false, ...overrides.state }
	const bridge = {
		encodeNode: node => {
			state.encodeCalls++
			return Uint8Array.from(encodeBinaryNodeJS(fromWasm(toWasm(node, state, state.reverseAttrs))))
		},
		decodeNode: buffer => {
			state.decodeCalls++
			return toWasm(reference(Buffer.from(buffer)), state, state.reverseAttrs)
		},
		...overrides.bridge
	}
	return { bridge, state }
}

const makeCodec = (bridge, extra = {}) => createRustCodec({ bridge, enabled: true, reference, ...extra })

describe('banderas de Rust', () => {
	it('esta apagado por defecto y respeta la precedencia', () => {
		assert.equal(isRustAreaEnabled('CODEC', {}), false)
		assert.equal(isRustAreaEnabled('CODEC', { BAILEYS_RUST: '1' }), true)
		assert.equal(isRustAreaEnabled('CODEC', { BAILEYS_RUST: '1', BAILEYS_RUST_CODEC: '0' }), false)
		assert.equal(isRustAreaEnabled('CODEC', { BAILEYS_RUST: 'off', BAILEYS_RUST_CODEC: 'yes' }), true)
		assert.equal(isRustAreaEnabled('CODEC', { BAILEYS_RUST_CODEC: ' TRUE ' }), true)
		assert.equal(isRustAreaEnabled('CODEC', { BAILEYS_RUST_CODEC: 'quizas' }), false)
		assert.equal(isRustAreaEnabled('CODEC', { BAILEYS_RUST_CODEC: 'quizas', BAILEYS_RUST: '1' }), true)
	})
})

describe('toBridgeNode', () => {
	it('convierte nodos normales y conserva el contenido', () => {
		const node = sample()
		const converted = toBridgeNode(node)
		assert.ok(converted)
		assert.equal(converted.tag, 'iq')
		assert.deepEqual(converted.attrs, node.attrs)
		assert.equal(converted.content.length, 2)
		assert.ok(Buffer.isBuffer(converted.content[1].content[0].content))
	})

	it('omite atributos undefined o null', () => {
		const converted = toBridgeNode({ tag: 'a', attrs: { x: '1', y: undefined, z: null } })
		assert.deepEqual(converted, { tag: 'a', attrs: { x: '1' } })
	})

	it('rechaza lo que el codec JS trata distinto', () => {
		assert.equal(toBridgeNode({ tag: '', attrs: {} }), null)
		assert.equal(toBridgeNode({ tag: 5, attrs: {} }), null)
		assert.equal(toBridgeNode({ tag: 'a', attrs: { x: '' } }), null)
		assert.equal(toBridgeNode({ tag: 'a', attrs: { x: '   ' } }), null)
		assert.equal(toBridgeNode({ tag: 'a', attrs: { x: 7 } }), null)
		assert.equal(toBridgeNode({ tag: 'a', attrs: {}, content: '' }), null)
		assert.equal(toBridgeNode({ tag: 'a', attrs: {}, content: 42 }), null)
		assert.equal(toBridgeNode({ tag: 'a', attrs: {}, content: ['texto'] }), null)
		assert.equal(toBridgeNode({ tag: 'a', attrs: {}, content: [Buffer.from([1])] }), null)
		assert.equal(toBridgeNode({ tag: 'a', attrs: {}, content: [{ tag: 'b', attrs: { x: '' } }] }), null)
	})

	it('ignora hijos vacios o sin tag igual que el codec JS', () => {
		const converted = toBridgeNode({ tag: 'a', attrs: {}, content: [null, undefined, {}, { tag: 'b', attrs: {} }] })
		assert.deepEqual(converted, { tag: 'a', attrs: {}, content: [{ tag: 'b', attrs: {} }] })
	})
})

describe('respuestas conocidas', () => {
	it('siguen coincidiendo con el codec JS actual', async () => {
		assert.ok(CODEC_KNOWN_ANSWERS.length >= 8)
		for (const answer of CODEC_KNOWN_ANSWERS) {
			assert.equal(encodeBinaryNodeJS(answer.node).toString('hex'), answer.hex, `codificacion de ${answer.name}`)
			const decoded = await decodeBinaryNodeJS(Buffer.from(answer.hex, 'hex'))
			assert.ok(sameNode(decoded, answer.node), `decodificacion de ${answer.name}`)
		}
	})
})

describe('autoprueba y uso del codec en Rust', () => {
	it('con un bridge fiel se verifica, codifica y decodifica', () => {
		const { bridge, state } = makeBridge()
		const codec = makeCodec(bridge)
		assert.equal(codec.status().state, 'unverified')

		const node = sample()
		const encoded = codec.tryEncode(node)
		assert.equal(codec.status().state, 'ready')
		assert.ok(Buffer.isBuffer(encoded))
		assert.ok(sameNode(reference(encoded), node))

		state.freed = 0
		const decoded = codec.tryDecode(encodeBinaryNodeJS(node))
		assert.ok(decoded)
		assert.ok(sameNode(decoded, node))
		assert.equal(state.freed, countNodes(node))
		assert.ok(Buffer.isBuffer(decoded.content[1].content[0].content))
	})

	it('tolera otro orden de atributos', () => {
		const { bridge } = makeBridge({ state: { reverseAttrs: true } })
		const codec = makeCodec(bridge)
		const node = sample()
		const encoded = codec.tryEncode(node)
		assert.equal(codec.status().state, 'ready')
		assert.ok(sameNode(reference(encoded), node))
	})

	it('apagado no toca el bridge', () => {
		const { bridge, state } = makeBridge()
		const codec = createRustCodec({ bridge, enabled: false, reference })
		assert.equal(codec.status().state, 'off')
		assert.equal(codec.tryEncode(sample()), null)
		assert.equal(codec.tryDecode(encodeBinaryNodeJS(sample())), null)
		assert.equal(state.encodeCalls + state.decodeCalls, 0)
	})

	it('sin las funciones en el bridge queda no disponible', () => {
		const codec = makeCodec({ decodeNode: () => ({}) })
		assert.equal(codec.status().state, 'unavailable')
		assert.match(codec.status().reason, /encodeNode/)
		assert.equal(codec.tryEncode(sample()), null)
		assert.equal(makeCodec(undefined).status().state, 'unavailable')
	})

	it('sin decodificador de referencia no se activa, y despues si', () => {
		const { bridge } = makeBridge()
		const codec = createRustCodec({ bridge, enabled: true })
		assert.equal(codec.tryEncode(sample()), null)
		assert.equal(codec.status().state, 'unverified')
		codec.setReference(reference)
		assert.ok(codec.tryEncode(sample()))
		assert.equal(codec.status().state, 'ready')
	})

	it('si encodeNode produce basura se desactiva y no vuelve a llamar al bridge', () => {
		const { bridge, state } = makeBridge({ bridge: { encodeNode: () => Uint8Array.from([0, 1, 2, 3]) } })
		const codec = makeCodec(bridge)
		assert.equal(codec.tryEncode(sample()), null)
		assert.equal(codec.status().state, 'failed')
		assert.match(codec.status().reason, /encodeNode/)
		const callsAfterFailure = state.decodeCalls
		assert.equal(codec.tryDecode(encodeBinaryNodeJS(sample())), null)
		assert.equal(codec.tryEncode(sample()), null)
		assert.equal(state.decodeCalls, callsAfterFailure)
	})

	it('si decodeNode devuelve algo distinto se desactiva', () => {
		const { bridge } = makeBridge({
			bridge: { decodeNode: () => ({ tag: 'otro', attrs: {}, content: undefined, free: () => {} }) }
		})
		const codec = makeCodec(bridge)
		assert.equal(codec.tryDecode(encodeBinaryNodeJS(sample())), null)
		assert.equal(codec.status().state, 'failed')
		assert.match(codec.status().reason, /decodeNode/)
	})

	it('si el bridge lanza durante la autoprueba se desactiva', () => {
		const { bridge } = makeBridge({
			bridge: {
				decodeNode: () => {
					throw new Error('explota')
				}
			}
		})
		const codec = makeCodec(bridge)
		assert.equal(codec.tryEncode(sample()), null)
		assert.equal(codec.status().state, 'failed')
		assert.match(codec.status().reason, /explota/)
	})

	it('un error posterior devuelve null y mantiene el codec activo', () => {
		const { bridge, state } = makeBridge()
		const codec = makeCodec(bridge)
		assert.ok(codec.tryEncode(sample()))

		const originalEncode = bridge.encodeNode
		const originalDecode = bridge.decodeNode
		bridge.encodeNode = () => {
			throw new Error('fallo puntual')
		}
		bridge.decodeNode = () => {
			throw new Error('fallo puntual')
		}
		assert.equal(codec.tryEncode(sample()), null)
		assert.equal(codec.tryDecode(Buffer.from([0, 1, 2])), null)
		assert.equal(codec.status().state, 'ready')

		bridge.encodeNode = originalEncode
		bridge.decodeNode = originalDecode
		assert.ok(codec.tryEncode(sample()))
		assert.ok(state.encodeCalls > 0)
	})

	it('un nodo no convertible no llega al bridge', () => {
		const { bridge, state } = makeBridge()
		const codec = makeCodec(bridge)
		assert.ok(codec.tryEncode(sample()))
		const calls = state.encodeCalls
		assert.equal(codec.tryEncode({ tag: 'a', attrs: { x: '' } }), null)
		assert.equal(state.encodeCalls, calls)
	})

	it('libera el nodo raiz si la materializacion falla', () => {
		const { bridge } = makeBridge()
		const codec = makeCodec(bridge)
		assert.ok(codec.tryEncode(sample()))

		let freed = 0
		bridge.decodeNode = () => ({
			tag: 'x',
			attrs: {},
			get content() {
				throw new Error('contenido ilegible')
			},
			free: () => {
				freed++
			}
		})
		assert.equal(codec.tryDecode(Buffer.from([0, 1])), null)
		assert.equal(freed, 1)
	})
})

describe('encodeBinaryNode y decodeBinaryNode con la instancia por defecto', () => {
	const status = describeRust().codec

	it('sin Rust usan el codec JS y dan el mismo resultado', async () => {
		for (const answer of CODEC_KNOWN_ANSWERS) {
			const decoded = await decodeBinaryNode(Buffer.from(answer.hex, 'hex'))
			assert.ok(sameNode(decoded, answer.node), `decode ${answer.name}`)
			const encoded = encodeBinaryNode(answer.node)
			assert.ok(sameNode(await decodeBinaryNodeJS(Buffer.from(encoded)), answer.node), `encode ${answer.name}`)
		}
	})

	it('con el bridge real instalado, la autoprueba pasa y el resultado es equivalente', { skip: status.state === 'unavailable' }, async () => {
		for (const answer of CODEC_KNOWN_ANSWERS) {
			const decoded = await decodeBinaryNode(Buffer.from(answer.hex, 'hex'))
			assert.ok(sameNode(decoded, answer.node), `decode ${answer.name}`)
			const encoded = encodeBinaryNode(answer.node)
			assert.ok(sameNode(await decodeBinaryNodeJS(Buffer.from(encoded)), answer.node), `encode ${answer.name}`)
		}

		const after = describeRust().codec
		assert.equal(after.state, 'ready', `estado ${after.state}: ${after.reason ?? ''}`)
	})
})
