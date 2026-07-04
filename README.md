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

Este `BaileysX` viene adaptado para consumir [`libsignal-node`](https://github.com/Neykoor/libsignal-node) (el port 100% TypeScript de `libsignal-node`) directamente **por Git**, en lugar del fork `this-xys/libsignal-node`.

Como ese repo **no está publicado en npm**, la dependencia se declara apuntando al repositorio de Git:

```json
"dependencies": {
  "libsignal": "git+https://github.com/Neykoor/libsignal-node.git"
}
```

npm sigue usando el alias `libsignal` como nombre de carpeta en `node_modules` (es la clave del `package.json`, no el `name` interno del paquete), así que todo el código que hace `import ... from 'libsignal'` sigue funcionando sin tocar el resto del proyecto.

## 🔧 Cambios de compatibilidad aplicados

`libsignal-node-ts` no expone todo por el barrel `index.ts` (por ejemplo `protobufs`, `curve` y `crypto` internos no se re-exportan), así que los imports que antes apuntaban al código fuente sin compilar (`libsignal/src/...`) ahora apuntan al build compilado (`libsignal/lib/...js`), que es lo que realmente existe una vez instalado el paquete:

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

## ⚠️ Requisito en el repo `libsignal-node`

Como el paquete se instala directo desde Git (no desde un tarball de npm), **no trae compilado el `lib/`**. Para que `npm install` funcione, el repo `Neykoor/libsignal-node` necesita un script `prepare` que compile al instalarse, y además arreglar las rutas relativas para que tengan extensión `.js` (Node ESM las exige en tiempo de ejecución):

```json
"scripts": {
  "build": "tsc -P tsconfig.json && tsc-esm-fix --tsconfig=tsconfig.json --ext=.js",
  "prepare": "npm run build"
},
"devDependencies": {
  "tsc-esm-fix": "^3.1.2"
}
```

Este repo incluye ese parche listo en la carpeta [`libsignal-node-patch/`](../libsignal-node-patch) — solo hay que aplicar ese `package.json` sobre `Neykoor/libsignal-node` y subirlo. Sin ese cambio, `npm install` en BaileysX fallará porque `lib/index.js` no existirá.

## 🚀 Instalación

```bash
npm install git+https://github.com/Neykoor/BaileysX.git
```

Esto instalará automáticamente `libsignal` desde `git+https://github.com/Neykoor/libsignal-node.git` como dependencia transitiva.

Si vienes de una instalación previa con el fork viejo, borra el lockfile y `node_modules` de libsignal antes de reinstalar:

```bash
rm -rf node_modules/libsignal package-lock.json
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

Compila `tsc -P tsconfig.build.json` y corre `tsc-esm-fix` sobre el propio BaileysX; si la instalación de `libsignal` generó bien su `lib/`, el build no debería marcar errores de tipos ni de resolución de módulos.

---

<div align="center">
Hecho con ☕ para el ecosistema <b>Eris-MD</b> / <b>BaileysX</b>
</div>
