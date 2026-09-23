// Lógica pura de Vigía: extracción, filtros, lectura de feeds/enlaces/números
// y cifrado del estado. Sin red ni disco, para poder probarla con `npm test`.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import * as cheerio from "cheerio";

export const MAX_SEEN = 5000;

/* ---------------------------------------------------------------- utilidades */
export const hash = str => { // cyrb53, igual que en la página
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
};
export const host = u => { try { return new URL(u).host; } catch { return u; } };
export const recorta = (s, n = 140) => (s = String(s)).length > n ? s.slice(0, n) + "…" : s;
export const normTxt = s => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
export const lineasDe = t => String(t || "").split("\n").map(s => s.trim()).filter(Boolean);
export const fmtNum = v => Number(v).toLocaleString("es-ES", { maximumFractionDigits: 2 });
export const toMin = t => { const [h, m] = String(t || "").split(":").map(Number); return isNaN(h) ? null : h * 60 + (m || 0); };

export function enHorario(m, ahora = new Date()) {
  const zona = m.zona || "UTC";
  const partes = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: zona, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(ahora).map(p => [p.type, p.value]));
  if (m.laborables && (partes.weekday === "Sat" || partes.weekday === "Sun")) return false;
  // Con una sola hora puesta no hay franja: se vigila siempre (igual que en la página).
  if (!m.hDesde || !m.hHasta) return true;
  const a = toMin(m.hDesde), b = toMin(m.hHasta);
  if (a == null || b == null || a === b) return true;
  const x = Number(partes.hour) * 60 + Number(partes.minute);
  return a < b ? (x >= a && x < b) : (x >= a || x < b);
}

/* ---------------------------------------------------------------- extracción */
const BLOCK = "address,article,aside,blockquote,br,dd,div,dl,dt,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,ol,p,pre,section,table,td,th,tr,ul,option,button";

export function raices($, m) {
  if (!m.selector) return null;
  let r;
  try { r = $(m.selector); } catch { throw new Error("El selector CSS no es válido."); }
  if (!r.length) throw new Error(`El selector «${m.selector}» no encontró nada en la página.`);
  return r;
}

export function extraer(raw, m) {
  if (!/<\s*(html|head|body|div|p|span|a)\b/i.test(raw)) return lineasDe(raw.replace(/\r/g, ""));
  const $ = cheerio.load(raw);
  if (m.mode === "html") {
    if (m.random !== false) {
      $("script:not([src])").text("");
      $("[nonce]").removeAttr("nonce");
      $("[integrity]").removeAttr("integrity");
      $('input[type="hidden"]').removeAttr("value");
      $("meta").filter((i, e) => /csrf|token/i.test($(e).attr("name") || "")).removeAttr("content");
    }
    const r = raices($, m);
    const html = r ? r.map((i, e) => $.html(e)).get().join("\n") : $.html();
    return lineasDe(partirEtiquetas(html));
  }
  $("script,style,noscript,template,svg,iframe,link,meta").remove();
  $(BLOCK).after("\n");
  const r = raices($, m);
  const texto = r ? r.map((i, e) => $(e).text()).get().join("\n") : $.root().text();
  return texto.split("\n").map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

// El HTML minificado viene en una sola línea: así cada etiqueta es su propia
// línea y tanto los avisos como las reglas de ignorar tienen grano fino.
export const partirEtiquetas = html => String(html).replace(/(?=<[a-zA-Z/!])/g, "\n");

/* --------------------------------------------- normas («no avisar de esto») */
// Una norma neutraliza el valor de un atributo concreto ({tag:"link", attr:"id"}),
// no la línea entera: cualquier otro cambio en esa misma etiqueta sigue avisando.
const NOMBRE = /^[a-zA-Z_:][\w:.-]*$/;
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function normaValida(n) {
  return !!n && NOMBRE.test(n.attr || "") && (n.tag === "*" || NOMBRE.test(n.tag || ""));
}

function neutralizar(linea, norma) {
  const tag = norma.tag || "*";
  if (tag !== "*" && !new RegExp(`^<${escRe(tag)}\\b`, "i").test(linea.trim())) return linea;
  return linea.replace(new RegExp(`(\\b${escRe(norma.attr)}\\s*=\\s*)("[^"]*"|'[^']*')`, "gi"), '$1"‹var›"');
}

export function aplicarNormas(lines, normas) {
  const buenas = (normas || []).filter(normaValida);
  if (!buenas.length) return lines;
  return lines.map(l => buenas.reduce(neutralizar, l));
}

// Deduce la norma a partir del par de líneas que cambió: si lo único distinto
// está dentro del valor de un atributo, devuelve qué atributo y de qué etiqueta.
export function deducirNorma(viejo, nuevo) {
  if (!viejo || !nuevo || viejo === nuevo) return null;
  let p = 0;
  while (p < viejo.length && p < nuevo.length && viejo[p] === nuevo[p]) p++;
  let s = 0;
  while (s < viejo.length - p && s < nuevo.length - p && viejo[viejo.length - 1 - s] === nuevo[nuevo.length - 1 - s]) s++;
  const difA = viejo.slice(p, viejo.length - s), difB = nuevo.slice(p, nuevo.length - s);
  if (!difA || !difB || difA.length > 80 || difB.length > 80) return null;
  if (/[<>]/.test(difA + difB)) return null;

  const prefijo = viejo.slice(0, p);
  const abre = prefijo.lastIndexOf("<");
  if (abre === -1 || prefijo.slice(abre).includes(">")) return null; // es texto, no un atributo
  const attr = prefijo.match(/([a-zA-Z_:][\w:.-]*)\s*=\s*["']?[^"'<>]*$/);
  if (!attr) return null;
  const tag = prefijo.slice(abre + 1).match(/^([a-zA-Z][\w:-]*)/);
  const norma = { tag: tag ? tag[1].toLowerCase() : "*", attr: attr[1].toLowerCase() };
  return normaValida(norma) ? norma : null;
}

export const mismaNorma = (a, b) => a.tag === b.tag && a.attr === b.attr;
export const describeNorma = n => `el atributo ${n.attr} de ${n.tag === "*" ? "cualquier etiqueta" : `<${n.tag}>`}`;

export function prefijoComun(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  return a.slice(0, Math.min(p, 80)).trim();
}

// Qué filtro propondría el botón «No avisar de cambios como este», igual que en
// la página: primero normas de atributo (precisas); si no hay, ignorar las líneas
// por su principio común, salvo que la regla fuera a tragarse media página.
export function sugerirFiltro({ added = [], removed = [], base = [], normas = [], ignore = [] }) {
  const pares = Math.min(added.length, removed.length);
  const nuevas = [];
  for (let i = 0; i < pares; i++) {
    const n = deducirNorma(removed[i], added[i]);
    if (n && !nuevas.some(x => mismaNorma(x, n)) && !normas.some(x => mismaNorma(x, n))) nuevas.push(n);
  }
  if (nuevas.length) return { normas: nuevas, ignore: [] };
  const seguro = p => p.length >= 15 && (base.length < 4 || base.filter(l => l.includes(p)).length <= Math.max(1, base.length * 0.3));
  const prefijos = [];
  for (let i = 0; i < pares; i++) prefijos.push(prefijoComun(added[i], removed[i]));
  const lineas = [...new Set(prefijos)].filter(p => seguro(p) && !ignore.includes(p));
  if (lineas.length) return { normas: [], ignore: lineas };
  // Sin parejas útiles (líneas que solo aparecen o solo desaparecen): la parte
  // fija de cada línea, como en los avisos de novedades.
  // La línea exacta solo sirve para las que no tienen pareja: las que cambian
  // cada vez no volverían a coincidir.
  const txt = t => ({ text: t }), todos = base.map(txt);
  const cambian = sugerirNovedades({ nuevos: [...added.slice(0, pares), ...removed.slice(0, pares)].map(txt), todos, ignore, exacta: false });
  const sueltas = sugerirNovedades({ nuevos: [...added.slice(pares), ...removed.slice(pares)].map(txt), todos, ignore });
  const todas = [...new Set([...(cambian?.ignore || []), ...(sueltas?.ignore || [])])];
  if (!todas.length) return null;
  // Quitar una línea que va y viene deja desparejadas otras repetidas (su
  // «</ul>», por ejemplo) y el siguiente aviso sería +0/−0: se aprende a la vez
  // a no avisar si solo cambian el orden o las repeticiones.
  return sueltas ? { normas: [], ignore: todas, orden: true } : { normas: [], ignore: todas };
}

// Para avisos de novedades (líneas, enlaces o entradas nuevas) no hay pareja
// «antes/después»: el ruido típico es una línea con una parte que varía
// («Actualizado a las 10:32»). Se propone ignorar el texto hasta la primera
// cifra, solo si es la mayor parte del elemento (para no tapar noticias que
// empiecen igual) y no se traga más del 30 % de lo que hay en la página.
export function sugerirNovedades({ nuevos = [], todos = [], ignore = [], exacta = true }) {
  const textos = todos.map(i => i.text || "");
  const reglas = [];
  for (const i of nuevos.slice(0, 8)) {
    const t = String(i.text || "").replace(/\s+/g, " ").trim();
    // La parte fija si es la mayor parte del texto; si no, la línea exacta
    // (sirve para líneas que aparecen y desaparecen sin cambiar).
    const fija = t.split(/\d/)[0].replace(/[\s:;,.·|(\[–-]+$/, "").trim();
    const r = fija.length >= 10 && fija.length >= t.length * 0.5 ? fija : exacta ? t : "";
    if (r.length < 10) continue;
    if (ignore.includes(r) || reglas.includes(r)) continue;
    if (textos.filter(x => x.includes(r)).length > Math.max(1, textos.length * 0.3)) continue;
    reglas.push(r);
  }
  return reglas.length ? { normas: [], ignore: reglas } : null;
}

export function limpiarAleatorio(line) {
  return line
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "‹id›")
    .replace(/\b\d{10,}\b/g, "‹n›")
    .replace(/(?=[A-Za-z0-9_+-]*\d)(?=[A-Za-z0-9_+-]*[A-Za-z])[A-Za-z0-9_+-]{20,}={0,2}/g, "‹código›");
}

export function filtrar(lines, m) {
  const reglas = lineasDe(m.ignore);
  const fuera = l => !reglas.some(r => l.includes(r));
  let out = reglas.length ? lines.filter(fuera) : lines;
  out = aplicarNormas(out, m.normas);
  if (m.random !== false) out = out.map(limpiarAleatorio);
  // Las reglas aprendidas salen de líneas ya neutralizadas («‹var›», «‹código›»):
  // también hay que buscarlas después, o no coincidirían nunca.
  return reglas.length ? out.filter(fuera) : out;
}

export const palabras = m => lineasDe(m.keywords).map(normTxt);
export const coincide = (t, kws) => !kws.length || kws.some(k => normTxt(t).includes(k));

export const esFeed = raw => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<\?xml-stylesheet[^>]*>\s*)*<(rss|feed|rdf:RDF)\b/i.test(raw);

export function leerFeed(raw, m) {
  const $ = cheerio.load(raw, { xmlMode: true });
  return $("item, entry").map((i, n) => {
    const el = $(n);
    const txt = sel => el.children(sel).first().text().trim();
    let link = txt("link");
    const le = el.children("link").filter((j, l) => $(l).attr("href") && (!$(l).attr("rel") || $(l).attr("rel") === "alternate")).first();
    if (le.length) link = le.attr("href");
    try { if (link) link = new URL(link, m.url).href; } catch {}
    const titulo = (txt("title") || link || "(sin título)").replace(/\s+/g, " ");
    return { key: "f:" + hash(txt("guid") || txt("id") || link || titulo), text: titulo, href: link };
  }).get();
}

export function leerEnlaces(raw, m) {
  const $ = cheerio.load(raw);
  const r = raices($, m) || $("body");
  const vistos = new Set(), out = [];
  r.find("a[href]").each((i, a) => {
    const h = ($(a).attr("href") || "").trim();
    if (!h || /^(#|javascript:|mailto:|tel:)/i.test(h)) return;
    let u;
    try { u = new URL(h, m.url); } catch { return; }
    u.hash = "";
    const k = u.href;
    if (vistos.has(k)) return;
    vistos.add(k);
    const text = ($(a).text().replace(/\s+/g, " ").trim() || $(a).attr("title") || $(a).attr("aria-label") || $(a).find("img[alt]").attr("alt") || k).trim();
    out.push({ key: "l:" + hash(k), text, href: k });
  });
  return out;
}

export function leerNumero(txt) {
  const mt = String(txt).replace(/[\s  ]/g, "").match(/-?\d[\d.,']*/);
  if (!mt) return null;
  let s = mt[0].replace(/'/g, "").replace(/[.,]+$/, "");
  const iDot = s.lastIndexOf("."), iCom = s.lastIndexOf(",");
  if (iDot === -1 && iCom === -1) return parseFloat(s);
  if (iDot >= 0 && iCom >= 0) {
    const dec = Math.max(iDot, iCom);
    return parseFloat(s.slice(0, dec).replace(/[.,]/g, "") + "." + s.slice(dec + 1));
  }
  const partes = s.split(iDot >= 0 ? "." : ",");
  if (partes.length > 2 || partes[partes.length - 1].length === 3) return parseFloat(partes.join(""));
  return parseFloat(partes.join("."));
}

/* ---------------------------------------------------------------- avisos */
export const escTg = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ---------------------------------------------------------------- estado cifrado */
// En repositorios públicos el estado (texto de las páginas) se cifra con una
// clave derivada de VIGIA_CLAVE. Ver README: «Por qué conviene VIGIA_CLAVE».
export const derivarClave = secreto => secreto ? createHash("sha256").update("vigia:" + secreto).digest() : null;

export function cifrar(obj, clave) {
  const json = JSON.stringify(obj);
  if (!clave) return json;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", clave, iv);
  const datos = Buffer.concat([c.update(json, "utf8"), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), datos: datos.toString("base64") });
}

export function descifrar(texto, clave) {
  const o = JSON.parse(texto);
  if (!o || o.v !== 1 || !o.datos) return o;
  if (!clave) throw new Error("estado cifrado pero sin secretos");
  const d = createDecipheriv("aes-256-gcm", clave, Buffer.from(o.iv, "base64"));
  d.setAuthTag(Buffer.from(o.tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(o.datos, "base64")), d.final()]).toString("utf8"));
}
