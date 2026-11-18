import { proto } from '../../WAProto/index.js'
import type { WAMessageContent } from '../Types'
import { getContentType, normalizeMessageContent } from './messages'

export const hasValidAlbumMedia = (message: proto.IMessage): boolean =>
	!!(message.imageMessage || message.videoMessage)

export const markViewOnce = (message: proto.IMessage): void => {
	const type = getContentType(message)
	if (!type) {
		return
	}

	const content = message[type]
	if (!content || typeof content !== 'object') {
		return
	}

	const MessageType = (proto.Message as unknown as Record<string, { prototype?: object } | undefined>)[
		type.charAt(0).toUpperCase() + type.slice(1)
	]
	if (!MessageType?.prototype || !('viewOnce' in MessageType.prototype)) {
		return
	}

	;(content as { viewOnce?: boolean }).viewOnce = true
}

export const isViewOnceMessage = (message: proto.IMessage | WAMessageContent | null | undefined): boolean => {
	if (
		(message as { viewOnce?: boolean } | null | undefined)?.viewOnce === true ||
		message?.viewOnceMessage ||
		message?.viewOnceMessageV2 ||
		message?.viewOnceMessageV2Extension
	) {
		return true
	}

	const inner = normalizeMessageContent(message)
	const type = getContentType(inner)
	const content = type ? (inner as Record<string, { viewOnce?: boolean } | undefined>)?.[type] : undefined
	return content?.viewOnce === true
}
