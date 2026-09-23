import { test } from "node:test";
import assert from "node:assert/strict";
import { clasificar, repartir, atenderBoton, atenderTexto, responder, h6, corta, hace, ESPERA_ACTIONS } from "../bot-core.mjs";

const AHORA = 1_800_000_000_000;
function crearCtx({ origen = "web", editable = true } = {}) {
  const ctx = {
    chat: "42",
    paginas_: [
      { id: "a1", url: "https://www.seg-social.es/x?lang=es", watch: "cambios", mode: "html", interval: 900, paused: false,
        ignore: ["Cookies"], normas: [{ tag: "link", attr: "id" }], orden: true, keywords: [], cloud: true,
        estado: "ok", ultima: AHORA - 120000, ultimoAviso: AHORA - 3600000, hist: [{ t: AHORA - 3600000, titulo: "Cambio en seg-social.es", linea: "+ algo" }] },
      { id: "b2", url: "https://roto.test/", watch: "nuevo", mode: "text", interval: 300, paused: false,
        ignore: [], normas: [], orden: false, keywords: ["convocatoria"], cloud: false, estado: "error", mensaje: "HTTP 500", hist: [] }
    ],
    global_: { ignore: [], normas: [], orden: false },
    llamadas: [],
    ahora: () => AHORA,
    info: () => ({ origen, editable, motivo: editable ? "" : "falta el secreto VIGIA_GH_TOKEN" }),
    paginas() { return this.paginas_; },
    global() { return this.global_; },
    async cambiar(id, c) { this.llamadas.push(["cambiar", id, c]); Object.assign(this.paginas_.find(p => p.id === id), c); },
    async cambiarGlobal(c) { this.llamadas.push(["global", c]); Object.assign(this.global_, c); },
    async nueva({ url, watch }) { this.llamadas.push(["nueva", url, watch]); const p = { id: "n3", url, watch, mode: "text", interval: 900, ignore: [], normas: [], orden: false, keywords: [], cloud: true, hist: [] }; this.paginas_.push(p); return { id: "n3" }; },
    async borrar(id) { this.llamadas.push(["borrar", id]); this.paginas_ = this.paginas_.filter(p => p.id !== id); },
    async ejecutar() { return "🚀 Ejecución pedida"; }
  };
  return ctx;
}
const datos = teclado => teclado.flat().map(b => b.callback_data);

test("clasificar: la web atiende sus botones y los menús al momento", () => {
  const o = { origen: "web", chat: "42", ahora: AHORA };
  assert.equal(clasificar({ callback_query: { data: "m:h", message: { date: AHORA / 1000 } } }, o), "mia");
  assert.equal(clasificar({ callback_query: { data: "ws:x" } }, o), "mia");
  assert.equal(clasificar({ callback_query: { data: "s:x" } }, o), "ajena");
  assert.equal(clasificar({ message: { text: "/menu", date: AHORA / 1000, chat: { id: 42 } } }, o), "mia");
  assert.equal(clasificar({ message: { text: "hola", date: AHORA / 1000, chat: { id: 7 } } }, o), "ajena"); // detección de chat
  assert.equal(clasificar({ message: { text: "hola", date: AHORA / 1000 - 7200, chat: { id: 7 } } }, o), "libre");
});

test("clasificar: GitHub Actions deja los menús recientes a la web", () => {
  const o = { origen: "actions", chat: "42", ahora: AHORA };
  const reciente = AHORA / 1000 - 10, viejo = AHORA / 1000 - ESPERA_ACTIONS - 1;
  assert.equal(clasificar({ message: { text: "/menu", date: reciente, chat: { id: 42 } } }, o), "ajena");
  assert.equal(clasificar({ message: { text: "/menu", date: viejo, chat: { id: 42 } } }, o), "mia");
  assert.equal(clasificar({ callback_query: { data: "m:h", message: { date: viejo - 999, edit_date: reciente } } }, o), "ajena");
  assert.equal(clasificar({ callback_query: { data: "m:h", message: { date: viejo } } }, o), "mia");
  assert.equal(clasificar({ callback_query: { data: "s:x" } }, o), "mia");
  assert.equal(clasificar({ callback_query: { data: "wt:prueba" } }, o), "ajena");
});

test("repartir no confirma más allá de lo ajeno", () => {
  const o = { origen: "actions", chat: "42", ahora: AHORA };
  const ups = [
    { update_id: 1, callback_query: { id: "a", data: "s:1" } },
    { update_id: 2, callback_query: { id: "b", data: "ws:1" } },
    { update_id: 3, callback_query: { id: "c", data: "d:1" } }
  ];
  const r = repartir(ups, o);
  assert.deepEqual(r.mias.map(u => u.update_id), [1, 3]);
  assert.equal(r.offset, 2);
});

test("menú principal con indicador de quién responde", async () => {
  const web = await atenderTexto("/menu", crearCtx());
  assert.match(web.enviar.texto, /Web abierta/);
  assert.match(web.enviar.texto, /2 páginas · 2 activas · 🔴 1 con error · 1 aviso en 24 h/);
  assert.ok(datos(web.enviar.teclado).includes("m:l:0"));
  const gh = await atenderTexto("/start", crearCtx({ origen: "actions", editable: false }));
  assert.match(gh.enviar.texto, /Web cerrada/);
  assert.match(gh.enviar.texto, /Solo lectura: falta el secreto VIGIA_GH_TOKEN/);
});

test("lista y ficha de una página", async () => {
  const ctx = crearCtx();
  const l = await atenderBoton("m:l:0", ctx);
  assert.deepEqual(datos(l.editar.teclado).slice(0, 2), ["m:p:a1", "m:p:b2"]);
  assert.match(l.editar.teclado[0][0].text, /🟢 ☁️ seg-social\.es/);
  const f = await atenderBoton("m:p:a1", ctx);
  assert.match(f.editar.texto, /Frecuencia:<\/b> cada 15 min/);
  assert.match(f.editar.texto, /Filtros:<\/b> 3 propios/);
  assert.ok(datos(f.editar.teclado).includes("m:pp:a1:1"));
});

test("cambiar frecuencia y pausar son idempotentes", async () => {
  const ctx = crearCtx();
  await atenderBoton("m:fs:a1:3600", ctx);
  await atenderBoton("m:fs:a1:3600", ctx);
  assert.equal(ctx.paginas_[0].interval, 3600);
  await atenderBoton("m:pp:a1:1", ctx);
  await atenderBoton("m:pp:a1:1", ctx);
  assert.equal(ctx.paginas_[0].paused, true);
  const r = await atenderBoton("m:pt:0", ctx);
  assert.equal(ctx.paginas_.every(p => !p.paused), true);
  assert.match(r.aviso, /reanudado/);
});

test("quitar y añadir filtros de una página", async () => {
  const ctx = crearCtx();
  const f = await atenderBoton("m:fl:a1", ctx);
  assert.ok(datos(f.editar.teclado).includes(`m:fx:a1:${h6("Cookies")}`));
  await atenderBoton(`m:fx:a1:${h6("Cookies")}`, ctx);
  assert.deepEqual(ctx.paginas_[0].ignore, []);
  await atenderBoton(`m:nx:a1:${h6("link id")}`, ctx);
  assert.deepEqual(ctx.paginas_[0].normas, []);
  await atenderBoton("m:ox:a1", ctx);
  assert.equal(ctx.paginas_[0].orden, false);
  const pide = await atenderBoton("m:fa:a1", ctx);
  assert.match(pide.forzar, /\(ref p:a1\)/);
  const r = await atenderTexto("Última actualización", ctx, pide.forzar);
  assert.deepEqual(ctx.paginas_[0].ignore, ["Última actualización"]);
  assert.match(r.enviar.texto, /Última actualización/);
  const corto = await atenderTexto("ab", ctx, pide.forzar);
  assert.match(corto.enviar.texto, /demasiado corto/);
});

test("reglas globales", async () => {
  const ctx = crearCtx();
  await atenderBoton("m:go:1", ctx);
  assert.equal(ctx.global_.orden, true);
  const pide = await atenderBoton("m:ga", ctx);
  await atenderTexto("Cookies", ctx, pide.forzar);
  assert.deepEqual(ctx.global_.ignore, ["Cookies"]);
  await atenderBoton(`m:gx:${h6("Cookies")}`, ctx);
  assert.deepEqual(ctx.global_.ignore, []);
});

test("añadir y quitar páginas", async () => {
  const ctx = crearCtx();
  const r = await atenderTexto("/nueva ejemplo.com/noticias", ctx);
  assert.match(r.enviar.texto, /https:\/\/ejemplo\.com\/noticias/);
  const f = await atenderBoton("m:nm:nuevo", ctx, r.enviar.texto.replace(/<[^>]+>/g, ""));
  assert.deepEqual(ctx.llamadas.at(-1), ["nueva", "https://ejemplo.com/noticias", "nuevo"]);
  assert.match(f.editar.texto, /ejemplo\.com\/noticias/);
  const conf = await atenderBoton("m:del:b2", ctx);
  assert.ok(datos(conf.editar.teclado).includes("m:dy:b2"));
  await atenderBoton("m:dy:b2", ctx);
  await atenderBoton("m:dy:b2", ctx); // repetido: no falla
  assert.equal(ctx.paginas_.some(p => p.id === "b2"), false);
  const url = await atenderTexto("https://otra.es", ctx);
  assert.match(url.enviar.texto, /Nueva página/);
});

test("en solo lectura no se cambia nada", async () => {
  const ctx = crearCtx({ origen: "actions", editable: false });
  const r = await atenderBoton("m:pp:a1:1", ctx);
  assert.match(r.aviso, /🔒/);
  assert.equal(ctx.llamadas.length, 0);
  assert.match((await atenderTexto("/nueva https://x.es", ctx)).enviar.texto, /🔒/);
});

test("callback_data cabe en 64 bytes", async () => {
  const ctx = crearCtx();
  ctx.paginas_[0].id = "x".repeat(20);
  ctx.paginas_[0].ignore = ["a".repeat(500)];
  for (const d of ["m:p:", "m:fl:", "m:f:"]) {
    const r = await atenderBoton(d + ctx.paginas_[0].id, ctx);
    for (const b of r.editar.teclado.flat()) assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
  }
});

test("responder edita el mensaje del menú y rechaza otros chats", async () => {
  const ctx = crearCtx(), llamadas = [];
  const tg = async (m, b) => { llamadas.push([m, b]); return {}; };
  await responder({ callback_query: { id: "q", data: "m:l:0", message: { message_id: 5, chat: { id: 42 }, text: "" } } }, ctx, tg);
  assert.deepEqual(llamadas.map(l => l[0]), ["answerCallbackQuery", "editMessageText"]);
  llamadas.length = 0;
  await responder({ callback_query: { id: "q", data: "m:pt:1", message: { message_id: 5, chat: { id: 9 } } } }, ctx, tg);
  assert.equal(llamadas[0][1].text, "Este botón no es para este chat.");
  assert.equal(ctx.llamadas.length, 0);
});

test("utilidades", () => {
  assert.equal(corta("https://www.seg-social.es/a?b=1"), "seg-social.es/a?b=1");
  assert.equal(hace(AHORA - 300000, AHORA), "hace 5 min");
  assert.equal(hace(null, AHORA), "nunca");
});

test("fusionarConfigs: gana lo más reciente y lo borrado no vuelve", async () => {
  const { fusionarConfigs } = await import("../bot-core.mjs");
  const web = { monitors: [{ id: "a", interval: 300, editado: 10 }, { id: "b", interval: 60, editado: 5 }, { id: "c", editado: 1 }],
    global: { ignore: "x", editado: 3 } };
  const bot = { monitors: [{ id: "a", interval: 900, editado: 20 }, { id: "b", interval: 120, editado: 1 }, { id: "n", editado: 30 }],
    borrados: [{ id: "c", t: 25 }], global: { ignore: "y", editado: 2 } };
  const f = fusionarConfigs(web, bot, 100);
  assert.deepEqual(f.monitors.map(m => [m.id, m.interval]), [["a", 900], ["b", 60], ["n", undefined]]);
  assert.equal(f.global.ignore, "x");
  assert.deepEqual(f.borrados, [{ id: "c", t: 25 }]);
  // Editada después de borrarla: vuelve.
  assert.equal(fusionarConfigs(f, { monitors: [{ id: "c", editado: 40 }] }, 100).monitors.some(m => m.id === "c"), true);
  // Los borrados se olvidan a los 30 días.
  assert.deepEqual(fusionarConfigs({ borrados: [{ id: "z", t: 1 }] }, {}, 31 * 86400000).borrados, []);
});

test("repartir: GitHub Actions no repite respuestas que ya dio la web", () => {
  const o = { origen: "actions", chat: "42", ahora: AHORA };
  const t = AHORA / 1000 - 3600;
  const ups = [
    { update_id: 1, callback_query: { id: "a", data: "s:1" } },                                   // botón de aviso pendiente
    { update_id: 2, message: { text: "/menu", date: t, chat: { id: 42 } } },                      // la web lo contestó…
    { update_id: 3, callback_query: { id: "b", data: "m:l:0", message: { date: t + 5 } } },        // …prueba: pulsaste en su respuesta
    { update_id: 4, message: { text: "/estado", date: t + 60, chat: { id: 42 } } }                // sin respuesta: lo atiende
  ];
  const r = repartir(ups, o);
  assert.deepEqual(r.mias.map(u => u.update_id), [1, 3, 4]);
});

test("leerDuracion entiende lo que escribe una persona", async () => {
  const { leerDuracion } = await import("../bot-core.mjs");
  assert.equal(leerDuracion("90 s"), 90);
  assert.equal(leerDuracion("10 min"), 600);
  assert.equal(leerDuracion("10"), 600); // sin unidad: minutos
  assert.equal(leerDuracion("2h"), 7200);
  assert.equal(leerDuracion("1,5 horas"), 5400);
  assert.equal(leerDuracion("1 día"), 86400);
  assert.equal(leerDuracion("cada rato"), null);
  assert.equal(leerDuracion("0 min"), null);
});

test("nombre distingue entradas con la misma dirección", async () => {
  const { nombre } = await import("../bot-core.mjs");
  const a = { url: "https://seg-social.es/x", watch: "cambios", mode: "html", interval: 300 };
  const b = { url: "https://seg-social.es/x", watch: "cambios", mode: "text", interval: 300 };
  const c = { url: "https://seg-social.es/x", watch: "cambios", mode: "text", interval: 900 };
  const d = { url: "https://otra.es/", watch: "nuevo", mode: "text", interval: 300 };
  const todas = [a, b, c, d];
  assert.equal(nombre(a, todas), "seg-social.es/x · Cualquier cambio · HTML");
  assert.equal(nombre(b, todas), "seg-social.es/x · Cualquier cambio · texto · cada 5 min");
  assert.equal(nombre(c, todas), "seg-social.es/x · Cualquier cambio · texto · cada 15 min");
  assert.equal(nombre(d, todas), "otra.es");
});

test("frecuencia personalizada", async () => {
  const ctx = crearCtx();
  const f = await atenderBoton("m:f:a1", ctx);
  assert.ok(datos(f.editar.teclado).includes("m:fp:a1"));
  const pide = await atenderBoton("m:fp:a1", ctx);
  assert.match(pide.forzar, /\(ref f:a1\)/);
  const mal = await atenderTexto("a menudo", ctx, pide.forzar);
  assert.match(mal.forzar, /No lo he entendido/);
  const r = await atenderTexto("45 min", ctx, pide.forzar);
  assert.equal(ctx.paginas_[0].interval, 2700);
  assert.match(r.enviar.texto, /cada 45 min/);
  const f2 = await atenderBoton("m:f:a1", ctx);
  assert.match(f2.editar.teclado.flat().find(b => b.callback_data === "m:fp:a1").text, /✅ ✏️ Personalizada \(45 min\)/);
});

test("la lista muestra todas las entradas, también las repetidas", async () => {
  const ctx = crearCtx();
  ctx.paginas_.push({ ...ctx.paginas_[0], id: "a2", mode: "text", cloud: false });
  const l = await atenderBoton("m:l:0", ctx);
  const textos = l.editar.teclado.flat().map(b => b.text);
  assert.ok(textos.some(t => /☁️ seg-social\.es\/x\?lang=es · Cualquier cambio · HTML/.test(t)), textos.join("\n"));
  assert.ok(textos.some(t => /🖥 seg-social\.es\/x\?lang=es · Cualquier cambio · texto/.test(t)));
  assert.match(l.editar.texto, /Páginas<\/b> \(3\)/);
});
