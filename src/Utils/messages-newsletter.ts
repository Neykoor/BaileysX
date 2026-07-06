import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage } from '../Types'

function nl(jid: string): string {
	return jid.endsWith('@newsletter') ? jid : `${jid}@newsletter`
}

export interface NewsletterSendCapableSocket {
	sendMessage: (jid: string, content: AnyMessageContent, options?: MiscMessageGenerationOptions) => Promise<WAMessage | undefined>
	newsletterReactMessage: (jid: string, serverId: string, reaction?: string) => Promise<void>
}

export function makeNewsletterUtils(conn: NewsletterSendCapableSocket) {
	async function send(jid: string, content: AnyMessageContent, options: MiscMessageGenerationOptions = {}) {
		return conn.sendMessage(nl(jid), content, options)
	}

	async function sendNewsletterText(jid: string, text: string, options: MiscMessageGenerationOptions = {}) {
		return send(jid, { text }, options)
	}

	async function sendNewsletterImage(
		jid: string,
		image: AnyMessageContent extends { image: infer I } ? I : never,
		options: MiscMessageGenerationOptions & { caption?: string; mimetype?: string; jpegThumbnail?: Buffer } = {}
	) {
		return send(jid, { image, caption: options.caption, mimetype: options.mimetype, jpegThumbnail: options.jpegThumbnail } as AnyMessageContent, options)
	}

	async function sendNewsletterVideo(
		jid: string,
		video: unknown,
		options: MiscMessageGenerationOptions & { caption?: string; mimetype?: string; gifPlayback?: boolean } = {}
	) {
		return send(
			jid,
			{ video, caption: options.caption, mimetype: options.mimetype, gifPlayback: options.gifPlayback } as unknown as AnyMessageContent,
			options
		)
	}

	async function sendNewsletterPtv(jid: string, video: unknown, options: MiscMessageGenerationOptions & { mimetype?: string } = {}) {
		return send(jid, { video, ptv: true, mimetype: options.mimetype || 'video/mp4' } as unknown as AnyMessageContent, options)
	}

	async function sendNewsletterAudio(
		jid: string,
		audio: unknown,
		options: MiscMessageGenerationOptions & { mimetype?: string; seconds?: number; ptt?: boolean } = {}
	) {
		return send(jid, { audio, mimetype: options.mimetype, seconds: options.seconds, ptt: options.ptt } as unknown as AnyMessageContent, options)
	}

	async function sendNewsletterDocument(
		jid: string,
		document: unknown,
		options: MiscMessageGenerationOptions & { mimetype?: string; fileName?: string; caption?: string } = {}
	) {
		return send(
			jid,
			{
				document,
				mimetype: options.mimetype || 'application/octet-stream',
				fileName: options.fileName || 'file',
				caption: options.caption
			} as unknown as AnyMessageContent,
			options
		)
	}

	async function sendNewsletterSticker(jid: string, sticker: unknown, options: MiscMessageGenerationOptions & { isAnimated?: boolean } = {}) {
		return send(jid, { sticker, isAnimated: options.isAnimated } as unknown as AnyMessageContent, options)
	}

	async function sendNewsletterReact(jid: string, serverId: string, emoji?: string) {
		return conn.newsletterReactMessage(nl(jid), serverId, emoji)
	}

	async function editNewsletterMessage(jid: string, messageId: string, newText: string) {
		return send(jid, {
			text: newText,
			edit: { remoteJid: nl(jid), fromMe: true, id: messageId }
		} as unknown as AnyMessageContent)
	}

	async function deleteNewsletterMessage(jid: string, messageId: string) {
		return send(jid, {
			delete: { remoteJid: nl(jid), fromMe: true, id: messageId }
		} as unknown as AnyMessageContent)
	}

	return {
		sendNewsletterText,
		sendNewsletterImage,
		sendNewsletterVideo,
		sendNewsletterPtv,
		sendNewsletterAudio,
		sendNewsletterDocument,
		sendNewsletterSticker,
		sendNewsletterReact,
		editNewsletterMessage,
		deleteNewsletterMessage
	}
}
