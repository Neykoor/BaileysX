import { createPrivateKey, createPublicKey, diffieHellman, randomBytes } from 'node:crypto'
import { Curve } from '../../lib/Utils/crypto.js'
import { SenderChainKey } from '../../lib/Signal/Group/sender-chain-key.js'

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

const iterations = readArg('iterations', 2000)
const rounds = readArg('rounds', 7)
const chainSteps = readArg('chain', 2000)

const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex')

const toPrivateKeyObject = priv =>
	createPrivateKey({ key: Buffer.concat([PKCS8_X25519, priv]), format: 'der', type: 'pkcs8' })

const toPublicKeyObject = pub =>
	createPublicKey({ key: Buffer.concat([SPKI_X25519, pub]), format: 'der', type: 'spki' })

const nativeShared = (priv, pub) =>
	diffieHellman({ privateKey: toPrivateKeyObject(priv), publicKey: toPublicKeyObject(pub) })

const median = values => {
	const sorted = [...values].sort((a, b) => a - b)
	const mid = sorted.length >> 1
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

let guard = 0

const run = (fn, count) => {
	const start = process.hrtime.bigint()
	for (let i = 0; i < count; i++) {
		guard += fn()
	}

	return Number(process.hrtime.bigint() - start) / count / 1000
}

const bench = (label, fn, count) => {
	const warmup = Math.max(5, Math.floor(count / 5))
	run(fn, warmup)

	const samples = []
	for (let round = 0; round < rounds; round++) {
		samples.push(run(fn, count))
	}

	const micros = median(samples)
	return { operacion: label, 'us/op': micros.toFixed(2), 'ops/s': Math.round(1_000_000 / micros).toString() }
}

const alice = Curve.generateKeyPair()
const bob = Curve.generateKeyPair()
const signingPayload = Buffer.concat([Buffer.from([5]), bob.public])
const signature = Curve.sign(alice.private, signingPayload)

const jsShared = Curve.sharedKey(alice.private, bob.public)
const nativeSharedKey = nativeShared(alice.private, bob.public)
const sameShared = Buffer.compare(Buffer.from(jsShared), Buffer.from(nativeSharedKey)) === 0

if (!Curve.verify(alice.public, signingPayload, signature)) {
	throw new Error('la firma generada no verifica contra su propia clave publica')
}

const alicePrivateObject = toPrivateKeyObject(alice.private)
const bobPublicObject = toPublicKeyObject(bob.public)
const chainSeed = randomBytes(32)

const rows = [
	bench('Curve.generateKeyPair', () => Curve.generateKeyPair().public.length, iterations),
	bench('Curve.sharedKey (X25519 en JS)', () => Curve.sharedKey(alice.private, bob.public).length, iterations),
	bench(
		'X25519 nativo, claves cacheadas',
		() => diffieHellman({ privateKey: alicePrivateObject, publicKey: bobPublicObject }).length,
		iterations
	),
	bench('X25519 nativo, importando claves', () => nativeShared(alice.private, bob.public).length, iterations),
	bench('Curve.sign (XEdDSA)', () => Curve.sign(alice.private, signingPayload).length, iterations),
	bench('Curve.verify (XEdDSA)', () => (Curve.verify(alice.public, signingPayload, signature) ? 1 : 0), iterations),
	bench(
		`cadena sender key x${chainSteps}`,
		() => {
			let chain = new SenderChainKey(0, chainSeed)
			let acc = 0
			for (let i = 0; i < chainSteps; i++) {
				acc += chain.getSenderMessageKey().getIteration()
				chain = chain.getNext()
			}

			return acc
		},
		Math.max(5, Math.floor(iterations / 100))
	)
]

console.log(`node ${process.version} | iteraciones base ${iterations} | rondas ${rounds}`)
console.log(`X25519 JS y nativo coinciden: ${sameShared}`)
console.table(rows)
console.log(`control ${guard}`)
