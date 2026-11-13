import * as rawBridge from 'whatsapp-rust-bridge'

export type WasmNode = {
	tag: string
	attrs: Record<string, string>
	content?: WasmNode[] | Uint8Array | string | null
	free?: () => void
}

export type RustBridge = {
	encodeNode?: (node: unknown) => Uint8Array
	decodeNode?: (buffer: Uint8Array) => WasmNode
}

type Env = Record<string, string | undefined>

const OFF_VALUES = new Set(['0', 'false', 'off', 'no'])
const ON_VALUES = new Set(['1', 'true', 'on', 'yes'])

const readFlag = (env: Env, name: string): boolean | undefined => {
	const value = env[name]
	if (value === undefined) {
		return undefined
	}

	const normalized = value.trim().toLowerCase()
	if (OFF_VALUES.has(normalized)) {
		return false
	}

	if (ON_VALUES.has(normalized)) {
		return true
	}

	return undefined
}

const currentEnv = (): Env => (typeof process !== 'undefined' && process.env ? process.env : {})

export const isRustAreaEnabled = (area: string, env: Env = currentEnv()): boolean =>
	readFlag(env, `BAILEYS_RUST_${area}`) ?? readFlag(env, 'BAILEYS_RUST') ?? false

export const getRustBridge = (): RustBridge => rawBridge as unknown as RustBridge
