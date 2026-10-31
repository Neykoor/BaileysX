<div align="center">

# BaileysX

<img src="./assets/banner.png" alt="BaileysX banner" width="100%" />

**Librería de WebSockets para WhatsApp Web, con [`libsignal-node-ts`](https://github.com/Neykoor/libsignal-node) como backend de Signal Protocol**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![ESM](https://img.shields.io/badge/Module-ESM-yellow)](https://nodejs.org/api/esm.html)
[![Node](https://img.shields.io/badge/Node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue)](./LICENSE)
[![Version](https://img.shields.io/badge/Version-8.0.2--rc18-success)](https://www.npmjs.com/package/@neykoor/baileys)

</div>

---

## Qué es BaileysX

`BaileysX` es un fork de [Baileys](https://github.com/WhiskeySockets/Baileys) mantenido por [Neykoor](https://github.com/Neykoor). Mantiene la API de `makeWASocket` y agrega utilidades opcionales para producción: middleware, métricas, persistencia SQLite/Redis/Postgres, scheduler, plugins, rate limiting, multi-sesión y más.

- Paquete npm: **`@neykoor/baileys`**
- CLI: **`baileysx`**
- Módulo **ESM** (no CommonJS)
- Requiere **Node.js 20 o superior**

## Instalación

```bash
npm install @neykoor/baileys
```

Dependencias opcionales (se instalan solo si usás la función correspondiente):

```bash
# Persistencia SQLite
npm install infinitysqlite

# Procesamiento de media
npm install sharp jimp @napi-rs/image

# Audio y previews de links
npm install audio-decode link-preview-js
```

`sharp`, `jimp`, `@napi-rs/image`, `audio-decode`, `link-preview-js` e `infinitysqlite` son `peerDependencies` opcionales. Si faltan, solo falla la función que las necesita, no la instalación ni el build.

## Uso básico

```ts
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@neykoor/baileys'

const { state, saveCreds } = await useMultiFileAuthState('./auth_info')
const sock = makeWASocket({ auth: state })

sock.ev.on('creds.update', saveCreds)

sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
  if (connection === 'open') {
    console.log('Conectado a WhatsApp')
  }

  if (connection === 'close') {
    const statusCode = (lastDisconnect?.error as any)?.output?.statusCode
    const shouldReconnect = statusCode !== DisconnectReason.loggedOut
    console.log('Conexión cerrada', statusCode, 'reconectar:', shouldReconnect)
  }
})

sock.ev.on('messages.upsert', async ({ messages, type }) => {
  if (type !== 'notify') return

  for (const msg of messages) {
    const text = msg.message?.conversation
    if (text === 'ping') {
      await sock.sendMessage(msg.key.remoteJid!, { text: 'pong' })
    }
  }
})
```

Para mostrar el QR, escuchá `connection.update` y renderizá el valor de `qr` con tu librería preferida. `printQRInTerminal` sigue existiendo, pero está deprecado.

## Autenticación

### Archivos

```ts
import { useMultiFileAuthState } from '@neykoor/baileys'

const { state, saveCreds } = await useMultiFileAuthState('./auth_info')
```

### SQLite cifrado (AES-256-GCM)

```ts
import { useSqliteAuthState } from '@neykoor/baileys'

const auth = await useSqliteAuthState({
  dbPath: './auth.db',
  passphrase: process.env.BAILEYS_AUTH_PASSPHRASE!
})

auth.saveCreds()
auth.backupTo('./auth-backup.db') // el backup sigue cifrado
auth.rekey('nueva-passphrase')    // rota la clave sin perder datos
auth.close()
```

La clave se deriva con `scrypt` y una salt aleatoria por base. Las bases antiguas en texto plano se migran automáticamente al abrir con `passphrase`.

### Redis y Postgres

```ts
import { useRedisAuthState, usePostgresAuthState } from '@neykoor/baileys'

const redisAuth = await useRedisAuthState({ client: redis, prefix: 'bot:auth' })
const pgAuth = await usePostgresAuthState({ client: pool, table: 'wa_auth' })
```

También se exportan `makeRedisAuthStorage` y `makePostgresAuthStorage` para construir el storage manualmente.

## Store y búsqueda en SQLite

```ts
import makeWASocket, { makeSqliteStore } from '@neykoor/baileys'

const store = await makeSqliteStore({ dbPath: './store.db' })
const sock = makeWASocket({ auth })

store.bind(sock.ev)

store.messages.search('presupuesto', { jid, limit: 20 })
store.messages.prune({ jid, olderThan: new Date(Date.now() - 90 * 86400_000) })
store.messages.prune({ jid, keepLatest: 1000 })
store.messages.count(jid)

store.rebuildSearchIndex()
store.backupTo('./backup.db')
store.close()
```

La búsqueda usa FTS5 cuando está disponible y cae automáticamente a `LIKE` en builds de SQLite sin FTS5. El índice se reconstruye al abrir bases existentes.

## Botones interactivos

`sock.sendMessage` detecta la propiedad `buttons` y arma un `interactiveMessage` con `nativeFlowMessage` automáticamente:

```ts
await sock.sendMessage(jid, {
  image: { url: './media/menu.jpg' },
  caption: 'Elegí una opción:',
  title: 'Menú',
  subtitle: 'BaileysX',
  footer: 'Neykoor',
  buttons: [
    { text: 'Ver comandos', id: '.menu' },
    { text: 'Mi perfil', id: '.perfil' },
    { text: 'Canal oficial', url: 'https://whatsapp.com/channel/0029Vb7NOUpF1YlXOQHW6d3O' }
  ]
}, { quoted: msg })
```

| Propiedad | Tipo generado | Comportamiento |
|---|---|---|
| `id` | `quick_reply` | Envía el `id` como si el usuario lo hubiera escrito |
| `url` | `cta_url` | Abre el link |
| `call` | `cta_call` | Inicia una llamada |
| `copy` | `cta_copy` | Copia texto al portapapeles |
| `sections` | `single_select` | Lista desplegable con secciones |

El header acepta `text` o media (`image`, `video`, `document`) con `caption`. Si no se pasa ninguno, se lanza un error.

## Capacidades nuevas (8.0.2-rc18)

Todas las APIs son opcionales y compatibles con el uso existente de `makeWASocket`.

### Middleware entrante y saliente

```ts
const offIncoming = sock.use(async ({ jid, message, stop }) => {
  if (message.message?.conversation === '/ignore') {
    stop()
  }
})

sock.useOutgoing(({ content, stop }) => {
  if (typeof content === 'object' && 'text' in content) {
    content.text = content.text.trim()
  }
})

offIncoming()
```

Los errores de un middleware se registran y no interrumpen el resto de la cadena.

### Salud y métricas

```ts
sock.getHealth()
// { status, connected, uptimeMs, connectedForMs, counters, retries, scheduler, mediaCache }

sock.getMetrics()
```

### Caché de descargas de media

```ts
const buffer = await sock.downloadMedia(message, { startByte: 0 })
sock.mediaCache.size()
sock.mediaCache.clear()
```

Es un LRU con deduplicación de descargas concurrentes. Se configura con `mediaDownloadCache: { maxItems, maxBytes }` en `makeWASocket`.

### Scheduler persistente

```ts
import { makeSqliteScheduledMessageStore } from '@neykoor/baileys'

const scheduledStore = await makeSqliteScheduledMessageStore({ dbPath: './outbox.db' })
const sock = makeWASocket({
  scheduledMessageStore: scheduledStore,
  schedulerOptions: { checkInterval: 1000 }
})

sock.scheduleMessage(jid, { text: 'recordatorio' }, new Date(Date.now() + 60_000))
await sock.messageScheduler.restore()
```

`MessageScheduler.schedule()` es síncrono. La persistencia es write-behind y `restore()` recupera los pendientes después de reiniciar. `getStats()` devuelve `{ pending, restored, persistent }`.

### Rate limiting

```ts
import { createRateLimiter, createRateLimitMiddleware } from '@neykoor/baileys'

const limiter = createRateLimiter({
  global: { capacity: 30, refillTokens: 1, refillIntervalMs: 1000 },
  perJid: { capacity: 5, refillTokens: 1, refillIntervalMs: 1000 }
})

sock.useOutgoing(createRateLimitMiddleware(limiter))
```

También podés usar `limiter.acquire(jid)` o `limiter.tryAcquire(jid)` directamente.

### SessionManager y reconexión

```ts
import { makeSessionManager } from '@neykoor/baileys'

const manager = makeSessionManager({
  baseAuthDir: './sessions',
  storage: 'sqlite',
  passphrase: process.env.BAILEYS_AUTH_PASSPHRASE,
  autoReconnect: true,
  config: { logger }
})

const entry = await manager.start('bot-1')
entry.sock.sendMessage(jid, { text: 'hola' })
manager.getHealth()
await manager.stop('bot-1')
await manager.stopAll()
```

`makeSessionManager` valida los IDs, soporta auth en archivos o SQLite y expone `getHealth()`. `makeResilientSocket` usa `ConnectionWatchdog` para backoff exponencial, códigos terminales y cooldown ante rate limits. La detección de sockets zombie es opt-in con `enableLiveness: true`.

### Plugins

```ts
import { definePlugin, makePluginManager } from '@neykoor/baileys'

const manager = makePluginManager({ sock })

await manager.register(definePlugin({
  name: 'echo',
  hooks: {
    onMessage: async ctx => {
      if (ctx.text === 'ping') await ctx.reply({ text: 'pong' })
    }
  }
}))
```

Los hooks son `onLoad`, `onUnload`, `onMessage`, `onConnectionUpdate` y `onCredsUpdate`. Un hook que lanza se registra y no afecta a los demás plugins.

### Router de comandos

```ts
import { makeCommandRouter } from '@neykoor/baileys'

const router = makeCommandRouter({
  prefix: ['.', '/'],
  sendMessage: (jid, content, options) => sock.sendMessage(jid, content, options)
})

router.use({
  name: 'ping',
  aliases: ['p'],
  description: 'Responde pong',
  cooldownMs: 3000,
  handler: async ctx => ctx.reply({ text: 'pong' })
})

sock.use(router.middleware())
```

Soporta aliases, permisos, cooldowns y `stopOnCommand`.

### Idempotencia y reintentos

```ts
import {
  InMemoryIdempotencyStore,
  makeIdempotencyGuard,
  createIncomingDedupeMiddleware,
  createOutgoingIdempotencyMiddleware,
  withRetry,
  RetryQueue
} from '@neykoor/baileys'

const store = new InMemoryIdempotencyStore()
const guard = makeIdempotencyGuard({ store })

await guard.runOnce('job:1', async () => doWork())

sock.use(createIncomingDedupeMiddleware({ store }))
sock.useOutgoing(createOutgoingIdempotencyMiddleware({ store }))

await withRetry(() => sendSomething(), { maxAttempts: 5 })
```

### Media storage local o S3

```ts
import { makeLocalMediaStorage, makeS3MediaStorage } from '@neykoor/baileys'

const local = await makeLocalMediaStorage({ dir: './media' })
const s3 = makeS3MediaStorage({ client: s3Client, bucket: 'mi-bucket', prefix: 'wa/' })

await local.put('images/1.jpg', bytes, { contentType: 'image/jpeg' })
const data = await local.get('images/1.jpg')
await local.delete('images/1.jpg')
```

### Auditoría, tenants y observabilidad

```ts
import {
  makeAuditLog,
  makeMemoryAuditSink,
  makeTenantManager,
  createPrometheusExporter,
  createHttpGateway
} from '@neykoor/baileys'

const auditSink = makeMemoryAuditSink()
const audit = makeAuditLog({ sink: auditSink.sink })

const tenants = makeTenantManager({
  baseAuthDir: './tenants',
  limits: { maxSessions: 5, maxMessagesPerMinute: 60 },
  audit
})

const exporter = createPrometheusExporter({ sock })
exporter.render()

const gateway = createHttpGateway({ sock, port: 3000, token: process.env.API_TOKEN })
await gateway.start()
```

`createHttpGateway` expone `/health`, `/metrics`, `/webhook`, `/send` y un dashboard básico. Las rutas de API aceptan `Authorization: Bearer <token>` o `x-api-key`. Sin `token`, `POST /send` responde 403 salvo que pases `allowUnauthenticatedSend: true`; `/send` exige `content-type: application/json`. No se envían cabeceras CORS salvo que definas `corsOrigin`.

### Record/replay y socket falso para tests

```ts
import { recordEvents, replayEvents, makeFakeWASocket } from '@neykoor/baileys'

const { recording, stop } = recordEvents(sock.ev, { events: ['messages.upsert'] })
// ...ejecutar escenario...
stop()

await replayEvents(sock.ev, recording, { speed: 0 })

const fake = makeFakeWASocket()
await fake.sendMessage(jid, { text: 'hola' })
fake.sentMessages // mensajes capturados
```

## CLI

El binario `baileysx` habla con un `createHttpGateway` en ejecución:

```bash
baileysx health  --url http://127.0.0.1:3000 --token $BAILEYSX_TOKEN
baileysx metrics --url http://127.0.0.1:3000
baileysx webhook --body '{"event":"ping"}'
baileysx send    --jid 123@s.whatsapp.net --text "hola"
```

Variables de entorno: `BAILEYSX_GATEWAY_URL` y `BAILEYSX_TOKEN`.

## Compatibilidad con libsignal

`BaileysX` consume [`libsignal-node-ts`](https://www.npmjs.com/package/@neykoor/libsignal-node), el port 100% TypeScript de `libsignal-node`.

Los deep imports apuntan al build compilado que existe una vez instalado el paquete:

| Antes | Ahora |
|---|---|
| `libsignal/src/curve` | `libsignal/lib/curve.js` |
| `libsignal/src/crypto` | `libsignal/lib/crypto.js` |
| `libsignal/src/protobufs` | `libsignal/lib/protobufs.js` |

La API principal (`ProtocolAddress`, `SessionBuilder`, `SessionCipher`, `SessionRecord`, `keyhelper`, `curve`) se sigue importando con `import * as libsignal from 'libsignal'`.

### Verificación de la integración

```bash
npm install --ignore-scripts
npm run build
npm run smoke:signal
```

El smoke test cubre sesiones 1:1, respuestas, cambio de identidad y envío/recepción de mensajes de grupo. Para probar cambios locales del port antes de publicarlos:

```bash
npm install --no-save --ignore-scripts file:../libsignal-node-main
```

## Desarrollo

```bash
npm install --ignore-scripts
npm run build        # compila src/ a lib/
npm run test:unit    # ejecuta la suite con node:test
npm test             # build + test:unit
npm run test:coverage
```

`npm run test:coverage` usa `c8` y exige umbrales mínimos sobre los módulos críticos: 85% de líneas y funciones, 75% de branches y 80% de statements. El workflow de CI (`.github/workflows/ci.yml`) ejecuta typecheck, tests y smoke en Node 20, 22 y 24.

## Créditos

BaileysX es un fork de Baileys, la librería original mantenida por la comunidad de WhiskeySockets. Gran parte de la base de este proyecto —el manejo del protocolo de WhatsApp Web, el cifrado, la arquitectura del socket y la mayoría del código— proviene de ese trabajo original.

<div align="center">

| <img src="https://github.com/WhiskeySockets.png" width="80" /><br>**WhiskeySockets**<br>Autor original de Baileys<br>[GitHub](https://github.com/WhiskeySockets) | <img src="https://github.com/Neykoor.png" width="80" /><br>**Neykoor**<br>Mantenido y extendido<br>[GitHub](https://github.com/Neykoor) |
|:---:|:---:|

</div>

- Repositorio original: https://github.com/WhiskeySockets/Baileys
- Licencia: MIT

Si esta librería te resulta útil, considerá dar reconocimiento y apoyo al proyecto original.
