import { randomBytes } from 'node:crypto'
import { encodeBinaryNode } from '../../lib/WABinary/encode.js'
import { decodeBinaryNode } from '../../lib/WABinary/decode.js'

const readArg = (name, fallback) => {
	const found = process.argv.slice(2).find(arg => arg.startsWith(`--${name}=`))
	if (!found) {
		return fallback
	}

	const value = Number(found.slice(name.length + 3))
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`--${name} debe ser un entero positivo`)
	}

	return value
}

const iterations = readArg('iterations', 20000)
const rounds = readArg('rounds', 7)

const hexId = () => '3EB0' + randomBytes(18).toString('hex').toUpperCase()

const countNodes = node => {
	let total = 1
	if (Array.isArray(node.content)) {
		for (const child of node.content) {
			total += countNodes(child)
		}
	}

	return total
}

const buildMessage = () => ({
	tag: 'message',
	attrs: {
		id: hexId(),
		from: '5215512345678@s.whatsapp.net',
		t: '1731400000',
		type: 'text',
		notify: 'Contacto de prueba'
	},
	content: [{ tag: 'enc', attrs: { v: '2', type: 'msg' }, content: randomBytes(512) }]
})

const buildGroupMessage = () => ({
	tag: 'message',
	attrs: {
		id: hexId(),
		from: '120363041234567890@g.us',
		participant: '5215512345678:7@s.whatsapp.net',
		t: '1731400000',
		type: 'text',
		addressing_mode: 'pn'
	},
	content: [
		{ tag: 'enc', attrs: { v: '2', type: 'skmsg' }, content: randomBytes(768) },
		{ tag: 'enc', attrs: { v: '2', type: 'pkmsg' }, content: randomBytes(220) }
	]
})

const buildReceipt = () => ({
	tag: 'receipt',
	attrs: { id: hexId(), to: '5215512345678@s.whatsapp.net', type: 'read', t: '1731400000' },
	content: [
		{
			tag: 'list',
			attrs: {},
			content: Array.from({ length: 20 }, () => ({ tag: 'item', attrs: { id: hexId() } }))
		}
	]
})

const buildGroupMetadata = size => ({
	tag: 'iq',
	attrs: { id: '12345.6789-42', from: '120363041234567890@g.us', type: 'result' },
	content: [
		{
			tag: 'group',
			attrs: { id: '120363041234567890', subject: 'Grupo de prueba', creation: '1700000000', creator: '5215500000000@s.whatsapp.net' },
			content: Array.from({ length: size }, (_, i) => ({
				tag: 'participant',
				attrs: {
					jid: i % 3 === 0 ? `${100000000000000 + i}:${i % 5}@lid` : `52155${String(10000000 + i)}@s.whatsapp.net`,
					...(i % 17 === 0 ? { type: 'admin' } : {})
				}
			}))
		}
	]
})

const cases = [
	['mensaje 1:1', buildMessage()],
	['mensaje grupo', buildGroupMessage()],
	['recibo x20', buildReceipt()],
	['metadata grupo x256', buildGroupMetadata(256)]
]

const median = values => {
	const sorted = [...values].sort((a, b) => a - b)
	const mid = sorted.length >> 1
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const microsPerOp = (startNs, count) => Number(process.hrtime.bigint() - startNs) / count / 1000

const measureEncode = (node, count) => {
	let sink = 0
	const start = process.hrtime.bigint()
	for (let i = 0; i < count; i++) {
		sink += encodeBinaryNode(node).length
	}

	return { micros: microsPerOp(start, count), sink }
}

const measureDecode = async (encoded, count) => {
	let sink = 0
	const start = process.hrtime.bigint()
	for (let i = 0; i < count; i++) {
		const decoded = await decodeBinaryNode(encoded)
		sink += decoded.tag.length
	}

	return { micros: microsPerOp(start, count), sink }
}

const assertRoundTrip = async (label, node) => {
	const decoded = await decodeBinaryNode(encodeBinaryNode(node))
	if (decoded.tag !== node.tag || countNodes(decoded) !== countNodes(node)) {
		throw new Error(`el round-trip falló en el caso "${label}"`)
	}
}

const rows = []
let guard = 0

for (const [label, node] of cases) {
	await assertRoundTrip(label, node)

	const encoded = Buffer.from(encodeBinaryNode(node))
	const count = Math.max(200, Math.floor(iterations / Math.ceil(countNodes(node) / 8)))
	const warmup = Math.max(50, Math.floor(count / 5))

	guard += measureEncode(node, warmup).sink
	guard += (await measureDecode(encoded, warmup)).sink

	const encodeSamples = []
	const decodeSamples = []

	for (let round = 0; round < rounds; round++) {
		const enc = measureEncode(node, count)
		const dec = await measureDecode(encoded, count)
		guard += enc.sink + dec.sink
		encodeSamples.push(enc.micros)
		decodeSamples.push(dec.micros)
	}

	const encodeMicros = median(encodeSamples)
	const decodeMicros = median(decodeSamples)

	rows.push({
		caso: label,
		nodos: countNodes(node),
		bytes: encoded.length,
		'encode us/op': encodeMicros.toFixed(2),
		'decode us/op': decodeMicros.toFixed(2),
		'decode MB/s': (encoded.length / decodeMicros).toFixed(1)
	})
}

console.log(`node ${process.version} | iteraciones base ${iterations} | rondas ${rounds}`)
console.table(rows)
console.log(`control ${guard}`)
