import { BaileysError } from '../Errors'

export const wrapError = (err: unknown, code: any = 'UNKNOWN'): BaileysError => {
	if (err instanceof BaileysError) return err
	if (err instanceof Error) return new BaileysError(err.message, code)
	return new BaileysError(String(err), code)
}

export const getErrorCode = (err: unknown): number | undefined => {
	const e: any = err
	return e?.output?.statusCode || e?.statusCode || e?.code
}

export const isNetworkError = (err: unknown) => {
	const e: any = err
	const msg = e?.message || ''
	return /network|timeout|ECONN|ENOTFOUND|socket/i.test(msg)
}

export const isRateLimited = (err: unknown) => getErrorCode(err) === 429
export const isUnauthorized = (err: unknown) => getErrorCode(err) === 401
export const isForbidden = (err: unknown) => getErrorCode(err) === 403
