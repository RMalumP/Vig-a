# Vigía

Vigila páginas web y avisa cuando cambian: una convocatoria que se publica, un
precio que baja, un listado que estrena entradas. No hace falta cuenta ni
servidor propio.

Funciona de dos maneras, que se pueden combinar:

- **En el navegador** (`index.html`): abres la página, añades direcciones y las
  comprueba mientras la pestaña esté abierta.
- **En GitHub Actions** (`vigia/`): comprueba las páginas cada pocos minutos
  aunque tengas el ordenador apagado, y te avisa al móvil.

## Puesta en marcha

1. Haz un *fork* de este repositorio (o súbelo al tuyo).
2. Activa GitHub Pages: **Settings → Pages → Source: Deploy from a branch**,
   rama `main`, carpeta `/ (root)`.
3. Abre `https://TU-USUARIO.github.io/TU-REPO/` y empieza a añadir páginas.

Con eso ya funciona todo lo del navegador. Lo demás solo hace falta si quieres
vigilancia sin tener la pestaña abierta.

## Avisos al móvil

Cualquiera de los dos canales vale; puedes tener los dos.

**Telegram.** Habla con [@BotFather](https://t.me/BotFather), escribe
`/newbot` y guarda el token. Escríbele algo a tu bot nuevo y pulsa
«Detectar mi chat ID» en Vigía.

**ntfy.** Instala la app [ntfy](https://ntfy.sh), elige un tema con un nombre
difícil de adivinar (el botón «Generar tema seguro» lo hace por ti) y
suscríbete a él desde la app. Cualquiera que sepa el nombre del tema puede leer
tus avisos.

## Vigilancia sin tener el navegador abierto (GitHub Actions)

El workflow `.github/workflows/vigia.yml` se ejecuta cada 5 minutos y comprueba
las páginas que hayas marcado como «vigilar desde GitHub».

### 1. Crea un token

En GitHub, **Settings → Developer settings → Personal access tokens → Fine-grained
tokens → Generate new token**:

- *Repository access*: **Only select repositories** → este repositorio.
- *Permissions → Repository permissions*: **Actions: Read and write** y
  **Variables: Read and write**.
- Ponle una caducidad corta (90 días, por ejemplo) y renuévalo cuando toque.

### 2. Entra como propietario

Abre tu Vigía y añade `#propietario` al final de la dirección. Pega el token y
el nombre del repositorio. Si estás en un ordenador compartido, marca
**«No guardar el token en este equipo»**: se olvidará al cerrar la pestaña.

El token se queda en tu navegador y nunca sale de él salvo hacia `api.github.com`.

### 3. Crea los secretos

En **Settings → Secrets and variables → Actions → Secrets**:

| Secreto | Hace falta | Para qué |
|---|---|---|
| `VIGIA_CLAVE` | recomendado | Cifra el estado guardado. Vale cualquier texto largo al azar. |
| `TELEGRAM_TOKEN` | para Telegram | El token del bot. |
| `TELEGRAM_CHAT_ID` | para Telegram | Tu chat ID. |
| `NTFY_TOPIC` | para ntfy | El nombre del tema. |
| `NTFY_SERVER` | opcional | Solo si usas un servidor propio. |
| `NTFY_TOKEN` | opcional | Solo si tu servidor de ntfy pide identificación. |
| `NTFY_USER` / `NTFY_PASS` | opcional | Alternativa a `NTFY_TOKEN`. |

Las variables `VIGIA_CONFIG` y `VIGIA_ACTIVO` no las creas tú: las escribe Vigía
cuando pulsas **«Enviar lista a GitHub»**.

### 4. Envía la lista

Marca las páginas que quieras vigilar desde GitHub, pulsa «Enviar lista a
GitHub» y listo. En «Últimas ejecuciones» puedes ver si funciona.

#### Por qué conviene `VIGIA_CLAVE`

Para saber si una página ha cambiado, Vigía guarda su contenido entre
ejecuciones (en la caché de Actions). En un repositorio público esa caché la
puede leer cualquiera, así que el estado se guarda cifrado. `VIGIA_CLAVE` es la
clave de ese cifrado.

Si no lo creas, Vigía usa tu token de Telegram como clave para no dejar el
estado en claro, pero es mala idea reutilizar un secreto para dos cosas
distintas: si algún día cambias el token de Telegram, el estado guardado deja de
poder leerse. Crea un `VIGIA_CLAVE` propio y olvídate.

> Al crear o cambiar `VIGIA_CLAVE`, el estado anterior deja de poder leerse: la
> siguiente ejecución vuelve a tomar la referencia de cada página (una vuelta sin
> avisos) y sigue funcionando con normalidad a partir de ahí.

## Qué se puede vigilar

| Modo | Avisa cuando… |
|---|---|
| Información nueva | aparece texto que antes no estaba (ignora lo que desaparece). |
| Cualquier cambio | cambia cualquier cosa de la parte vigilada. |
| Enlaces nuevos | aparece un enlace que no estaba. |
| Un número | sube, baja o cruza un valor (precios, plazas, contadores). |

Los feeds RSS y Atom se detectan solos y avisan de cada entrada nueva.

Además, en cada página puedes afinar con: un **selector CSS** para mirar solo una
zona, **palabras clave** para que avise solo si aparecen, líneas a **ignorar**, y
un **horario** (con días laborables) para que no moleste de noche.

### Cuando una web avisa de cambios que no son cambios

Hay páginas que generan código distinto en cada carga (un `id` al azar en una
etiqueta, un `nonce`, un contador). Vigía lo detecta como cambio, porque lo es,
aunque a ti no te sirva de nada.

Cuando llegue uno de esos avisos, pulsa **«No avisar de cambios como este»**. Si
lo único que cambió está dentro del valor de un atributo, Vigía aprende a no
mirar *ese* atributo de *esa* etiqueta, y nada más: si esa misma etiqueta cambia
el `href`, o aparece contenido nuevo en la página, te sigue avisando igual. Los
filtros aprendidos se ven y se borran en **Ajustes** de cada página.

Si el ruido no está en un atributo sino en el texto, Vigía recurre a ignorar esas
líneas, y en ese caso descarta la regla si fuera a tragarse buena parte de la
página, para no dejarte sin vigilancia sin avisar.

#### Desde Telegram

Los avisos que llegan por Telegram llevan el mismo botón,
**«🔕 No avisar de cambios como este»**, tanto si los manda la página abierta en
el navegador como GitHub Actions. Al pulsarlo, el botón desaparece y el bot
responde con lo que ha aprendido y un botón **«↩️ Deshacer»**.

En los avisos de novedades («Haya información nueva», enlaces nuevos y feeds) el
botón es **«🔕 No avisar de novedades como esta»**: ignora la parte fija del
texto, hasta la primera cifra (de «Actualizado a las 10:32» aprende a ignorar
«Actualizado a las»). Solo aparece cuando esa parte fija es la mayor parte del
texto, para no tapar noticias de verdad que empiecen igual.

- **Avisos de la página del navegador**: la página pregunta a Telegram cada 20
  segundos si has pulsado algo. Si estaba cerrada, lo atiende al volver a
  abrirla (Telegram guarda las pulsaciones 24 horas). El filtro queda en los
  Ajustes de esa página, igual que si lo hubieras pulsado en la web.
- **Avisos de GitHub Actions**: la pulsación se lee al empezar la siguiente
  ejecución (unos 5 minutos). Estos filtros se guardan en el estado cifrado de
  Actions, no en la página, así que no aparecen en Ajustes. Pulsar «Enviar lista
  a GitHub» no los borra. Se borran con «Deshacer» o cuando quitas la página de
  la lista de GitHub.
- Solo cuentan las pulsaciones que vienen de tu chat de avisos.
- Si tu bot tiene un *webhook* configurado, Telegram no deja leer los botones, y
  Vigía te avisará de ello.

## Proxy propio (opcional)

Muchas webs no dejan que otra página lea su contenido (bloqueo CORS). Desde el
navegador, Vigía prueba primero el acceso directo y luego varios proxies
públicos. Si prefieres no depender de ellos, `cloudflare-worker.js` es un proxy
listo para desplegar gratis en Cloudflare Workers: el propio archivo explica los
tres pasos. Luego pega su dirección en **Copia de seguridad y conexión → Proxy
propio**.

Desde GitHub Actions no hace falta proxy: el bloqueo CORS solo afecta al
navegador.

## Desarrollo

La lógica de comprobación vive en `vigia/lib.mjs` y está cubierta por pruebas:

```bash
cd vigia
npm ci
npm test
```

Las pruebas se ejecutan también en cada *push* (`.github/workflows/pruebas.yml`).

`index.html` es una página suelta sin compilar: se abre tal cual, sin
dependencias ni pasos de construcción.

## Privacidad

- Tus páginas y ajustes se guardan en tu navegador (`localStorage`), no en un servidor.
- Los registros de Actions no muestran las direcciones vigiladas, solo
  «Página 1», «Página 2»…
- La lista de páginas viaja a GitHub como *variable* del repositorio, que solo
  tú puedes leer.

## Licencia

CC0 1.0 (dominio público). Ver [LICENSE](LICENSE).
