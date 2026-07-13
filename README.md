<div align="center">

# BaileysX

**Librería de WebSockets para WhatsApp Web, con [`libsignal-node-ts`](https://github.com/Neykoor/libsignal-node) como backend de Signal Protocol**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![ESM](https://img.shields.io/badge/Module-ESM-yellow)](https://nodejs.org/api/esm.html)
[![Node](https://img.shields.io/badge/Node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue)](./LICENSE)
[![Status](https://img.shields.io/badge/Estado-Estable-success)]()

</div>

---

## ✨ ¿Qué cambió en este paquete?

`BaileysX` consume [`libsignal-node-ts`](https://www.npmjs.com/package/libsignal-node-ts) (el port 100% TypeScript de `libsignal-node`) directamente desde el **registro de npm**, en lugar del fork `this-xys/libsignal-node`.

La dependencia se declara con un alias de npm, para que el resto del código siga usando el nombre corto `libsignal`:

```json
"dependencies": {
  "libsignal": "npm:libsignal-node-ts@^1.0.0"
}
```

npm usa la clave `libsignal` como nombre de carpeta en `node_modules` (no el `name` interno del paquete), así que todo el código que hace `import ... from 'libsignal'` funciona sin tocar el resto del proyecto. Al venir del registro normal en vez de Git, la instalación funciona también en hosts que bloquean fetch de paquetes por git o por tarball remoto.

## 🔧 Cambios de compatibilidad aplicados

`libsignal-node-ts` no expone todo por el barrel `index.ts` (por ejemplo `protobufs`, `curve` y `crypto` internos no se re-exportan), así que algunos imports que antes apuntaban al código fuente sin compilar (`libsignal/src/...`) ahora apuntan al build compilado (`libsignal/lib/...js`), que es lo que realmente existe una vez instalado el paquete:

| Antes | Ahora |
|---|---|
| `libsignal/src/curve` | `libsignal/lib/curve.js` |
| `libsignal/src/crypto` | `libsignal/lib/crypto.js` |
| `libsignal/src/protobufs` | `libsignal/lib/protobufs.js` |

Archivos tocados:

- `src/Utils/crypto.ts`
- `src/Signal/libsignal.ts`
- `src/Signal/Group/keyhelper.ts`
- `src/Signal/Group/sender-message-key.ts`
- `src/Signal/Group/sender-key-message.ts`
- `src/Signal/Group/sender-chain-key.ts`
- `src/Signal/Group/group_cipher.ts`
- `package.json` → dependencia `libsignal`

El resto de la API (`ProtocolAddress`, `SessionBuilder`, `SessionCipher`, `SessionRecord`, `keyhelper`, `curve`) se sigue importando igual con `import * as libsignal from 'libsignal'`, porque esos sí están exportados desde el `index.ts` del paquete.

## 🚀 Instalación

```bash
npm install baileysx
```

Esto instala automáticamente `libsignal-node-ts` desde el registro de npm como dependencia transitiva, ya compilado — no requiere Git ni ningún paso extra.

Si vienes de una instalación previa con el fork viejo o con la dependencia por Git, borra el lockfile y `node_modules` antes de reinstalar:

```bash
rm -rf node_modules package-lock.json
npm install
```

## 📖 Uso básico

```ts
import makeWASocket from 'baileysx'

const sock = makeWASocket({
  // tu configuración
})

sock.ev.on('connection.update', (update) => {
  console.log(update)
})
```

Internamente, `sock` usa `makeLibSignalRepository` (`src/Signal/libsignal.ts`) para cifrar/descifrar sesiones y mensajes de grupo con `libsignal-node-ts`, con el mismo API que antes.

## 🧪 Verificación

```bash
npm run build
```

Compila `tsc -P tsconfig.build.json` y corre `tsc-esm-fix` sobre el propio BaileysX; si la instalación de `libsignal` resolvió bien su `lib/`, el build no debería marcar errores de tipos ni de resolución de módulos.

---

<div align="center">
Hecho con ☕ para el ecosistema <b>Eris-MD</b> / <b>BaileysX</b>
</div>
