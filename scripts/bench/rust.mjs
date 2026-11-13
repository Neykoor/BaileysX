import { randomBytes } from 'node:crypto'

process.env.BAILEYS_RUST_CODEC ??= '1'

const { encodeBinaryNodeJS } = await import('../../lib/WABinary/encode.js')
const { decodeBinaryNodeJS } = await import('../../lib/WABinary/decode.js')
const { rustCodec } = await import('../../lib/Rust/codec.js')

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

const countNodes = node => 1 + (Array.isArray(node.content) ? node.content.reduce((sum, child) => sum + countNodes(child), 0) : 0)

const cases = [
	[
		'mensaje 1:1',
		{
			tag: 'message',
			attrs: { id: hexId(), from: '5215512345678@s.whatsapp.net', t: '1731400000', type: 'text', notify: 'Contacto' },
			content: [{ tag: 'enc', attrs: { v: '2', type: 'msg' }, content: randomBytes(512) }]
		}
	],
	[
		'mensaje grupo',
		{
			tag: 'message',
			attrs: {
				id: hexId(),
				from: '120363041234567890@g.us',
				participant: '5215512345678:7@s.whatsapp.net',
				t: '1731400000',
				type: 'text'
			},
			content: [
				{ tag: 'enc', attrs: { v: '2', type: 'skmsg' }, content: randomBytes(768) },
				{ tag: 'enc', attrs: { v: '2', type: 'pkmsg' }, content: randomBytes(220) }
			]
		}
	],
	[
		'recibo x20',
		{
			tag: 'receipt',
			attrs: { id: hexId(), to: '5215512345678@s.whatsapp.net', type: 'read', t: '1731400000' },
			content: [{ tag: 'list', attrs: {}, content: Array.from({ length: 20 }, () => ({ tag: 'item', attrs: { id: hexId() } })) }]
		}
	],
	[
		'metadata grupo x256',
		{
			tag: 'iq',
			attrs: { id: '12345.6789-42', from: '120363041234567890@g.us', type: 'result' },
			content: [
				{
					tag: 'group',
					attrs: { id: '120363041234567890', subject: 'Grupo de prueba', creation: '1700000000' },
					content: Array.from({ length: 256 }, (_, i) => ({
						tag: 'participant',
						attrs: { jid: i % 3 === 0 ? `${100000000000000 + i}:${i % 5}@lid` : `52155${String(10000000 + i)}@s.whatsapp.net` }
					}))
				}
			]
		}
	]
]

const median = values => {
	const sorted = [...values].sort((a, b) => a - b)
	const mid = sorted.length >> 1
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const micros = (start, count) => Number(process.hrtime.bigint() - start) / count / 1000

let guard = 0

const timeSync = (fn, count) => {
	const start = process.hrtime.bigint()
	for (let i = 0; i < count; i++) {
		guard += fn().length
	}

	return micros(start, count)
}

const timeAsync = async (fn, count) => {
	const start = process.hrtime.bigint()
	for (let i = 0; i < count; i++) {
		guard += (await fn()).tag.length
	}

	return micros(start, count)
}

const measure = async (run, count) => {
	await run(Math.max(50, Math.floor(count / 5)))
	const samples = []
	for (let round = 0; round < rounds; round++) {
		samples.push(await run(count))
	}

	return median(samples)
}

const probe = cases[0][1]
if (!rustCodec.tryEncode(probe)) {
	const { state, reason } = rustCodec.status()
	console.error(`el codec en Rust no esta activo: ${state}${reason ? ` (${reason})` : ''}`)
	process.exit(1)
}

console.log(`node ${process.version} | iteraciones base ${iterations} | rondas ${rounds} | codec rust: ${rustCodec.status().state}`)

const rows = []
for (const [label, node] of cases) {
	const encoded = Buffer.from(encodeBinaryNodeJS(node))
	const count = Math.max(200, Math.floor(iterations / Math.ceil(countNodes(node) / 8)))

	const jsEncode = await measure(async n => timeSync(() => encodeBinaryNodeJS(node), n), count)
	const rustEncode = await measure(async n => timeSync(() => rustCodec.tryEncode(node), n), count)
	const jsDecode = await measure(n => timeAsync(() => decodeBinaryNodeJS(encoded), n), count)
	const rustDecode = await measure(async n => timeAsync(async () => rustCodec.tryDecode(encoded), n), count)

	rows.push({
		caso: label,
		'encode js us': jsEncode.toFixed(2),
		'encode rust us': rustEncode.toFixed(2),
		'encode x': (jsEncode / rustEncode).toFixed(2),
		'decode js us': jsDecode.toFixed(2),
		'decode rust us': rustDecode.toFixed(2),
		'decode x': (jsDecode / rustDecode).toFixed(2)
	})
}

console.table(rows)
console.log('x mayor que 1 significa que Rust es mas rapido; menor que 1, mas lento')
console.log(`control ${guard}`)
