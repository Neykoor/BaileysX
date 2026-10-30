import { makeBotRouter, type BotCommand } from '../bot/router'
import { makePluginManager } from '../plugins'
import type { Plugin } from '../plugins'

export type BotPluginOptions = {
	router: ReturnType<typeof makeBotRouter>
	prefix?: string
}

export const withBotCommands = (opts: BotPluginOptions) => {
	const router = opts.router
	return (plugin: Plugin): Plugin => {
		const orig = plugin.hooks?.onMessage
		plugin.hooks = plugin.hooks || {}
		plugin.hooks.onMessage = async ctx => {
			const handled = await router.handle(ctx)
			if (handled) return
			if (orig) await orig(ctx as any)
		}
		return plugin
	}
}

export const defineBotPlugin = (plugin: Plugin & { commands?: BotCommand[] }, router: ReturnType<typeof makeBotRouter>) => {
	if (plugin.commands) {
		for (const c of plugin.commands) {
			router.register(c)
		}
	}
	return plugin
}
