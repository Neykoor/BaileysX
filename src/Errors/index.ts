export type BaileysErrorCode =
	| 'AUTH_FAILURE'
	| 'CONNECTION_CLOSED'
	| 'CONNECTION_LOST'
	| 'RATE_LIMIT'
	| 'TIMEOUT'
	| 'UNKNOWN'
	| 'NOT_CONNECTED'
	| 'BAD_REQUEST'
	| 'SESSION_EXPIRED'
	| 'MESSAGE_SEND_FAILED'

export class BaileysError extends Error {
	code: BaileysErrorCode
	statusCode?: number
	data?: unknown

	constructor(message: string, code: BaileysErrorCode = 'UNKNOWN', data?: unknown) {
		super(message)
		this.name = 'BaileysError'
		this.code = code
		this.data = data
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, BaileysError)
		}
	}
}

export const isBaileysError = (err: unknown): err is BaileysError => err instanceof BaileysError
