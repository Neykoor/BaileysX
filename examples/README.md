# Ejemplos BaileysX

## 1) Auth con SQLite cifrada
```ts
import makeWASocket, { useSqliteAuthState } from '@neykoor/baileys'

const { state, saveCreds } = await useSqliteAuthState({
	dbPath: './auth.db',
	passphrase: process.env.BAILEYS_AUTH_PASSPHRASE!
})

const sock = makeWASocket({ auth: state })
sock.ev.on('creds.update', saveCreds)
```

## 2) Store SQLite + búsqueda
```ts
import makeWASocket, { makeSqliteStore } from '@neykoor/baileys'

const store = await makeSqliteStore({ dbPath: './store.db' })
const sock = makeWASocket({})

sock.ev.on('messages.upsert', ({ messages }) => {
	const res = store.messages.search('presupuesto', { limit: 10 })
	console.log(res)
})
```

## 3) SessionManager multi-sesión
```ts
import { makeSessionManager } from '@neykoor/baileys'

const manager = makeSessionManager({
	baseAuthDir: './sessions',
	storage: 'sqlite',
	passphrase: process.env.BAILEYS_AUTH_PASSPHRASE,
	autoReconnect: true
})

const entry = await manager.start('bot-1')
entry.sock.sendMessage('123@s.whatsapp.net', { text: 'hola' })
```

## 4) Plugins
```ts
import makeWASocket, { definePlugin, makePluginManager } from '@neykoor/baileys'

const sock = makeWASocket({})
const manager = makePluginManager({ sock })

const echo = definePlugin({
	name: 'echo',
	hooks: {
		onMessage: async ctx => {
			if (ctx.text === 'ping') await ctx.reply({ text: 'pong' })
		}
	}
})

await manager.register(echo)
```

## 5) Botones interactivos
```ts
await sock.sendMessage(jid, {
	image: { url: './menu.jpg' },
	caption: 'Elige opción',
	title: 'Menú',
	buttons: [
		{ text: 'Comandos', id: '.menu' },
		{ text: 'Web', url: 'https://example.com' }
	]
})
```
