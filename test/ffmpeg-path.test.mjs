import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
	ffmpegInstallHint,
	requireFfmpegPath,
	resetFfmpegPath,
	resolveFfmpegPath,
	setFfmpegPath
} from '../lib/Utils/ffmpeg-path.js'

describe('ffmpeg path resolution', () => {
	let savedEnv
	let savedPath

	beforeEach(() => {
		savedEnv = process.env.FFMPEG_PATH
		savedPath = process.env.PATH
		delete process.env.FFMPEG_PATH
		resetFfmpegPath()
	})

	afterEach(() => {
		if (savedEnv === undefined) delete process.env.FFMPEG_PATH
		else process.env.FFMPEG_PATH = savedEnv
		process.env.PATH = savedPath
		resetFfmpegPath()
	})

	it('prefers the path set with setFfmpegPath', async () => {
		process.env.FFMPEG_PATH = process.execPath
		setFfmpegPath('/custom/ffmpeg')
		assert.equal(await resolveFfmpegPath(), '/custom/ffmpeg')
		assert.equal(await requireFfmpegPath(), '/custom/ffmpeg')
	})

	it('uses FFMPEG_PATH when the file exists', async () => {
		process.env.FFMPEG_PATH = process.execPath
		assert.equal(await resolveFfmpegPath(), process.execPath)
	})

	it('ignores FFMPEG_PATH when the file does not exist', async () => {
		process.env.FFMPEG_PATH = join(tmpdir(), 'no-such-ffmpeg-binary')
		process.env.PATH = ''
		const resolved = await resolveFfmpegPath()
		assert.notEqual(resolved, process.env.FFMPEG_PATH)
	})

	it('finds an ffmpeg binary on PATH', { skip: process.platform === 'win32' }, async () => {
		const dir = mkdtempSync(join(tmpdir(), 'baileysx-ff-'))
		try {
			const bin = join(dir, 'ffmpeg')
			writeFileSync(bin, '#!/bin/sh\nexit 0\n')
			chmodSync(bin, 0o755)
			process.env.PATH = dir
			const resolved = await resolveFfmpegPath()
			assert.equal(typeof resolved, 'string')
			assert.ok(resolved.length > 0)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it('clears the override with setFfmpegPath(null)', async () => {
		setFfmpegPath('/custom/ffmpeg')
		setFfmpegPath(null)
		process.env.FFMPEG_PATH = process.execPath
		assert.equal(await resolveFfmpegPath(), process.execPath)
	})

	it('explains how to install ffmpeg', () => {
		const hint = ffmpegInstallHint()
		assert.match(hint, /ffmpeg not found/)
		assert.match(hint, /setFfmpegPath/)
		assert.match(hint, /FFMPEG_PATH/)
	})
})
