// Vigía para GitHub Actions
// Lee la lista de páginas de la variable privada VIGIA_CONFIG, las comprueba
// y avisa por Telegram y/o ntfy. El estado se guarda en ESTADO (caché de Actions).

import { readFile, writeFile, appendFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import * as cheerio from "cheerio";

const ESTADO = process.env.ESTADO || "vigia-estado.json";
const MAX_SEEN = 5000;
const TOLERANCIA_MS = 90_000; // el cron de GitHub no es exacto

/* ---------------------------------------------------------------- utilidades */
const hash = str => { // cyrb53, igual que en la página
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
const host = u => { try { return new URL(u).host; } catch { return u; } };
const recorta = (s, n = 140) => (s = String(s)).length > n ? s.slice(0, n) + "…" : s;
const normTxt = s => String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const lineasDe = t => String(t || "").split("\n").map(s => s.trim()).filter(Boolean);
const fmtNum = v => Number(v).toLocaleString("es-ES", { maximumFractionDigits: 2 });
const toMin = t => { const [h, m] = String(t || "").split(":").map(Number); return isNaN(h) ? null : h * 60 + (m || 0); };

function enHorario(m) {
  const zona = m.zona || "UTC";
  const partes = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: zona, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  if (m.laborables && (partes.weekday === "Sat" || partes.weekday === "Sun")) return false;
  const a = toMin(m.hDesde), b = toMin(m.hHasta);
  if (a == null || b == null || a === b) return true;
  const x = Number(partes.hour) * 60 + Number(partes.minute);
  return a < b ? (x >= a && x < b) : (x >= a || x < b);
}

/* ---------------------------------------------------------------- extracción */
const BLOCK = "address,article,aside,blockquote,br,dd,div,dl,dt,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,ol,p,pre,section,table,td,th,tr,ul,option,button";

function raices($, m) {
  if (!m.selector) return null;
  let r;
  try { r = $(m.selector); } catch { throw new Error("El selector CSS no es válido."); }
  if (!r.length) throw new Error(`El selector «${m.selector}» no encontró nada en la página.`);
  return r;
}

function extraer(raw, m) {
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
    return lineasDe(html);
  }
  $("script,style,noscript,template,svg,iframe,link,meta").remove();
  $(BLOCK).after("\n");
  const r = raices($, m);
  const texto = r ? r.map((i, e) => $(e).text()).get().join("\n") : $.root().text();
  return texto.split("\n").map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function limpiarAleatorio(line) {
  return line
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "‹id›")
    .replace(/\b\d{10,}\b/g, "‹n›")
    .replace(/(?=[A-Za-z0-9_+-]*\d)(?=[A-Za-z0-9_+-]*[A-Za-z])[A-Za-z0-9_+-]{20,}={0,2}/g, "‹código›");
}
function filtrar(lines, m) {
  const reglas = lineasDe(m.ignore);
  let out = reglas.length ? lines.filter(l => !reglas.some(r => l.includes(r))) : lines;
  if (m.random !== false) out = out.map(limpiarAleatorio);
  return out;
}
const palabras = m => lineasDe(m.keywords).map(normTxt);
const coincide = (t, kws) => !kws.length || kws.some(k => normTxt(t).includes(k));

const esFeed = raw => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<\?xml-stylesheet[^>]*>\s*)*<(rss|feed|rdf:RDF)\b/i.test(raw);

function leerFeed(raw, m) {
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

function leerEnlaces(raw, m) {
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

function leerNumero(txt) {
  const mt = String(txt).replace(/[\s\u00a0\u202f]/g, "").match(/-?\d[\d.,']*/);
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
const escTg = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function enviarTelegram({ titulo, lineas = [], url }) {
  const { TELEGRAM_TOKEN: token, TELEGRAM_CHAT_ID: chat } = process.env;
  if (!token || !chat) return false;
  let texto = `<b>${escTg(titulo)}</b>`;
  const cuerpo = lineas.slice(0, 8).map(l => l.href
    ? `• <a href="${escTg(l.href)}">${escTg(recorta(l.text, 200))}</a>`
    : `• ${escTg(recorta(l.text, 200))}`);
  if (lineas.length > 8) cuerpo.push(`… y ${lineas.length - 8} más`);
  if (cuerpo.length) texto += "\n" + cuerpo.join("\n");
  if (url) texto += `\n\n${escTg(url)}`;
  texto += "\n<i>(desde GitHub Actions)</i>";
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text: texto, parse_mode: "HTML", disable_web_page_preview: true })
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error("Telegram: " + (j.description || `error ${res.status}`));
  return true;
}

async function enviarNtfy({ titulo, lineas = [], url }) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return false;
  const server = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
  const click = lineas.length === 1 && lineas[0].href ? lineas[0].href : url;
  const res = await fetch(server, {
    method: "POST",
    body: JSON.stringify({
      topic, title: titulo,
      message: lineas.slice(0, 8).map(l => "• " + recorta(l.text, 200)).join("\n") || url || titulo,
      click: click || undefined, priority: 4, tags: ["eyes", "cloud"]
    })
  });
  if (!res.ok) throw new Error(`ntfy: error ${res.status}`);
  return true;
}

let canalesAvisados = false;
async function avisar(msg) {
  const r = await Promise.allSettled([enviarTelegram(msg), enviarNtfy(msg)]);
  r.filter(x => x.status === "rejected").forEach(x => console.error("  ✗", x.reason.message));
  if (!r.some(x => x.status === "fulfilled" && x.value) && !canalesAvisados) {
    canalesAvisados = true;
    console.warn("  ⚠ No hay canal configurado: crea los secretos TELEGRAM_TOKEN y TELEGRAM_CHAT_ID, o NTFY_TOPIC.");
  }
}

/* ---------------------------------------------------------------- revisión */
async function descargar(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 Vigia/1.0",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"
    },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.trim()) throw new Error("respuesta vacía");
  return text;
}

async function revisar(m, st) {
  const raw = await descargar(m.url);
  const firma = hash(JSON.stringify([m.url, m.watch, m.mode, m.selector, m.ignore, m.random, m.numCond, m.numValor]));
  const rebase = st.firma !== firma;
  st.firma = firma;

  if (m.watch === "numero") {
    if (!m.selector) throw new Error("Falta el selector CSS del número.");
    const $ = cheerio.load(raw);
    const el = raices($, m).first();
    const txt = (el.attr("content") || el.attr("value") || el.text() || "").replace(/\s+/g, " ").trim();
    const v = leerNumero(txt);
    if (v == null || isNaN(v)) throw new Error(`No hay ningún número en «${recorta(txt, 60)}».`);
    const prev = st.numero;
    st.numero = v;
    if (prev == null || rebase) return `referencia: ${fmtNum(v)}`;
    if (v === prev) return `sin cambios (${fmtNum(v)})`;
    const lim = Number(m.numValor), cond = m.numCond || "cambio";
    const ok = cond === "cambio" || (cond === "baja" && v < prev) || (cond === "sube" && v > prev)
      || (cond === "menor" && !isNaN(lim) && v < lim && v < prev)
      || (cond === "mayor" && !isNaN(lim) && v > lim && v > prev);
    const linea = `${fmtNum(prev)} → ${fmtNum(v)}`;
    if (ok) await avisar({ titulo: `${v < prev ? "Ha bajado" : "Ha subido"} en ${host(m.url)}`, lineas: [{ text: linea }], url: m.url });
    return `${linea}${ok ? " (avisado)" : " (no cumple la condición)"}`;
  }

  const feed = esFeed(raw);
  if (feed || m.watch === "nuevo" || m.watch === "enlaces") {
    const kind = feed ? "feed" : m.watch;
    let items = feed ? leerFeed(raw, m)
      : kind === "enlaces" ? leerEnlaces(raw, m)
      : filtrar(extraer(raw, m), m).map(l => ({ key: "t:" + hash(l), text: l }));
    const reglas = lineasDe(m.ignore);
    if (reglas.length) items = items.filter(i => !reglas.some(r => i.text.includes(r) || (i.href || "").includes(r)));
    const claves = items.map(i => i.key);
    if (!st.seen || rebase || st.kind !== kind) {
      st.seen = [...new Set(claves)].slice(0, MAX_SEEN);
      st.kind = kind;
      return `referencia: ${items.length} elementos`;
    }
    const seen = new Set(st.seen), ahora = new Set();
    const nuevos = items.filter(i => !seen.has(i.key) && !ahora.has(i.key) && ahora.add(i.key));
    const kws = palabras(m);
    const relevantes = nuevos.filter(i => coincide(i.text + " " + (i.href || ""), kws));
    st.seen = [...new Set([...claves, ...st.seen])].slice(0, MAX_SEEN);
    if (relevantes.length) {
      const titulo = relevantes.length === 1 ? `Novedad en ${host(m.url)}` : `${relevantes.length} novedades en ${host(m.url)}`;
      await avisar({ titulo, lineas: relevantes, url: relevantes.length === 1 && relevantes[0].href ? relevantes[0].href : m.url });
      return `${relevantes.length} novedades (avisado)`;
    }
    return nuevos.length ? `${nuevos.length} novedades sin palabras clave` : "nada nuevo";
  }

  // Cualquier cambio
  const lines = filtrar(extraer(raw, m), m);
  const h = hash(lines.join("\n"));
  const antes = st.hash, antesLineas = st.lines;
  st.hash = h;
  st.lines = lines.length <= 3000 ? lines : null;
  st.kind = "cambios";
  if (!antes || rebase) return `referencia: ${lines.length} líneas`;
  if (h === antes) return "sin cambios";
  let added = [], removed = [];
  if (antesLineas) {
    const o = new Set(antesLineas), n = new Set(lines);
    added = lines.filter(x => !o.has(x));
    removed = antesLineas.filter(x => !n.has(x));
  }
  const kws = palabras(m);
  if (kws.length && antesLineas && !added.some(l => coincide(l, kws))) return "cambió, sin palabras clave";
  const lineas = antesLineas
    ? [...added.slice(0, 8).map(t => ({ text: "+ " + t })), ...removed.slice(0, 3).map(t => ({ text: "− " + t }))]
    : [{ text: "La página ha cambiado." }];
  await avisar({ titulo: `Cambio en ${host(m.url)}`, lineas, url: m.url });
  return `cambio +${added.length}/−${removed.length} (avisado)`;
}

/* ---------------------------------------------------------------- estado cifrado */
// En repositorios públicos, el estado (texto de las páginas) se cifra con una clave derivada de los secretos.
const secreto = process.env.VIGIA_CLAVE || process.env.TELEGRAM_TOKEN || process.env.NTFY_TOPIC || "";
const clave = secreto ? createHash("sha256").update("vigia:" + secreto).digest() : null;

function cifrar(obj) {
  const json = JSON.stringify(obj);
  if (!clave) return json;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", clave, iv);
  const datos = Buffer.concat([c.update(json, "utf8"), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), datos: datos.toString("base64") });
}
function descifrar(texto) {
  const o = JSON.parse(texto);
  if (!o || o.v !== 1 || !o.datos) return o;
  if (!clave) throw new Error("estado cifrado pero sin secretos");
  const d = createDecipheriv("aes-256-gcm", clave, Buffer.from(o.iv, "base64"));
  d.setAuthTag(Buffer.from(o.tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(o.datos, "base64")), d.final()]).toString("utf8"));
}

/* ---------------------------------------------------------------- principal */
let cfg;
try { cfg = JSON.parse(process.env.VIGIA_CONFIG || "{}"); }
catch { console.error("VIGIA_CONFIG no es un JSON válido. Vuelve a pulsar «Enviar lista a GitHub»."); process.exit(1); }
const monitors = Array.isArray(cfg.monitors) ? cfg.monitors : [];

let estado = {};
try { estado = descifrar(await readFile(ESTADO, "utf8")) || {}; }
catch { console.log("Sin estado previo válido: se tomarán referencias nuevas."); }

// Olvidar páginas que ya no están en la lista
for (const id of Object.keys(estado)) if (!monitors.some(m => m.id === id)) delete estado[id];

const resumen = [];
for (const [idx, m] of monitors.entries()) {
  const st = (estado[m.id] ||= {});
  const intervalo = Math.max(60, Number(m.interval) || 300) * 1000;
  if (st.last && Date.now() - st.last < intervalo - TOLERANCIA_MS) { resumen.push([`Página ${idx + 1}`, "aún no toca"]); continue; }
  if (!enHorario(m)) { resumen.push([`Página ${idx + 1}`, "fuera de horario"]); continue; }
  st.last = Date.now();
  try {
    const r = await revisar(m, st);
    st.fails = 0;
    resumen.push([`Página ${idx + 1}`, r]);
  } catch (e) {
    st.fails = (st.fails || 0) + 1;
    resumen.push([`Página ${idx + 1}`, `error ${st.fails}: ${e.message}`]);
    if (st.fails === 3) await avisar({ titulo: `Vigía no puede comprobar ${host(m.url)}`, lineas: [{ text: e.message }], url: m.url });
  }
}

await writeFile(ESTADO, cifrar(estado));

// Los registros de Actions son públicos en repositorios públicos: no se muestran las direcciones
for (const [nombre, r] of resumen) console.log(`• ${nombre}: ${r}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const filas = resumen.map(([n, r]) => `| ${n} | ${String(r).replace(/\|/g, "\\|")} |`).join("\n");
  await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `### Vigía\n\n${monitors.length ? `| Página | Resultado |\n|---|---|\n${filas}` : "No hay páginas en VIGIA_CONFIG."}\n`);
}
