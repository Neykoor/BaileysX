import { rustCodec } from '../Rust/codec'
import * as constants from './constants'
import { type FullJid, jidDecode } from './jid-utils'
import type { BinaryNode, BinaryNodeCodingOptions } from './types'

type CodingOpts = Pick<BinaryNodeCodingOptions, 'TAGS' | 'TOKEN_MAP'>

type Writer = {
	buf: Buffer
	len: number
}

const INITIAL_CAPACITY = 1024

const ensureCapacity = (w: Writer, extra: number) => {
	const needed = w.len + extra
	if (needed <= w.buf.length) {
		return
	}

	let capacity = w.buf.length * 2
	while (capacity < needed) {
		capacity *= 2
	}

	const next = Buffer.allocUnsafe(capacity)
	w.buf.copy(next, 0, 0, w.len)
	w.buf = next
}

const pushByte = (w: Writer, value: number) => {
	ensureCapacity(w, 1)
	w.buf[w.len++] = value & 0xff
}

const pushInt = (w: Writer, value: number, n: number) => {
	ensureCapacity(w, n)
	for (let i = 0; i < n; i++) {
		w.buf[w.len++] = (value >> ((n - 1 - i) * 8)) & 0xff
	}
}

const pushBytes = (w: Writer, bytes: ArrayLike<number>) => {
	const n = bytes.length
	ensureCapacity(w, n)
	if (bytes instanceof Uint8Array) {
		w.buf.set(bytes, w.len)
		w.len += n
		return
	}

	for (let i = 0; i < n; i++) {
		w.buf[w.len++] = (bytes[i] as number) & 0xff
	}
}

const pushInt16 = (w: Writer, value: number) => {
	ensureCapacity(w, 2)
	w.buf[w.len++] = (value >> 8) & 0xff
	w.buf[w.len++] = value & 0xff
}

const pushInt20 = (w: Writer, value: number) => {
	ensureCapacity(w, 3)
	w.buf[w.len++] = (value >> 16) & 0x0f
	w.buf[w.len++] = (value >> 8) & 0xff
	w.buf[w.len++] = value & 0xff
}

const writeByteLength = (w: Writer, opts: CodingOpts, length: number) => {
	if (length >= 4294967296) {
		throw new Error('string too large to encode: ' + length)
	}

	if (length >= 1 << 20) {
		pushByte(w, opts.TAGS.BINARY_32)
		pushInt(w, length, 4)
	} else if (length >= 256) {
		pushByte(w, opts.TAGS.BINARY_20)
		pushInt20(w, length)
	} else {
		pushByte(w, opts.TAGS.BINARY_8)
		pushByte(w, length)
	}
}

const writeStringRaw = (w: Writer, opts: CodingOpts, str: string) => {
	const byteLength = Buffer.byteLength(str, 'utf-8')
	writeByteLength(w, opts, byteLength)
	ensureCapacity(w, byteLength)
	w.buf.write(str, w.len, byteLength, 'utf-8')
	w.len += byteLength
}

const packNibble = (char: string) => {
	switch (char) {
		case '-':
			return 10
		case '.':
			return 11
		case '\0':
			return 15
		default:
			if (char >= '0' && char <= '9') {
				return char.charCodeAt(0) - '0'.charCodeAt(0)
			}

			throw new Error(`invalid byte for nibble "${char}"`)
	}
}

const packHex = (char: string) => {
	if (char >= '0' && char <= '9') {
		return char.charCodeAt(0) - '0'.charCodeAt(0)
	}

	if (char >= 'A' && char <= 'F') {
		return 10 + char.charCodeAt(0) - 'A'.charCodeAt(0)
	}

	if (char >= 'a' && char <= 'f') {
		return 10 + char.charCodeAt(0) - 'a'.charCodeAt(0)
	}

	if (char === '\0') {
		return 15
	}

	throw new Error(`Invalid hex char "${char}"`)
}

const writePackedBytes = (w: Writer, opts: CodingOpts, str: string, type: 'nibble' | 'hex') => {
	if (str.length > opts.TAGS.PACKED_MAX) {
		throw new Error('Too many bytes to pack')
	}

	pushByte(w, type === 'nibble' ? opts.TAGS.NIBBLE_8 : opts.TAGS.HEX_8)

	let roundedLength = Math.ceil(str.length / 2.0)
	if (str.length % 2 !== 0) {
		roundedLength |= 128
	}

	pushByte(w, roundedLength)
	const packFunction = type === 'nibble' ? packNibble : packHex

	const strLengthHalf = Math.floor(str.length / 2)
	for (let i = 0; i < strLengthHalf; i++) {
		pushByte(w, (packFunction(str[2 * i]!) << 4) | packFunction(str[2 * i + 1]!))
	}

	if (str.length % 2 !== 0) {
		pushByte(w, (packFunction(str[str.length - 1]!) << 4) | packFunction('\x00'))
	}
}

const isNibble = (str: string | undefined, packedMax: number) => {
	if (!str || str.length > packedMax) {
		return false
	}

	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i)
		if (!(code >= 48 && code <= 57) && code !== 45 && code !== 46) {
			return false
		}
	}

	return true
}

const isHex = (str: string | undefined, packedMax: number) => {
	if (!str || str.length > packedMax) {
		return false
	}

	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i)
		if (!(code >= 48 && code <= 57) && !(code >= 65 && code <= 70)) {
			return false
		}
	}

	return true
}

const writeJid = (w: Writer, opts: CodingOpts, { domainType, device, user, server }: FullJid) => {
	if (typeof device !== 'undefined') {
		pushByte(w, opts.TAGS.AD_JID)
		pushByte(w, domainType || 0)
		pushByte(w, device || 0)
		writeString(w, opts, user)
	} else {
		pushByte(w, opts.TAGS.JID_PAIR)
		if (user.length) {
			writeString(w, opts, user)
		} else {
			pushByte(w, opts.TAGS.LIST_EMPTY)
		}

		writeString(w, opts, server)
	}
}

const writeString = (w: Writer, opts: CodingOpts, str?: string) => {
	const { TAGS, TOKEN_MAP } = opts

	if (str === undefined || str === null) {
		pushByte(w, TAGS.LIST_EMPTY)
		return
	}

	if (str === '') {
		writeStringRaw(w, opts, str)
		return
	}

	const tokenIndex = TOKEN_MAP[str]
	if (tokenIndex) {
		if (typeof tokenIndex.dict === 'number') {
			pushByte(w, TAGS.DICTIONARY_0 + tokenIndex.dict)
		}

		pushByte(w, tokenIndex.index)
	} else if (isNibble(str, TAGS.PACKED_MAX)) {
		writePackedBytes(w, opts, str, 'nibble')
	} else if (isHex(str, TAGS.PACKED_MAX)) {
		writePackedBytes(w, opts, str, 'hex')
	} else {
		const decodedJid = jidDecode(str)
		if (decodedJid) {
			writeJid(w, opts, decodedJid)
		} else {
			writeStringRaw(w, opts, str)
		}
	}
}

const writeListStart = (w: Writer, opts: CodingOpts, listSize: number) => {
	if (listSize === 0) {
		pushByte(w, opts.TAGS.LIST_EMPTY)
	} else if (listSize < 256) {
		pushByte(w, opts.TAGS.LIST_8)
		pushByte(w, listSize)
	} else {
		pushByte(w, opts.TAGS.LIST_16)
		pushInt16(w, listSize)
	}
}

const writeNode = (w: Writer, opts: CodingOpts, { tag, attrs, content }: BinaryNode) => {
	if (!tag) {
		throw new Error('Invalid node: tag cannot be undefined')
	}

	const validAttributes: string[] = []
	if (attrs) {
		for (const key of Object.keys(attrs)) {
			if (typeof attrs[key] === 'string') {
				validAttributes.push(key)
			}
		}
	}

	writeListStart(w, opts, 2 * validAttributes.length + 1 + (typeof content !== 'undefined' ? 1 : 0))
	writeString(w, opts, tag)

	for (const key of validAttributes) {
		writeString(w, opts, key)
		writeString(w, opts, attrs[key])
	}

	if (typeof content === 'string') {
		writeString(w, opts, content)
	} else if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
		writeByteLength(w, opts, content.length)
		pushBytes(w, content as Uint8Array)
	} else if (Array.isArray(content)) {
		const validContent = content.filter(
			item => item && (item.tag || Buffer.isBuffer(item) || item instanceof Uint8Array || typeof item === 'string')
		)
		writeListStart(w, opts, validContent.length)
		for (const item of validContent) {
			writeNode(w, opts, item)
		}
	} else if (typeof content !== 'undefined') {
		throw new Error(`invalid children for header "${tag}": ${content} (${typeof content})`)
	}
}

export const encodeBinaryNodeJS = (
	node: BinaryNode,
	opts: Pick<BinaryNodeCodingOptions, 'TAGS' | 'TOKEN_MAP'> = constants,
	buffer: number[] = [0]
): Buffer => {
	const w: Writer = {
		buf: Buffer.allocUnsafe(Math.max(INITIAL_CAPACITY, buffer.length * 2)),
		len: 0
	}
	pushBytes(w, buffer)
	writeNode(w, opts, node)
	return w.buf.subarray(0, w.len)
}

export const encodeBinaryNode = (
	node: BinaryNode,
	opts: Pick<BinaryNodeCodingOptions, 'TAGS' | 'TOKEN_MAP'> = constants,
	buffer: number[] = [0]
): Buffer => {
	if (opts === constants && buffer.length === 1 && buffer[0] === 0) {
		const fast = rustCodec.tryEncode(node)
		if (fast) {
			return fast
		}
	}

	return encodeBinaryNodeJS(node, opts, buffer)
}
