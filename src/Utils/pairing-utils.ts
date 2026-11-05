import type { BinaryNode } from '../WABinary'

type ErrorLike = {
	data?: unknown
	output?: { statusCode?: number }
	statusCode?: number
	status?: number
	message?: string
}

const asErrorLike = (error: unknown): ErrorLike =>
	typeof error === 'object' && error !== null ? (error as ErrorLike) : {}

const errorText = (error: unknown): string => String(asErrorLike(error).message || error)

export const normalizePairingCode = (value: unknown): string => {
	const normalized = String(value ?? '')
		.trim()
		.toUpperCase()
	return /^[A-Z0-9]{8}$/.test(normalized) ? normalized : ''
}

export const formatPairingCode = (code: unknown): string => {
	const value = String(code ?? '')
	return value.length === 8 ? `${value.slice(0, 4)}-${value.slice(4)}` : value
}

export const pairingErrorCode = (error: unknown): number | undefined => {
	const parsed = asErrorLike(error)
	const fromData = typeof parsed.data === 'number' ? parsed.data : undefined
	const status = parsed.output?.statusCode ?? parsed.statusCode ?? parsed.status
	return fromData ?? (status && status !== 500 ? status : undefined)
}

export const isRateLimitError = (error: unknown): boolean => {
	const code = pairingErrorCode(error)
	return code === 428 || code === 429 || /rate[- ]?overlimit|rate.?limit|too many/i.test(errorText(error))
}

export const isCustomPairingError = (error: unknown): boolean => {
	const code = pairingErrorCode(error)
	return (
		code === 422 ||
		/custom pairing code|pairing code.*(invalid|reject|unsupported)|invalid.*pairing/i.test(errorText(error))
	)
}

const SUPPORTED_PASSKEY_TYPES = new Set(['passkey_prologue_request', 'crsc_continuation'])

export const getPasskeyRequestState = (node: BinaryNode | undefined) => {
	const type = node?.attrs.type
	if (!type || !SUPPORTED_PASSKEY_TYPES.has(type)) {
		return undefined
	}

	const raw = node?.content
	const content = Array.isArray(raw) ? raw : []
	const hasOptions = content.some(item => item && typeof item === 'object' && 'tag' in item)
	return { type, hasOptions }
}
