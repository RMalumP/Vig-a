import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hash, host, recorta, normTxt, lineasDe, toMin, enHorario,
  extraer, limpiarAleatorio, filtrar, palabras, coincide,
  partirEtiquetas, aplicarNormas, deducirNorma, normaValida,
  prefijoComun, sugerirFiltro, sugerirNovedades, describeNorma, repartirUpdates,
  esFeed, leerFeed, leerEnlaces, leerNumero, escTg,
  derivarClave, cifrar, descifrar
} from "../lib.mjs";

/* ---------------------------------------------------------------- utilidades */
test("hash es estable y distingue textos", () => {
  assert.equal(hash("hola"), hash("hola"));
  assert.notEqual(hash("hola"), hash("hola "));
  assert.equal(typeof hash(""), "string");
});

test("host extrae el dominio y tolera basura", () => {
  assert.equal(host("https://ejemplo.es/a/b?c=1"), "ejemplo.es");
  assert.equal(host("no es una url"), "no es una url");
});

test("recorta añade puntos suspensivos solo si hace falta", () => {
  assert.equal(recorta("abc", 5), "abc");
  assert.equal(recorta("abcdef", 3), "abc…");
});

test("normTxt quita tildes y mayúsculas", () => {
  assert.equal(normTxt("Oposición Ayúdas"), "oposicion ayudas");
});

test("lineasDe limpia espacios y líneas vacías", () => {
  assert.deepEqual(lineasDe("  a \n\n b  \n"), ["a", "b"]);
  assert.deepEqual(lineasDe(null), []);
});

/* ---------------------------------------------------------------- horarios */
test("toMin convierte HH:MM a minutos", () => {
  assert.equal(toMin("08:30"), 510);
  assert.equal(toMin("00:00"), 0);
  assert.equal(toMin("23:59"), 1439);
  assert.equal(toMin("mañana"), null);
});

test("enHorario respeta la franja normal", () => {
  const m = { zona: "UTC", hDesde: "09:00", hHasta: "17:00" };
  assert.equal(enHorario(m, new Date("2026-09-16T10:00:00Z")), true);
  assert.equal(enHorario(m, new Date("2026-09-16T08:59:00Z")), false);
  assert.equal(enHorario(m, new Date("2026-09-16T17:00:00Z")), false);
});

test("enHorario respeta una franja que cruza la medianoche", () => {
  const m = { zona: "UTC", hDesde: "22:00", hHasta: "06:00" };
  assert.equal(enHorario(m, new Date("2026-09-16T23:30:00Z")), true);
  assert.equal(enHorario(m, new Date("2026-09-16T05:00:00Z")), true);
  assert.equal(enHorario(m, new Date("2026-09-16T12:00:00Z")), false);
});

test("enHorario aplica la zona horaria de la página", () => {
  const m = { zona: "Europe/Madrid", hDesde: "09:00", hHasta: "17:00" };
  // 08:00 UTC = 10:00 en Madrid (verano)
  assert.equal(enHorario(m, new Date("2026-07-15T08:00:00Z")), true);
  // 20:00 UTC = 22:00 en Madrid
  assert.equal(enHorario(m, new Date("2026-07-15T20:00:00Z")), false);
});

test("enHorario descarta el fin de semana si se pide", () => {
  const m = { zona: "UTC", laborables: true };
  assert.equal(enHorario(m, new Date("2026-09-19T10:00:00Z")), false); // sábado
  assert.equal(enHorario(m, new Date("2026-09-18T10:00:00Z")), true);  // viernes
});

test("sin franja definida siempre está en horario", () => {
  assert.equal(enHorario({ zona: "UTC" }, new Date("2026-09-16T03:00:00Z")), true);
});

test("con una sola hora puesta no hay franja (igual que en la página)", () => {
  const madrugada = new Date("2026-09-16T03:00:00Z");
  assert.equal(enHorario({ zona: "UTC", hHasta: "17:00" }, madrugada), true);
  assert.equal(enHorario({ zona: "UTC", hDesde: "09:00" }, madrugada), true);
});

/* ---------------------------------------------------------------- extracción */
test("extraer devuelve el texto visible y descarta scripts y estilos", () => {
  const html = `<html><body><h1>Título</h1><p>Uno</p><script>var a=1</script><style>p{}</style><p>Dos</p></body></html>`;
  assert.deepEqual(extraer(html, {}), ["Título", "Uno", "Dos"]);
});

test("extraer aplica el selector CSS", () => {
  const html = `<div class="a">Dentro</div><div class="b">Fuera</div>`;
  assert.deepEqual(extraer(html, { selector: ".a" }), ["Dentro"]);
});

test("extraer avisa si el selector no encuentra nada", () => {
  assert.throws(() => extraer("<div>hola</div>", { selector: ".no-existe" }), /no encontró nada/);
});

test("extraer trata el texto plano como líneas", () => {
  assert.deepEqual(extraer("uno\r\ndos\n\n", {}), ["uno", "dos"]);
});

/* ------------------------------------------- HTML minificado y normas */
test("partirEtiquetas convierte el HTML minificado en una línea por etiqueta", () => {
  const min = `<head><link rel="stylesheet"><link id="abc" rel="alternate"></head>`;
  assert.deepEqual(lineasDe(partirEtiquetas(min)), [
    "<head>", `<link rel="stylesheet">`, `<link id="abc" rel="alternate">`, "</head>"
  ]);
});

test("extraer en modo HTML ya no devuelve la página entera en una línea", () => {
  const min = `<html><body><div class="a">Uno</div><div class="b">Dos</div></body></html>`;
  const lineas = extraer(min, { mode: "html", random: false });
  assert.ok(lineas.length > 4, `esperaba varias líneas, hubo ${lineas.length}`);
  assert.ok(lineas.some(l => l.startsWith('<div class="a"')));
});

test("deducirNorma identifica el atributo volátil y su etiqueta", () => {
  const viejo = `<link id="CBcD1OS554B" rel="alternate" href="https://ejemplo.es/a">`;
  const nuevo = `<link id="cuxZXs4gyjA" rel="alternate" href="https://ejemplo.es/a">`;
  assert.deepEqual(deducirNorma(viejo, nuevo), { tag: "link", attr: "id" });
});

test("deducirNorma se abstiene cuando el cambio es de texto, no de atributo", () => {
  assert.equal(deducirNorma("<p>Quedan 3 plazas</p>", "<p>Quedan 2 plazas</p>"), null);
  assert.equal(deducirNorma("Plazo abierto", "Plazo cerrado"), null);
});

test("deducirNorma se abstiene si cambia la estructura y no un valor", () => {
  assert.equal(deducirNorma(`<div class="a">`, `<div class="a"><span>`), null);
  assert.equal(deducirNorma("igual", "igual"), null);
});

test("aplicarNormas neutraliza solo ese atributo de esa etiqueta", () => {
  const norma = { tag: "link", attr: "id" };
  const lineas = [
    `<link id="CBcD1OS554B" rel="alternate" href="https://ejemplo.es/a">`,
    `<div id="contenido">Novedades</div>`
  ];
  const out = aplicarNormas(lineas, [norma]);
  assert.equal(out[0], `<link id="‹var›" rel="alternate" href="https://ejemplo.es/a">`);
  assert.equal(out[1], lineas[1], "el id de otras etiquetas no se toca");
});

test("con la norma puesta, el id aleatorio deja de contar como cambio", () => {
  const m = { mode: "html", random: false, normas: [{ tag: "link", attr: "id" }] };
  const antes = filtrar(extraer(`<html><head><link id="CBcD1OS554B" rel="alternate"></head><body>Hola</body></html>`, m), m);
  const ahora = filtrar(extraer(`<html><head><link id="cuxZXs4gyjA" rel="alternate"></head><body>Hola</body></html>`, m), m);
  assert.deepEqual(ahora, antes);
});

test("pero un cambio real en esa misma etiqueta sí se ve", () => {
  const m = { mode: "html", random: false, normas: [{ tag: "link", attr: "id" }] };
  const antes = filtrar(extraer(`<html><head><link id="aaa" href="/v1.css"></head></html>`, m), m);
  const ahora = filtrar(extraer(`<html><head><link id="bbb" href="/v2.css"></head></html>`, m), m);
  assert.notDeepEqual(ahora, antes);
});

test("y un cambio de contenido sigue avisando con la norma puesta", () => {
  const m = { mode: "html", random: false, normas: [{ tag: "link", attr: "id" }] };
  const antes = filtrar(extraer(`<html><head><link id="aaa"></head><body><p>Nada</p></body></html>`, m), m);
  const ahora = filtrar(extraer(`<html><head><link id="bbb"></head><body><p>Plazo abierto</p></body></html>`, m), m);
  assert.notDeepEqual(ahora, antes);
});

test("normaValida rechaza nombres que no son atributos", () => {
  assert.equal(normaValida({ tag: "link", attr: "id" }), true);
  assert.equal(normaValida({ tag: "*", attr: "data-x" }), true);
  assert.equal(normaValida({ tag: "link", attr: ".*" }), false);
  assert.equal(normaValida({ tag: "(a|b)+", attr: "id" }), false);
  assert.equal(normaValida(null), false);
});

test("una norma con nombres raros no altera el contenido", () => {
  const lineas = [`<link id="abc">`];
  assert.deepEqual(aplicarNormas(lineas, [{ tag: "link", attr: "[a-z]+" }]), lineas);
});

test("limpiarAleatorio neutraliza identificadores que cambian solos", () => {
  assert.match(limpiarAleatorio("id 550e8400-e29b-41d4-a716-446655440000 fin"), /‹id›/);
  assert.match(limpiarAleatorio("ts 1726500000000"), /‹n›/);
});

test("filtrar descarta las líneas con texto ignorado", () => {
  const lineas = ["Hora: 12:00", "Novedad importante", "Publicidad"];
  assert.deepEqual(filtrar(lineas, { ignore: "Hora:\nPublicidad", random: false }), ["Novedad importante"]);
});

test("palabras y coincide filtran sin tildes ni mayúsculas", () => {
  const kws = palabras({ keywords: "Oposición\nBECA" });
  assert.equal(coincide("Nueva oposicion publicada", kws), true);
  assert.equal(coincide("Convocatoria de becas", kws), true);
  assert.equal(coincide("Otra cosa", kws), false);
  assert.equal(coincide("lo que sea", []), true, "sin palabras clave, todo vale");
});

/* ---------------------------------------------------------------- feeds y enlaces */
test("esFeed reconoce RSS y Atom, y no un HTML", () => {
  assert.equal(esFeed(`<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>`), true);
  assert.equal(esFeed(`<feed xmlns="http://www.w3.org/2005/Atom"></feed>`), true);
  assert.equal(esFeed(`<!DOCTYPE html><html><body></body></html>`), false);
});

test("leerFeed saca título y enlace de un RSS", () => {
  const rss = `<?xml version="1.0"?><rss><channel>
    <item><title>Primera   entrada</title><link>/noticias/1</link><guid>abc</guid></item>
    <item><title>Segunda</title><link>https://otro.es/2</link></item>
  </channel></rss>`;
  const items = leerFeed(rss, { url: "https://ejemplo.es/feed.xml" });
  assert.equal(items.length, 2);
  assert.equal(items[0].text, "Primera entrada");
  assert.equal(items[0].href, "https://ejemplo.es/noticias/1", "los enlaces relativos se resuelven");
  assert.equal(items[1].href, "https://otro.es/2");
});

test("leerFeed usa el link con href de Atom", () => {
  const atom = `<feed><entry><title>Hola</title><link rel="alternate" href="https://ejemplo.es/a"/><id>tag:1</id></entry></feed>`;
  assert.equal(leerFeed(atom, { url: "https://ejemplo.es/" })[0].href, "https://ejemplo.es/a");
});

test("leerEnlaces resuelve, deduplica y descarta anclas", () => {
  const html = `<body>
    <a href="/uno">Uno</a>
    <a href="/uno#seccion">Uno otra vez</a>
    <a href="#arriba">Ancla</a>
    <a href="javascript:void(0)">JS</a>
    <a href="mailto:a@b.es">Correo</a>
    <a href="https://otro.es/dos"><img alt="Dos"></a>
  </body>`;
  const links = leerEnlaces(html, { url: "https://ejemplo.es/" });
  assert.deepEqual(links.map(l => l.href), ["https://ejemplo.es/uno", "https://otro.es/dos"]);
  assert.equal(links[1].text, "Dos", "si no hay texto, se usa el alt de la imagen");
});

/* ---------------------------------------------------------------- números */
test("leerNumero entiende el formato español", () => {
  assert.equal(leerNumero("1.234,56 €"), 1234.56);
  assert.equal(leerNumero("1.234"), 1234);
  assert.equal(leerNumero("12,5"), 12.5);
});

test("leerNumero entiende el formato inglés", () => {
  assert.equal(leerNumero("$1,234.56"), 1234.56);
  assert.equal(leerNumero("1,234"), 1234);
  assert.equal(leerNumero("12.5"), 12.5);
});

test("leerNumero tolera espacios raros, apóstrofos y negativos", () => {
  assert.equal(leerNumero("1 234"), 1234);
  assert.equal(leerNumero("1'234.5"), 1234.5);
  assert.equal(leerNumero("-7"), -7);
  assert.equal(leerNumero("Quedan 3 plazas"), 3);
});

test("leerNumero devuelve null si no hay número", () => {
  assert.equal(leerNumero("agotado"), null);
});

/* ---------------------------------------------------------------- avisos */
test("escTg escapa el HTML de Telegram", () => {
  assert.equal(escTg(`<b>&"</b>`), "&lt;b&gt;&amp;&quot;&lt;/b&gt;");
});

/* ---------------------------------------------------------------- estado cifrado */
test("cifrar y descifrar recuperan el estado", () => {
  const clave = derivarClave("un-secreto");
  const estado = { abc: { hash: "x", lines: ["uno", "dos"], last: 123 } };
  const texto = cifrar(estado, clave);
  assert.doesNotMatch(texto, /uno/, "el contenido no queda a la vista");
  assert.deepEqual(descifrar(texto, clave), estado);
});

test("sin clave el estado queda en claro pero se relee", () => {
  const estado = { abc: { hash: "x" } };
  assert.deepEqual(descifrar(cifrar(estado, null), null), estado);
});

test("descifrar falla con la clave equivocada", () => {
  const texto = cifrar({ a: 1 }, derivarClave("uno"));
  assert.throws(() => descifrar(texto, derivarClave("otro")));
  assert.throws(() => descifrar(texto, null), /sin secretos/);
});

test("derivarClave da 32 bytes y es determinista", () => {
  assert.equal(derivarClave("x").length, 32);
  assert.deepEqual(derivarClave("x"), derivarClave("x"));
  assert.equal(derivarClave(""), null);
});

/* ------------------------------------ «No avisar de cambios como este» */
test("prefijoComun devuelve el principio compartido, recortado", () => {
  assert.equal(prefijoComun("Visitas hoy: 120", "Visitas hoy: 121"), "Visitas hoy: 12");
  assert.equal(prefijoComun("abc", "xyz"), "");
});

test("sugerirFiltro prefiere una norma de atributo cuando el cambio está en un valor", () => {
  const f = sugerirFiltro({ removed: ['<link id="a1b2" rel="x">'], added: ['<link id="z9y8" rel="x">'] });
  assert.deepEqual(f, { normas: [{ tag: "link", attr: "id" }], ignore: [] });
  assert.match(describeNorma(f.normas[0]), /atributo id de <link>/);
});

test("sugerirFiltro no repite normas que ya existen", () => {
  const f = sugerirFiltro({
    removed: ['<link id="a1b2" rel="x">'], added: ['<link id="z9y8" rel="x">'],
    normas: [{ tag: "link", attr: "id" }]
  });
  assert.equal(f, null);
});

test("sugerirFiltro recurre a ignorar la línea si el cambio está en el texto", () => {
  const base = ["Titular", "Otra cosa", "Más contenido", "Actualizado a las 10:32", "Pie"];
  const f = sugerirFiltro({ removed: ["Actualizado a las 10:31"], added: ["Actualizado a las 10:32"], base });
  assert.deepEqual(f, { normas: [], ignore: ["Actualizado a las 10:3"] });
});

test("sugerirFiltro descarta reglas que se tragarían media página o son muy cortas", () => {
  const base = ["Precio del producto: 10", "Precio del producto: 20", "Precio del producto: 30", "Precio del producto: 40", "Otra"];
  assert.equal(sugerirFiltro({ removed: ["Precio del producto: 10"], added: ["Precio del producto: 90"], base }), null);
  assert.equal(sugerirFiltro({ removed: ["Hoy 1"], added: ["Hoy 2"] }), null);
});

test("sugerirFiltro no repite una regla ya puesta y recurre a la parte fija", () => {
  const f = sugerirFiltro({ removed: ["Actualizado a las 10:31"], added: ["Actualizado a las 10:32"], ignore: ["Actualizado a las 10:3"] });
  assert.deepEqual(f, { normas: [], ignore: ["Actualizado a las"] });
  assert.equal(sugerirFiltro({ removed: ["Actualizado a las 10:31"], added: ["Actualizado a las 10:32"], ignore: ["Actualizado a las 10:3", "Actualizado a las"] }), null);
});

/* ------------------------------------ cola de Telegram compartida */
const boton = (update_id, data) => ({ update_id, callback_query: { id: "q" + update_id, data } });
const deActions = a => a === "s" || a === "d";
const deWeb = a => a === "ws" || a === "wd";

test("repartirUpdates recoge lo propio y confirma todo si nada es ajeno", () => {
  const { mias, offset } = repartirUpdates([boton(1, "s:a"), boton(2, "d:a")], deActions);
  assert.deepEqual(mias.map(q => q.id), ["q1", "q2"]);
  assert.equal(offset, 3);
});

test("repartirUpdates no confirma más allá de una pulsación ajena", () => {
  const ups = [boton(1, "s:a"), boton(2, "ws:b"), boton(3, "s:c")];
  const actions = repartirUpdates(ups, deActions);
  assert.deepEqual(actions.mias.map(q => q.id), ["q1", "q3"]);
  assert.equal(actions.offset, 2); // la q2 de la página sigue en la cola
  const web = repartirUpdates(ups, deWeb);
  assert.deepEqual(web.mias.map(q => q.id), ["q2"]);
  assert.equal(web.offset, null); // la q1 es de Actions: no se confirma nada
});

test("repartirUpdates deja los mensajes recientes para detectar el chat", () => {
  const ahora = 1_000_000_000_000;
  const msg = (update_id, haceSeg) => ({ update_id, message: { date: ahora / 1000 - haceSeg } });
  assert.equal(repartirUpdates([msg(1, 7200), boton(2, "s:a")], deActions, ahora).offset, 3);
  assert.equal(repartirUpdates([msg(1, 60), boton(2, "s:a")], deActions, ahora).offset, null);
  assert.deepEqual(repartirUpdates([], deActions, ahora), { mias: [], offset: null });
});

/* ------------------------------------ «No avisar de novedades como esta» */
const items = (...t) => t.map(text => ({ text }));

test("sugerirNovedades ignora la parte fija de una línea que cambia", () => {
  const todos = items("Noticia uno", "Noticia dos", "Otra cosa", "Actualizado a las 10:32");
  assert.deepEqual(sugerirNovedades({ nuevos: items("Actualizado a las 10:32"), todos }), { normas: [], ignore: ["Actualizado a las"] });
  assert.deepEqual(sugerirNovedades({ nuevos: items("Visitas hoy: 12345"), todos }), { normas: [], ignore: ["Visitas hoy"] });
});

test("sugerirNovedades no propone reglas que taparían noticias que empiecen igual", () => {
  const todos = items("a", "b", "c", "d");
  // Poco texto fijo: solo esa línea exacta, no todo lo que empiece igual.
  assert.deepEqual(sugerirNovedades({ nuevos: items("Convocatoria 2026 de ayudas para jóvenes"), todos }),
    { normas: [], ignore: ["Convocatoria 2026 de ayudas para jóvenes"] });
  assert.equal(sugerirNovedades({ nuevos: items("12:30 h"), todos }), null); // demasiado corta
});

test("sugerirNovedades usa el texto entero si no hay cifras y respeta el 30 %", () => {
  assert.deepEqual(sugerirNovedades({ nuevos: items("Banner de cookies"), todos: items("Banner de cookies", "x", "y", "z") }),
    { normas: [], ignore: ["Banner de cookies"] });
  const todos = items("Precio del día 1", "Precio del día 2", "Precio del día 3", "otra");
  assert.equal(sugerirNovedades({ nuevos: items("Precio del día 3"), todos }), null);
  assert.equal(sugerirNovedades({ nuevos: items("Actualizado a las 10:32"), todos: items("Actualizado a las 10:32", "x", "y"), ignore: ["Actualizado a las"] }), null);
});

/* ------------------------------------ reglas aprendidas sobre líneas neutralizadas */
test("filtrar aplica las reglas que contienen ‹var› o ‹código›", () => {
  const lines = ['<link id="abc1" rel="alternate" href="/x">', '<p>Contenido', `<a data-t="${"a1".repeat(12)}">Token`];
  const m = { normas: [{ tag: "link", attr: "id" }], ignore: '<link id="‹var›" rel="alternate"\n<a data-t="‹código›', random: true };
  assert.deepEqual(filtrar(lines, m), ["<p>Contenido"]);
});

test("sugerirFiltro propone la parte fija si solo aparecen líneas", () => {
  const base = ["a", "b", "c", "d", "Aviso temporal número 7"];
  assert.deepEqual(sugerirFiltro({ added: ["Aviso temporal número 7"], base }), { normas: [], ignore: ["Aviso temporal número"] });
});

test("sugerirFiltro: una etiqueta que aparece y desaparece se ignora tal cual (seg-social.es)", () => {
  const ul = '<ul class="col-md-12 listado-menu triangle bordeOut">';
  const base = ["<html>", "<body>", '<div class="menu">', "<li>Uno", "<li>Dos", "<p>Texto"];
  assert.deepEqual(sugerirFiltro({ removed: [ul], base }), { normas: [], ignore: [ul] });
  assert.deepEqual(sugerirFiltro({ added: [ul], base: [...base, ul] }), { normas: [], ignore: [ul] });
});
