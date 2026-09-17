import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hash, host, recorta, normTxt, lineasDe, toMin, enHorario,
  extraer, limpiarAleatorio, filtrar, palabras, coincide,
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
