// Proxy propio para Vigía (Cloudflare Workers, plan gratuito)
//
// Muchas webs no dejan que otra página lea su contenido (bloqueo CORS). Este
// worker lee la página por ti y te la devuelve con los permisos necesarios.
//
// Cómo ponerlo en marcha:
//   1. En dash.cloudflare.com → Workers & Pages → Create → Worker.
//   2. Pega este archivo, cambia ORIGENES por la dirección de tu Vigía y despliega.
//   3. En Vigía → «Copia de seguridad y conexión» → «Proxy propio», escribe:
//      https://TU-WORKER.tu-usuario.workers.dev/?url={url}
//
// Solo responde a tu propia página: así nadie más puede usar tu worker.

const ORIGENES = [
  "https://TU-USUARIO.github.io",
  "http://localhost:8000"
];

const MAX_BYTES = 8 * 1024 * 1024;

// Nada de redes internas: un proxy abierto no debe poder asomarse a ellas.
const PRIVADA = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?|\[?f[cd])/i;

export default {
  async fetch(peticion) {
    const origen = peticion.headers.get("Origin");
    const permitido = origen && ORIGENES.includes(origen);
    const cors = {
      "Access-Control-Allow-Origin": permitido ? origen : ORIGENES[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin"
    };

    if (peticion.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (peticion.method !== "GET") return new Response("Solo GET", { status: 405, headers: cors });
    if (origen && !permitido) return new Response("Origen no permitido", { status: 403, headers: cors });

    const destino = new URL(peticion.url).searchParams.get("url");
    if (!destino) return new Response("Falta el parámetro url", { status: 400, headers: cors });

    let u;
    try { u = new URL(destino); } catch { return new Response("La dirección no es válida", { status: 400, headers: cors }); }
    if (u.protocol !== "http:" && u.protocol !== "https:") return new Response("Solo http y https", { status: 400, headers: cors });
    if (PRIVADA.test(u.hostname)) return new Response("Dirección no permitida", { status: 403, headers: cors });

    let res;
    try {
      res = await fetch(u.href, {
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 Vigia/1.0",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"
        },
        redirect: "follow",
        cf: { cacheTtl: 0 }
      });
    } catch (e) {
      return new Response(`No se pudo leer la página: ${e.message}`, { status: 502, headers: cors });
    }

    if (Number(res.headers.get("content-length")) > MAX_BYTES) {
      return new Response("La página pesa demasiado", { status: 413, headers: cors });
    }

    const texto = (await res.text()).slice(0, MAX_BYTES);
    return new Response(texto, {
      status: res.status,
      headers: {
        ...cors,
        "Content-Type": res.headers.get("content-type") || "text/plain; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  }
};
