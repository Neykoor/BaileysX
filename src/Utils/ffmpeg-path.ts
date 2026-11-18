import { spawnSync } from 'child_process'
import { existsSync } from 'fs'

let overridePath: string | null = null
let cached: string | null | undefined

const importOptional = (name: string): Promise<any> => import(name)

const moduleProvidedPath = async (): Promise<string | null> => {
	try {
		const mod = await importOptional('ffmpeg-static')
		const p = mod?.default ?? mod
		if (typeof p === 'string' && existsSync(p)) {
			return p
		}
	} catch {}

	try {
		const mod = await importOptional('@ffmpeg-installer/ffmpeg')
		const p = (mod?.default ?? mod)?.path
		if (typeof p === 'string' && existsSync(p)) {
			return p
		}
	} catch {}

	return null
}

const systemHasFfmpeg = () => {
	try {
		const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' })
		return !r.error && r.status === 0
	} catch {
		return false
	}
}

export const setFfmpegPath = (path: string | null | undefined) => {
	overridePath = path || null
	cached = undefined
}

export const resolveFfmpegPath = async (): Promise<string | null> => {
	if (overridePath) {
		return overridePath
	}

	const envPath = process.env.FFMPEG_PATH
	if (envPath && existsSync(envPath)) {
		return envPath
	}

	if (cached !== undefined) {
		return cached
	}

	cached = (await moduleProvidedPath()) ?? (systemHasFfmpeg() ? 'ffmpeg' : null)
	return cached
}

export const ffmpegInstallHint = () => {
	const lines = ['ffmpeg not found. Install one of:']
	const isAndroid =
		(process.platform as string) === 'android' ||
		!!process.env.TERMUX_VERSION ||
		existsSync('/data/data/com.termux')

	if (isAndroid) {
		lines.push('  - Termux:  pkg install ffmpeg')
	} else if (process.platform === 'linux') {
		lines.push('  - npm:     npm i ffmpeg-static')
		lines.push('  - Debian/Ubuntu:  sudo apt install ffmpeg')
	} else if (process.platform === 'darwin') {
		lines.push('  - npm:     npm i ffmpeg-static')
		lines.push('  - Homebrew:  brew install ffmpeg')
	} else if (process.platform === 'win32') {
		lines.push('  - npm:     npm i ffmpeg-static')
		lines.push('  - winget:  winget install ffmpeg')
	} else {
		lines.push('  - npm:     npm i ffmpeg-static')
		lines.push('  - or your system package manager')
	}

	lines.push("  - or pin a binary yourself: setFfmpegPath('/path/to/ffmpeg') / FFMPEG_PATH env var")
	return lines.join('\n')
}

export const requireFfmpegPath = async (): Promise<string> => {
	const path = await resolveFfmpegPath()
	if (path) {
		return path
	}

	throw new Error(ffmpegInstallHint())
}

export const resetFfmpegPath = () => {
	cached = undefined
	overridePath = null
}
