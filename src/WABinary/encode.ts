import { promisify } from 'util'
import { inflate } from 'zlib'
import { rustCodec } from '../Rust/codec'
import * as constants from './constants'
import { jidEncode, type JidServer, WAJIDDomains } from './jid-utils'
import type { BinaryNode, BinaryNodeCodingOptions } from './types'

const inflatePromise = promisify(inflate)

type DecodeOpts = Pick<BinaryNodeCodingOptions, 'DOUBLE_BYTE_TOKENS' | 'SINGLE_BYTE_TOKENS' | 'TAGS'>

type Reader = {
	buffer: Buffer
	indexRef: { index: number }
	opts: DecodeOpts
}

export const decompressingIfRequired = async (buffer: Buffer) => {
	if (2 & buffer.readUInt8()) {
		buffer = await inflatePromise(buffer.slice(1))
	} else {
		buffer = buffer.slice(1)
	}

	return buffer
}

const checkEOS = (r: Reader, length: number) => {
	if (r.indexRef.index + length > r.buffer.length) {
		throw new Error('end of stream')
	}
}

const next = (r: Reader) => {
	const value = r.buffer[r.indexRef.index]
	r.indexRef.index += 1
	return value
}

const readByte = (r: Reader) => {
	checkEOS(r, 1)
	return next(r)
}

const readBytes = (r: Reader, n: number) => {
	checkEOS(r, n)
	const value = r.buffer.slice(r.indexRef.index, r.indexRef.index + n)
	r.indexRef.index += n
	return value
}

const readStringFromChars = (r: Reader, length: number) => {
	return readBytes(r, length).toString('utf-8')
}

const readInt = (r: Reader, n: number, littleEndian = false) => {
	checkEOS(r, n)
	let val = 0
	for (let i = 0; i < n; i++) {
		const shift = littleEndian ? i : n - 1 - i
		val |= next(r)! << (shift * 8)
	}

	return val
}

const readInt20 = (r: Reader) => {
	checkEOS(r, 3)
	return ((next(r)! & 15) << 16) + (next(r)! << 8) + next(r)!
}

const unpackHex = (value: number) => {
	if (value >= 0 && value < 16) {
		return value < 10 ? '0'.charCodeAt(0) + value : 'A'.charCodeAt(0) + value - 10
	}

	throw new Error('invalid hex: ' + value)
}

const unpackNibble = (value: number) => {
	if (value >= 0 && value <= 9) {
		return '0'.charCodeAt(0) + value
	}

	switch (value) {
		case 10:
			return '-'.charCodeAt(0)
		case 11:
			return '.'.charCodeAt(0)
		case 15:
			return '\0'.charCodeAt(0)
		default:
			throw new Error('invalid nibble: ' + value)
	}
}

const unpackByte = (r: Reader, tag: number, value: number) => {
	const { TAGS } = r.opts
	if (tag === TAGS.NIBBLE_8) {
		return unpackNibble(value)
	} else if (tag === TAGS.HEX_8) {
		return unpackHex(value)
	} else {
		throw new Error('unknown tag: ' + tag)
	}
}

const readPacked8 = (r: Reader, tag: number) => {
	const startByte = readByte(r)!
	let value = ''

	for (let i = 0; i < (startByte & 127); i++) {
		const curByte = readByte(r)!

		value += String.fromCharCode(unpackByte(r, tag, (curByte & 0xf0) >> 4))
		value += String.fromCharCode(unpackByte(r, tag, curByte & 0x0f))
	}

	if (startByte >> 7 !== 0) {
		value = value.slice(0, -1)
	}

	return value
}

const isListTag = (r: Reader, tag: number) => {
	const { TAGS } = r.opts
	return tag === TAGS.LIST_EMPTY || tag === TAGS.LIST_8 || tag === TAGS.LIST_16
}

const readListSize = (r: Reader, tag: number) => {
	const { TAGS } = r.opts
	switch (tag) {
		case TAGS.LIST_EMPTY:
			return 0
		case TAGS.LIST_8:
			return readByte(r)
		case TAGS.LIST_16:
			return readInt(r, 2)
		default:
			throw new Error('invalid tag for list size: ' + tag)
	}
}

const readJidPair = (r: Reader) => {
	const i = readString(r, readByte(r)!)
	const j = readString(r, readByte(r)!)
	if (j) {
		return (i || '') + '@' + j
	}

	throw new Error('invalid jid pair: ' + i + ', ' + j)
}

const readAdJid = (r: Reader) => {
	const rawDomainType = readByte(r)
	const domainType = Number(rawDomainType)

	const device = readByte(r)
	const user = readString(r, readByte(r)!)

	let server: JidServer = 's.whatsapp.net'
	if (domainType === WAJIDDomains.LID) {
		server = 'lid'
	} else if (domainType === WAJIDDomains.HOSTED) {
		server = 'hosted'
	} else if (domainType === WAJIDDomains.HOSTED_LID) {
		server = 'hosted.lid'
	}

	return jidEncode(user, server, device)
}

const readFbJid = (r: Reader) => {
	const user = readString(r, readByte(r)!)
	const device = readInt(r, 2)
	const server = readString(r, readByte(r)!)
	return `${user}:${device}@${server}`
}

const readInteropJid = (r: Reader) => {
	const user = readString(r, readByte(r)!)
	const device = readInt(r, 2)
	const integrator = readInt(r, 2)

	let server = 'interop'
	const beforeServer = r.indexRef.index
	try {
		server = readString(r, readByte(r)!)
	} catch (err) {
		r.indexRef.index = beforeServer
	}

	return `${integrator}-${user}:${device}@${server}`
}

const getTokenDouble = (r: Reader, index1: number, index2: number) => {
	const dict = r.opts.DOUBLE_BYTE_TOKENS[index1]
	if (!dict) {
		throw new Error(`Invalid double token dict (${index1})`)
	}

	const value = dict[index2]
	if (typeof value === 'undefined') {
		throw new Error(`Invalid double token (${index2})`)
	}

	return value
}

const readString = (r: Reader, tag: number): string => {
	const { SINGLE_BYTE_TOKENS, TAGS } = r.opts
	if (tag >= 1 && tag < SINGLE_BYTE_TOKENS.length) {
		return SINGLE_BYTE_TOKENS[tag] || ''
	}

	switch (tag) {
		case TAGS.DICTIONARY_0:
		case TAGS.DICTIONARY_1:
		case TAGS.DICTIONARY_2:
		case TAGS.DICTIONARY_3:
			return getTokenDouble(r, tag - TAGS.DICTIONARY_0, readByte(r)!)
		case TAGS.LIST_EMPTY:
			return ''
		case TAGS.BINARY_8:
			return readStringFromChars(r, readByte(r)!)
		case TAGS.BINARY_20:
			return readStringFromChars(r, readInt20(r))
		case TAGS.BINARY_32:
			return readStringFromChars(r, readInt(r, 4))
		case TAGS.JID_PAIR:
			return readJidPair(r)
		case TAGS.FB_JID:
			return readFbJid(r)
		case TAGS.INTEROP_JID:
			return readInteropJid(r)
		case TAGS.AD_JID:
			return readAdJid(r)
		case TAGS.HEX_8:
		case TAGS.NIBBLE_8:
			return readPacked8(r, tag)
		default:
			throw new Error('invalid string with tag: ' + tag)
	}
}

const readList = (r: Reader, tag: number) => {
	const items: BinaryNode[] = []
	const size = readListSize(r, tag)!
	for (let i = 0; i < size; i++) {
		items.push(readNode(r))
	}

	return items
}

const readNode = (r: Reader): BinaryNode => {
	const { TAGS } = r.opts

	const listSize = readListSize(r, readByte(r)!)
	const header = readString(r, readByte(r)!)
	if (!listSize || !header.length) {
		throw new Error('invalid node')
	}

	const attrs: BinaryNode['attrs'] = {}
	let data: BinaryNode['content']
	if (listSize === 0 || !header) {
		throw new Error('invalid node')
	}

	const attributesLength = (listSize - 1) >> 1
	for (let i = 0; i < attributesLength; i++) {
		const key = readString(r, readByte(r)!)
		const value = readString(r, readByte(r)!)

		attrs[key] = value
	}

	if (listSize % 2 === 0) {
		const tag = readByte(r)!
		if (isListTag(r, tag)) {
			data = readList(r, tag)
		} else {
			let decoded: Buffer | string
			switch (tag) {
				case TAGS.BINARY_8:
					decoded = readBytes(r, readByte(r)!)
					break
				case TAGS.BINARY_20:
					decoded = readBytes(r, readInt20(r))
					break
				case TAGS.BINARY_32:
					decoded = readBytes(r, readInt(r, 4))
					break
				default:
					decoded = readString(r, tag)
					break
			}

			data = decoded
		}
	}

	return {
		tag: header,
		attrs,
		content: data
	}
}

export const decodeDecompressedBinaryNode = (
	buffer: Buffer,
	opts: DecodeOpts,
	indexRef: { index: number } = { index: 0 }
): BinaryNode => readNode({ buffer, indexRef, opts })

export const decodeBinaryNodeJS = async (buff: Buffer): Promise<BinaryNode> => {
	const decompBuff = await decompressingIfRequired(buff)
	return decodeDecompressedBinaryNode(decompBuff, constants)
}

rustCodec.setReference(frame => decodeDecompressedBinaryNode(frame.subarray(1), constants))

export const decodeBinaryNode = async (buff: Buffer): Promise<BinaryNode> => {
	const fast = rustCodec.tryDecode(buff)
	if (fast) {
		return fast
	}

	return decodeBinaryNodeJS(buff)
						   }
