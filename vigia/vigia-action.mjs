// Vigía para GitHub Actions
// Lee la lista de páginas de la variable privada VIGIA_CONFIG, las comprueba
// y avisa por Telegram y/o ntfy. El estado se guarda en ESTADO (caché de Actions).

import { readFile, writeFile, appendFile } from "node:fs/promises";
import * as cheerio from "cheerio";
import {
  MAX_SEEN, hash, host, recorta, fmtNum, lineasDe, enHorario,
  raices, extraer, filtrar, palabras, coincide,
  esFeed, leerFeed, leerEnlaces, leerNumero, escTg,
  derivarClave, cifrar, descifrar
} from "./lib.mjs";

const ESTADO = process.env.ESTADO || "vigia-estado.json";
const TOLERANCIA_MS = 90_000; // el cron de GitHub no es exacto
const MAX_BYTES = 8 * 1024 * 1024; // páginas enormes: mejor avisar que agotar la memoria

const avisos = []; // problemas de configuración, para el resumen del job
const anotar = texto => { if (!avisos.includes(texto)) avisos.push(texto); };

/* ---------------------------------------------------------------- avisos */
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
    body: JSON.stringify({ chat_id: chat, text: texto, parse_mode: "HTML", disable_web_page_preview: true }),
    signal: AbortSignal.timeout(20_000)
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error("Telegram: " + (j.description || `error ${res.status}`));
  return true;
}

// Servidores ntfy privados: NTFY_TOKEN (tk_…) o NTFY_USER + NTFY_PASS.
function autorizacionNtfy() {
  const { NTFY_TOKEN: token, NTFY_USER: user, NTFY_PASS: pass } = process.env;
  if (token) return `Bearer ${token}`;
  if (user && pass) return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  return null;
}

async function enviarNtfy({ titulo, lineas = [], url }) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return false;
  const server = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
  const click = lineas.length === 1 && lineas[0].href ? lineas[0].href : url;
  const auth = autorizacionNtfy();
  const res = await fetch(server, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify({
      topic, title: titulo,
      message: lineas.slice(0, 8).map(l => "• " + recorta(l.text, 200)).join("\n") || url || titulo,
      click: click || undefined, priority: 4, tags: ["eyes", "cloud"]
    }),
    signal: AbortSignal.timeout(20_000)
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error("ntfy: acceso denegado. Si tu servidor pide identificación, crea el secreto NTFY_TOKEN (o NTFY_USER y NTFY_PASS).");
  }
  if (!res.ok) throw new Error(`ntfy: error ${res.status}`);
  return true;
}

async function avisar(msg) {
  const r = await Promise.allSettled([enviarTelegram(msg), enviarNtfy(msg)]);
  r.filter(x => x.status === "rejected").forEach(x => {
    console.error("  ✗", x.reason.message);
    anotar(`No se pudo enviar un aviso — ${x.reason.message}`);
  });
  if (!r.some(x => x.status === "fulfilled" && x.value)) {
    anotar("**No hay ningún canal de avisos configurado**: crea los secretos `TELEGRAM_TOKEN` y `TELEGRAM_CHAT_ID`, o `NTFY_TOPIC`. Vigía está detectando cambios pero no puede avisarte de ellos.");
  }
}

/* ---------------------------------------------------------------- revisión */
const REINTENTABLE = new Set([408, 429, 500, 502, 503, 504]);

const espera = ms => new Promise(r => setTimeout(r, ms));

async function pedir(url, cabeceras) {
  return fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 Vigia/1.0",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
      ...cabeceras
    },
    redirect: "follow",
    signal: AbortSignal.timeout(25_000)
  });
}

// Devuelve { cambiada:false } si el servidor confirma que la página no ha cambiado (HTTP 304).
async function descargar(url, validador) {
  const cond = {};
  if (validador?.etag) cond["If-None-Match"] = validador.etag;
  if (validador?.modificado) cond["If-Modified-Since"] = validador.modificado;

  // Un tropiezo puntual (red, 503, 429) no debería contar como página caída,
  // pero como máximo dos intentos: con muchas páginas el job tiene su tiempo contado.
  let res = null, fallo;
  for (let intento = 0; intento < 2 && !res; intento++) {
    if (intento) await espera(2500);
    try {
      const r = await pedir(url, cond);
      if (REINTENTABLE.has(r.status)) fallo = new Error(`HTTP ${r.status}`);
      else res = r;
    } catch (e) {
      fallo = new Error(e.name === "TimeoutError" ? "la página tardó demasiado en responder" : e.message);
    }
  }
  if (!res) throw fallo;

  if (res.status === 304) return { cambiada: false };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const largo = Number(res.headers.get("content-length"));
  if (largo > MAX_BYTES) throw new Error(`la página pesa demasiado (${Math.round(largo / 1048576)} MB)`);
  const text = await res.text();
  if (!text.trim()) throw new Error("respuesta vacía");
  if (text.length > MAX_BYTES) throw new Error("la página pesa demasiado");

  return {
    cambiada: true,
    text,
    etag: res.headers.get("etag") || null,
    modificado: res.headers.get("last-modified") || null
  };
}

async function revisar(m, st) {
  const firma = hash(JSON.stringify([m.url, m.watch, m.mode, m.selector, m.ignore, m.random, m.numCond, m.numValor]));
  const rebase = st.firma !== firma;
  st.firma = firma;

  // Solo preguntamos «¿ha cambiado?» si ya teníamos una referencia con esta configuración.
  const conRef = !rebase && (st.hash || st.seen || st.numero != null);
  const bajada = await descargar(m.url, conRef ? st : null);
  if (!bajada.cambiada) return "sin cambios (el servidor dice que no)";
  st.etag = bajada.etag;
  st.modificado = bajada.modificado;
  const raw = bajada.text;

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

/* ---------------------------------------------------------------- principal */
// El estado guarda el texto de las páginas vigiladas, y en un repositorio público
// la caché de Actions la puede leer cualquiera: por eso se cifra.
if (!process.env.VIGIA_CLAVE && (process.env.TELEGRAM_TOKEN || process.env.NTFY_TOPIC)) {
  anotar("Falta el secreto `VIGIA_CLAVE`: el estado se está cifrando con tu token de Telegram (o tu tema de ntfy) como clave. Crea un `VIGIA_CLAVE` propio (ver README) para no reutilizar un secreto de otro uso.");
}
if (!process.env.VIGIA_CLAVE && !process.env.TELEGRAM_TOKEN && !process.env.NTFY_TOPIC) {
  anotar("El estado se guarda **sin cifrar** porque no hay ningún secreto. En un repositorio público, cualquiera podría leer qué páginas vigilas: crea el secreto `VIGIA_CLAVE`.");
}
const clave = derivarClave(process.env.VIGIA_CLAVE || process.env.TELEGRAM_TOKEN || process.env.NTFY_TOPIC || "");

let cfg;
try { cfg = JSON.parse(process.env.VIGIA_CONFIG || "{}"); }
catch { console.error("VIGIA_CONFIG no es un JSON válido. Vuelve a pulsar «Enviar lista a GitHub»."); process.exit(1); }
const monitors = Array.isArray(cfg.monitors) ? cfg.monitors : [];

let estado = {};
try { estado = descifrar(await readFile(ESTADO, "utf8"), clave) || {}; }
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

await writeFile(ESTADO, cifrar(estado, clave));

// Los registros de Actions son públicos en repositorios públicos: no se muestran las direcciones
for (const [nombre, r] of resumen) console.log(`• ${nombre}: ${r}`);
for (const a of avisos) console.warn("⚠ " + a.replace(/[*`]/g, ""));

if (process.env.GITHUB_STEP_SUMMARY) {
  const filas = resumen.map(([n, r]) => `| ${n} | ${String(r).replace(/\|/g, "\\|")} |`).join("\n");
  const tabla = monitors.length ? `| Página | Resultado |\n|---|---|\n${filas}` : "No hay páginas en VIGIA_CONFIG.";
  const alertas = avisos.length ? `\n\n#### ⚠️ Revisa esto\n\n${avisos.map(a => `- ${a}`).join("\n")}` : "";
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Vigía\n\n${tabla}${alertas}\n`);
}
