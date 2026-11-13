import type { BinaryNode } from '../WABinary/types'
import { getRustBridge, isRustAreaEnabled, type RustBridge, type WasmNode } from './bridge'
import { CODEC_KNOWN_ANSWERS, type KnownAnswer } from './known-answers'

export type RustCodecState = 'off' | 'unavailable' | 'unverified' | 'ready' | 'failed'

export type RustCodecStatus = {
	state: RustCodecState
	reason?: string
}

export type CodecReference = (frame: Buffer) => BinaryNode

export type RustCodecOptions = {
	bridge?: RustBridge
	enabled: boolean
	knownAnswers?: KnownAnswer[]
	reference?: CodecReference
}

type BridgeNode = {
	tag: string
	attrs: Record<string, string>
	content?: BridgeNode[] | Uint8Array | string
}

const isBytes = (value: unknown): value is Uint8Array => value instanceof Uint8Array

export const toBridgeNode = (node: BinaryNode): BridgeNode | null => {
	if (!node || typeof node.tag !== 'string' || node.tag === '') {
		return null
	}

	const attrs: Record<string, string> = {}
	if (node.attrs) {
		for (const key of Object.keys(node.attrs)) {
			const value: unknown = node.attrs[key]
			if (value === undefined || value === null) {
				continue
			}

			if (typeof value !== 'string' || value.trim() === '') {
				return null
			}

			attrs[key] = value
		}
	}

	const out: BridgeNode = { tag: node.tag, attrs }
	const content: unknown = node.content
	if (content === undefined) {
		return out
	}

	if (typeof content === 'string') {
		if (content === '') {
			return null
		}

		out.content = content
		return out
	}

	if (isBytes(content)) {
		out.content = content
		return out
	}

	if (Array.isArray(content)) {
		const children: BridgeNode[] = []
		for (const item of content as unknown[]) {
			if (!item) {
				continue
			}

			if (typeof item === 'string' || isBytes(item)) {
				return null
			}

			if (typeof item !== 'object' || !(item as BinaryNode).tag) {
				continue
			}

			const child = toBridgeNode(item as BinaryNode)
			if (!child) {
				return null
			}

			children.push(child)
		}

		out.content = children
		return out
	}

	return null
}

const releaseNode = (node: WasmNode) => {
	try {
		node.free?.()
	} catch {
		return
	}
}

export const materializeNode = (wasmNode: WasmNode): BinaryNode => {
	const content = wasmNode.content
	const attrs = { ...wasmNode.attrs }
	let node: BinaryNode

	if (Array.isArray(content)) {
		node = { tag: wasmNode.tag, attrs, content: content.map(materializeNode) }
	} else if (isBytes(content)) {
		node = { tag: wasmNode.tag, attrs, content: Buffer.from(content) }
	} else if (content === undefined || content === null) {
		node = { tag: wasmNode.tag, attrs, content: undefined }
	} else {
		node = { tag: wasmNode.tag, attrs, content }
	}

	releaseNode(wasmNode)
	return node
}

const sameContent = (a: BinaryNode['content'], b: BinaryNode['content']): boolean => {
	if (a === undefined || b === undefined) {
		return a === b
	}

	if (typeof a === 'string' || typeof b === 'string') {
		return a === b
	}

	if (isBytes(a) || isBytes(b)) {
		return isBytes(a) && isBytes(b) && Buffer.compare(a, b) === 0
	}

	if (a.length !== b.length) {
		return false
	}

	return a.every((child, index) => {
		const other = b[index]
		return other !== undefined && sameNode(child, other)
	})
}

export const sameNode = (a: BinaryNode, b: BinaryNode): boolean => {
	if (a.tag !== b.tag) {
		return false
	}

	const aKeys = Object.keys(a.attrs ?? {})
	const bKeys = Object.keys(b.attrs ?? {})
	if (aKeys.length !== bKeys.length) {
		return false
	}

	for (const key of aKeys) {
		if (a.attrs[key] !== b.attrs[key]) {
			return false
		}
	}

	return sameContent(a.content, b.content)
}

export const createRustCodec = (options: RustCodecOptions) => {
	const bridge = options.bridge
	const knownAnswers = options.knownAnswers ?? CODEC_KNOWN_ANSWERS
	let reference = options.reference
	let state: RustCodecState = 'off'
	let reason: string | undefined

	if (options.enabled) {
		if (typeof bridge?.encodeNode === 'function' && typeof bridge.decodeNode === 'function') {
			state = 'unverified'
		} else {
			state = 'unavailable'
			reason = 'whatsapp-rust-bridge no exporta encodeNode y decodeNode'
		}
	}

	const fail = (message: string): false => {
		state = 'failed'
		reason = message
		return false
	}

	const verify = (): boolean => {
		const encodeNode = bridge?.encodeNode
		const decodeNode = bridge?.decodeNode
		if (!encodeNode || !decodeNode || !reference) {
			return false
		}

		try {
			for (const answer of knownAnswers) {
				const decoded = materializeNode(decodeNode.call(bridge, Buffer.from(answer.hex, 'hex')))
				if (!sameNode(decoded, answer.node)) {
					return fail(`decodeNode difiere del codec JS en "${answer.name}"`)
				}

				const safe = toBridgeNode(answer.node)
				if (!safe) {
					return fail(`el nodo de prueba "${answer.name}" no es convertible`)
				}

				const encoded = Buffer.from(encodeNode.call(bridge, safe))
				let readBack: BinaryNode | undefined
				try {
					readBack = reference(encoded)
				} catch {
					readBack = undefined
				}

				if (!readBack || !sameNode(readBack, answer.node)) {
					return fail(`encodeNode no se puede leer con el codec JS en "${answer.name}"`)
				}
			}
		} catch (error) {
			return fail(`excepcion durante la autoprueba: ${(error as Error)?.message ?? String(error)}`)
		}

		state = 'ready'
		return true
	}

	const ready = (): boolean => {
		if (state === 'ready') {
			return true
		}

		if (state !== 'unverified') {
			return false
		}

		return verify()
	}

	const tryEncode = (node: BinaryNode): Buffer | null => {
		if (!ready()) {
			return null
		}

		const safe = toBridgeNode(node)
		if (!safe) {
			return null
		}

		try {
			return Buffer.from((bridge as Required<RustBridge>).encodeNode.call(bridge, safe))
		} catch {
			return null
		}
	}

	const tryDecode = (buffer: Buffer): BinaryNode | null => {
		if (!ready()) {
			return null
		}

		let wasmNode: WasmNode | undefined
		try {
			wasmNode = (bridge as Required<RustBridge>).decodeNode.call(bridge, buffer)
			return materializeNode(wasmNode)
		} catch {
			if (wasmNode) {
				releaseNode(wasmNode)
			}

			return null
		}
	}

	return {
		tryEncode,
		tryDecode,
		setReference: (next: CodecReference) => {
			reference = next
		},
		status: (): RustCodecStatus => ({ state, ...(reason ? { reason } : {}) })
	}
}

export type RustCodec = ReturnType<typeof createRustCodec>

export const rustCodec: RustCodec = createRustCodec({
	bridge: getRustBridge(),
	enabled: isRustAreaEnabled('CODEC')
})
