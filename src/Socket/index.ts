import { DEFAULT_CONNECTION_CONFIG } from '../Defaults'
import type { MediaDownloadOptions } from '../Utils/messages-media'
import type { WAMessage } from '../Types/Message'
import type { UserFacingSocketConfig } from '../Types'
import { installConsoleFilter } from '../Utils/console-filter'
import { printBanner } from '../Utils/banner'
import { makeMediaCache } from '../Utils/media-cache'
import { makeCommunitiesSocket } from './communities'


const makeWASocket = (config: UserFacingSocketConfig) => {
	installConsoleFilter()
	printBanner()

	const newConfig = {
		...DEFAULT_CONNECTION_CONFIG,
		...config
	}

	if (config.version && config.syncWaWebVersion === undefined) {
		newConfig.syncWaWebVersion = false
	}

	if (!newConfig.version) {
		newConfig.version = DEFAULT_CONNECTION_CONFIG.version
	}

	const sock = makeCommunitiesSocket(newConfig)

	const mediaCache = makeMediaCache({
		...newConfig.mediaDownloadCache,
		logger: newConfig.logger,
		reuploadRequest: message => sock.updateMediaMessage(message)
	})

	const getMetrics = () => ({
		...sock.metrics.snapshot(),
		retries: sock.messageRetryManager?.getStatistics?.(),
		scheduler: sock.messageScheduler?.getStats?.(),
		mediaCache: {
			size: mediaCache.size()
		}
	})

	const getHealth = () => {
		const metrics = getMetrics()
		return {
			status: metrics.connection,
			connected: metrics.connection === 'open',
			uptimeMs: metrics.uptimeMs,
			connectedForMs: metrics.connectedForMs,
			lastActivityAt: metrics.lastActivityAt,
			counters: {
				messagesReceived: metrics.messagesReceived,
				messagesSent: metrics.messagesSent,
				sendFailures: metrics.sendFailures,
				messagesUpdated: metrics.messagesUpdated,
				messagesDeleted: metrics.messagesDeleted,
				mediaDownloads: metrics.mediaDownloads,
				connectionOpens: metrics.connectionOpens,
				disconnects: metrics.disconnects
			},
			retries: metrics.retries,
			scheduler: metrics.scheduler,
			mediaCache: metrics.mediaCache
		}
	}

	return Object.assign(sock, {
		mediaCache,
		downloadMedia: async (message: WAMessage, options: MediaDownloadOptions = {}) => {
			const buffer = await mediaCache.download(message, options)
			sock.metrics.recordMediaDownload()
			return buffer
		},
		getMetrics,
		getHealth
	})
}

export default makeWASocket
