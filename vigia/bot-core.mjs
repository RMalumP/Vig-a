// Menús y comandos del bot de Telegram de Vigía.
//
// Lo usan dos «atendedores» con el mismo código: la página abierta en el
// navegador (responde al momento) y GitHub Actions (responde en cada ejecución
// cuando la página está cerrada). Cada uno aporta un «ctx» con sus datos y sus
// formas de guardar cambios; aquí solo se decide qué mostrar y qué pedir.
//
// Sin dependencias ni APIs de Node: la página lo carga tal cual con import().
//
// Todo botón describe el estado final («pausar», no «alternar pausa») para que,
// si por casualidad lo atienden los dos, el resultado sea el mismo.

export const PREFIJO = "m"; // callback_data de los menús: «m:acción:…»
export const ESPERA_ACTIONS = 30; // s que GitHub Actions deja a la página para responder (la página contesta en un segundo)
const POR_PAGINA = 8;
const FRECUENCIAS = [[60, "1 min"], [120, "2 min"], [300, "5 min"], [900, "15 min"], [1800, "30 min"], [3600, "1 h"], [10800, "3 h"], [21600, "6 h"], [86400, "24 h"]];
const MODOS = { nuevo: "Información nueva", cambios: "Cualquier cambio", enlaces: "Enlaces nuevos", numero: "Un número" };

export const COMANDOS = [
  ["menu", "Menú principal"],
  ["paginas", "Páginas vigiladas"],
  ["estado", "Estado de Vigía y de cada página"],
  ["nueva", "Vigilar una página: /nueva https://…"],
  ["pausar", "Pausar todas las páginas"],
  ["reanudar", "Reanudar todas las páginas"],
  ["ejecutar", "Lanzar GitHub Actions ahora"],
  ["ayuda", "Qué puedo hacer"]
];

/* ---------------------------------------------------------------- utilidades */
export const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const recorta = (s, n) => (s = String(s ?? "")).length > n ? s.slice(0, n - 1) + "…" : s;
export function h6(str) { // huella corta y estable para nombrar una regla en un botón
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (Math.imul(h, 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 6);
}
export const corta = u => { try { const x = new URL(u); return x.host.replace(/^www\./, "") + (x.pathname.length > 1 ? x.pathname : "") + x.search; } catch { return String(u); } };
export function hace(t, ahora = Date.now()) {
  if (!t) return "nunca";
  const s = Math.max(0, Math.round((ahora - t) / 1000));
  if (s < 60) return "hace un momento";
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86400)} d`;
}
export const cadaTxt = s => { const f = FRECUENCIAS.find(([v]) => v === Number(s)); if (f) return f[1];
  s = Number(s) || 0; return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 360) / 10} h`; };
// «10 min», «90 s», «2 h», «1,5 horas», «1 día»; un número solo son minutos.
export function leerDuracion(txt) {
  const m = String(txt).trim().toLowerCase().match(/^(\d+(?:[.,]\d+)?)\s*(s|seg|segs?|segundos?|m|min|mins|minutos?|h|hs?|horas?|d|d[ií]as?)?\.?$/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(",", ".")), u = (m[2] || "min")[0];
  const s = Math.round(n * ({ s: 1, m: 60, h: 3600, d: 86400 }[u]));
  return s > 0 ? s : null;
}

// Nombre para listas: la dirección corta y, si hay varias entradas con la misma
// dirección, lo que las distingue (qué vigila, cómo compara, cada cuánto).
export function nombre(p, todas = []) {
  const base = corta(p.url);
  const iguales = todas.filter(x => corta(x.url) === base);
  if (iguales.length < 2) return base;
  const rasgo = x => [MODOS[x.watch] || x.watch, x.watch === "nuevo" || x.watch === "cambios" ? (x.mode === "html" ? "HTML" : "texto") : ""].filter(Boolean).join(" · ");
  let extra = rasgo(p);
  if (iguales.filter(x => rasgo(x) === extra).length > 1) extra += ` · cada ${cadaTxt(p.interval)}`;
  return `${base} · ${extra}`;
}
const describeNorma = n => `${n.attr} de ${n.tag === "*" ? "cualquier etiqueta" : `<${n.tag}>`}`;
const emoji = p => p.paused ? "⏸" : p.estado === "error" ? "🔴" : p.estado === "changed" ? "🔵" : p.ultima ? "🟢" : "⚪";
const lugar = p => p.cloud ? "☁️" : "🖥";
const boton = (text, data) => ({ text, callback_data: data });
const filas = (...f) => f.filter(x => x && x.length);

/* --------------------------------------------- reparto de la cola de Telegram */
// Telegram guarda una sola cola por bot y la leen dos. Confirmarla hasta un
// punto la borra para los dos, así que cada uno solo confirma hasta la primera
// novedad que no le toca. Lo suyo que quede detrás se vuelve a leer: cada uno
// lleva la cuenta de lo ya atendido. Lo que nadie recoge, Telegram lo borra a las 24 h.
//
// clasificar() → "mia" (la atiendo), "ajena" (la dejo) o "libre" (se puede tirar).
export function clasificar(u, { origen, chat, ahora = Date.now() }) {
  const q = u.callback_query;
  if (q) {
    const pref = String(q.data || "").split(":")[0];
    const aviso = origen === "web" ? ["ws", "wd", "wt"] : ["s", "d"];
    const otro = origen === "web" ? ["s", "d"] : ["ws", "wd", "wt"];
    if (aviso.includes(pref)) return "mia";
    if (otro.includes(pref)) return "ajena";
    if (pref !== PREFIJO) return "libre";
    if (origen === "web") return "mia";
    // GitHub Actions solo atiende menús que la página no ha atendido a tiempo.
    const visto = q.message ? (q.message.edit_date || q.message.date) : 0;
    return ahora / 1000 - visto >= ESPERA_ACTIONS ? "mia" : "ajena";
  }
  const msg = u.message;
  const edad = ahora / 1000 - ((msg || u.edited_message || u.channel_post || u.my_chat_member)?.date ?? 0);
  if (msg && typeof msg.text === "string" && mismoChat(msg.chat, chat)) {
    if (origen === "web") return "mia";
    return edad >= ESPERA_ACTIONS ? "mia" : "ajena";
  }
  // Mensajes recientes de otros chats: la página los usa para detectar el chat ID.
  return edad <= 3600 ? "ajena" : "libre";
}

export function repartir(updates, opciones) {
  const mias = [];
  let offset = null, bloqueado = false;
  // Si la web respondió pero no pudo confirmar (había delante un botón de un
  // aviso de GitHub Actions), GitHub Actions vería después esos mensajes. Una
  // pulsación sobre un mensaje del bot enviado después de un mensaje tuyo
  // demuestra que ya se contestó: ese mensaje se descarta.
  const respuestas = (updates || []).map(u => u.callback_query?.message?.date || 0);
  const ultimaRespuesta = Math.max(0, ...respuestas);
  for (const u of updates || []) {
    let c = clasificar(u, opciones);
    if (c === "mia" && opciones.origen === "actions" && u.message && u.message.date < ultimaRespuesta) c = "libre";
    if (c === "mia") mias.push(u);
    if (c === "ajena") bloqueado = true;
    if (!bloqueado) offset = u.update_id + 1;
  }
  return { mias, offset };
}

export const mismoChat = (chat, destino) =>
  !!chat && (String(chat.id) === String(destino) || (!!chat.username && `@${chat.username}`.toLowerCase() === String(destino).toLowerCase()));

/* ---------------------------------------------------------------- pantallas */
// ctx.info() → { origen, editable, motivo, lineas: [texto…] }
function indicador(ctx) {
  const i = ctx.info();
  const partes = [i.origen === "web"
    ? "🟢 <b>Web abierta</b>: te respondo al momento."
    : "🟠 <b>Web cerrada</b>: te responde GitHub Actions en cada ejecución, así que las respuestas llegan con retraso."];
  (i.lineas || []).forEach(l => partes.push(`<i>${esc(l)}</i>`));
  if (!i.editable) partes.push(`🔒 <i>Solo lectura: ${esc(i.motivo || "no se pueden guardar cambios desde aquí")}</i>`);
  return partes.join("\n");
}

function inicio(ctx) {
  const ps = ctx.paginas(), ahora = ctx.ahora();
  const activas = ps.filter(p => !p.paused).length, errores = ps.filter(p => !p.paused && p.estado === "error").length;
  const avisos = ps.reduce((a, p) => a + (p.hist || []).filter(h => ahora - h.t < 86400000).length, 0);
  const texto = `<b>🛰️ Vigía</b>\n${indicador(ctx)}\n\n` +
    `${ps.length} ${ps.length === 1 ? "página" : "páginas"} · ${activas} ${activas === 1 ? "activa" : "activas"}` +
    `${errores ? ` · 🔴 ${errores} con error` : ""} · ${avisos} ${avisos === 1 ? "aviso" : "avisos"} en 24 h`;
  const todasPausadas = ps.length && !activas;
  return { texto, teclado: filas(
    [boton("📋 Páginas", "m:l:0"), boton("📊 Estado", "m:e")],
    [boton("🌐 Reglas globales", "m:g"), boton("➕ Añadir página", "m:n")],
    [todasPausadas ? boton("▶️ Reanudar todo", "m:pt:0") : boton("⏸ Pausar todo", "m:pt:1"), boton("🚀 Ejecutar GitHub", "m:x")],
    [boton("❓ Ayuda", "m:a")]
  ) };
}

function lista(ctx, pag = 0) {
  const ps = ctx.paginas();
  if (!ps.length) return { texto: `<b>📋 Páginas</b>\n\nNo hay páginas. Añade una con /nueva https://…`, teclado: [[boton("➕ Añadir página", "m:n"), boton("🏠 Menú", "m:h")]] };
  const total = Math.ceil(ps.length / POR_PAGINA);
  pag = Math.min(Math.max(0, Number(pag) || 0), total - 1);
  const trozo = ps.slice(pag * POR_PAGINA, (pag + 1) * POR_PAGINA);
  const nav = [];
  if (pag > 0) nav.push(boton("⬅️", `m:l:${pag - 1}`));
  if (total > 1) nav.push(boton(`${pag + 1}/${total}`, `m:l:${pag}`));
  if (pag < total - 1) nav.push(boton("➡️", `m:l:${pag + 1}`));
  const etiqueta = p => { const n = nombre(p, ps); return n.length > 52 ? "…" + n.slice(-51) : n; };
  return {
    texto: `<b>📋 Páginas</b> (${ps.length})\n🟢 bien · 🔵 con aviso · 🔴 error · ⏸ en pausa\n☁️ GitHub Actions · 🖥 solo navegador\n\nElige una para ver sus ajustes:`,
    teclado: [...trozo.map(p => [boton(`${emoji(p)} ${lugar(p)} ${etiqueta(p)}`, `m:p:${p.id}`)]), nav, [boton("🏠 Menú", "m:h")]].filter(f => f.length)
  };
}

function ficha(ctx, p) {
  const ahora = ctx.ahora(), g = ctx.global();
  const n24 = (p.hist || []).filter(h => ahora - h.t < 86400000).length;
  const nFiltros = p.ignore.length + p.normas.length + (p.orden ? 1 : 0);
  const nGlobal = g.ignore.length + g.normas.length + (g.orden ? 1 : 0);
  const estado = !p.cloud && ctx.info().origen === "actions" ? "🖥 La comprueba la web: ábrela para ver su estado"
    : p.paused ? "⏸ En pausa"
    : p.estado === "error" ? `🔴 Error: ${esc(recorta(p.mensaje || "", 160))}`
    : `${emoji(p)} Última comprobación ${hace(p.ultima, ahora)}`;
  const texto = [
    `<b>${esc(nombre(p, ctx.paginas()))}</b>`,
    esc(p.url),
    "",
    `<b>Avisa cuando:</b> ${esc(MODOS[p.watch] || p.watch)}${p.watch === "nuevo" || p.watch === "cambios" ? ` (${p.mode === "html" ? "código HTML" : "texto visible"})` : ""}`,
    `<b>Frecuencia:</b> cada ${esc(cadaTxt(p.interval))}`,
    `<b>Estado:</b> ${estado}`,
    `<b>Último aviso:</b> ${hace(p.ultimoAviso, ahora)} · ${n24} en 24 h`,
    `<b>Filtros:</b> ${nFiltros ? `${nFiltros} propios` : "ninguno propio"}${nGlobal ? ` + ${nGlobal} globales` : ""}`,
    p.keywords.length ? `<b>Solo si contiene:</b> ${esc(p.keywords.join(", "))}` : "",
    `<b>Dónde:</b> ${p.cloud ? "☁️ GitHub Actions" : "🖥 solo en el navegador (la comprueba la web mientras está abierta)"}`
  ].filter(l => l !== "").join("\n");
  return { texto, teclado: filas(
    [boton("⏱ Frecuencia", `m:f:${p.id}`), boton("🔕 Filtros", `m:fl:${p.id}`)],
    [p.paused ? boton("▶️ Reanudar", `m:pp:${p.id}:0`) : boton("⏸ Pausar", `m:pp:${p.id}:1`), boton("📜 Últimos avisos", `m:hi:${p.id}`)],
    [boton("🗑 Quitar", `m:del:${p.id}`), boton("⬅️ Páginas", "m:l:0")]
  ) };
}

function frecuencia(ctx, p) {
  const ops = FRECUENCIAS.map(([v, t]) => boton(`${Number(p.interval) === v ? "✅ " : ""}${t}`, `m:fs:${p.id}:${v}`));
  const propia = !FRECUENCIAS.some(([v]) => v === Number(p.interval));
  const nota = p.cloud ? "\n\n<i>En GitHub Actions el mínimo es 1 minuto, y solo se cumple si el reloj externo (cron-job.org) lo despierta así de a menudo. Sin él, GitHub puede tardar horas.</i>"
    : "\n\n<i>Mínimo 10 segundos. Esta página la comprueba la web mientras está abierta.</i>";
  return { texto: `<b>⏱ Frecuencia</b>\n${esc(nombre(p, ctx.paginas()))}\n\nAhora: cada ${esc(cadaTxt(p.interval))}. ¿Cada cuánto la compruebo?${nota}`,
    teclado: [ops.slice(0, 3), ops.slice(3, 6), ops.slice(6), [boton(`${propia ? "✅ " : ""}✏️ Personalizada${propia ? ` (${cadaTxt(p.interval)})` : ""}`, `m:fp:${p.id}`)], [boton("⬅️ Volver", `m:p:${p.id}`)]] };
}

function filtros(ctx, p) {
  const g = ctx.global();
  const lineas = [`<b>🔕 Filtros</b>\n${esc(corta(p.url))}`, ""];
  const tec = [];
  if (!p.ignore.length && !p.normas.length && !p.orden) lineas.push("Esta página no tiene filtros propios.");
  p.ignore.forEach(r => { lineas.push(`• Ignora: <code>${esc(recorta(r, 90))}</code>`); tec.push([boton(`❌ ${recorta(r, 34)}`, `m:fx:${p.id}:${h6(r)}`)]); });
  p.normas.forEach(n => { lineas.push(`• No mira ${esc(describeNorma(n))}`); tec.push([boton(`❌ ${recorta(describeNorma(n), 34)}`, `m:nx:${p.id}:${h6(n.tag + " " + n.attr)}`)]); });
  if (p.orden) { lineas.push("• No avisa si solo cambia el orden"); tec.push([boton("❌ Volver a avisar por el orden", `m:ox:${p.id}`)]); }
  const nG = g.ignore.length + g.normas.length + (g.orden ? 1 : 0);
  if (nG) lineas.push(`\nAdemás se aplican ${nG} ${nG === 1 ? "regla global" : "reglas globales"}.`);
  lineas.push("\nPulsa ❌ para quitar un filtro.");
  tec.push([boton("➕ Ignorar un texto", `m:fa:${p.id}`), boton("⬅️ Volver", `m:p:${p.id}`)]);
  return { texto: lineas.join("\n"), teclado: tec };
}

function globales(ctx) {
  const g = ctx.global();
  const lineas = ["<b>🌐 Reglas globales</b>\nSe aplican a todas las páginas.", ""];
  const tec = [];
  if (!g.ignore.length && !g.normas.length && !g.orden) lineas.push("No hay reglas globales.");
  g.ignore.forEach(r => { lineas.push(`• Ignora: <code>${esc(recorta(r, 90))}</code>`); tec.push([boton(`❌ ${recorta(r, 34)}`, `m:gx:${h6(r)}`)]); });
  g.normas.forEach(n => { lineas.push(`• No mira ${esc(describeNorma(n))}`); tec.push([boton(`❌ ${recorta(describeNorma(n), 34)}`, `m:gnx:${h6(n.tag + " " + n.attr)}`)]); });
  lineas.push(`• Avisar si solo cambia el orden: ${g.orden ? "no" : "sí"}`);
  tec.push([g.orden ? boton("🔔 Avisar también por el orden", "m:go:0") : boton("🔕 No avisar si solo cambia el orden", "m:go:1")]);
  tec.push([boton("➕ Ignorar un texto", "m:ga"), boton("🏠 Menú", "m:h")]);
  return { texto: lineas.join("\n"), teclado: tec };
}

function historial(ctx, p) {
  const h = (p.hist || []).slice(0, 6);
  const ahora = ctx.ahora();
  const cuerpo = h.length ? h.map(e => `• <b>${esc(hace(e.t, ahora))}</b>: ${esc(recorta(e.titulo, 80))}${e.linea ? `\n  <i>${esc(recorta(e.linea, 120))}</i>` : ""}`).join("\n")
    : "Todavía no hay avisos de esta página.";
  return { texto: `<b>📜 Últimos avisos</b>\n${esc(corta(p.url))}\n\n${cuerpo}`, teclado: [[boton("⬅️ Volver", `m:p:${p.id}`)]] };
}

function estado(ctx) {
  const ps = ctx.paginas(), ahora = ctx.ahora();
  const lin = ps.slice(0, 25).map(p => `${emoji(p)} ${esc(recorta(corta(p.url), 45))} · ${p.paused ? "en pausa" : p.estado === "error" ? "error" : hace(p.ultima, ahora)}`);
  if (ps.length > 25) lin.push(`… y ${ps.length - 25} más`);
  return { texto: `<b>📊 Estado</b>\n${indicador(ctx)}\n\n${lin.join("\n") || "No hay páginas."}`,
    teclado: [[boton("🔄 Actualizar", "m:e"), boton("🏠 Menú", "m:h")]] };
}

function ayuda(ctx) {
  const i = ctx.info();
  const texto = [
    "<b>❓ Qué puedo hacer</b>", "",
    ...COMANDOS.map(([c, d]) => `/${c} · ${esc(d)}`), "",
    "Con la <b>web de Vigía abierta</b> respondo al momento. Con la web cerrada responde GitHub Actions cuando se ejecuta, que puede tardar.",
    i.origen === "actions" && !i.editable ? "\nPara cambiar ajustes con la web cerrada, crea el secreto <code>VIGIA_GH_TOKEN</code> (ver README)." : ""
  ].join("\n");
  return { texto, teclado: [[boton("🏠 Menú", "m:h")]] };
}

const confirmar = (texto, si, no) => ({ texto, teclado: [[boton(si[0], si[1]), boton(no[0], no[1])]] });

/* ---------------------------------------------------------------- atender */
// Devuelve qué hacer: { editar | enviar: {texto, teclado}, forzar: texto de ForceReply, aviso: texto breve }.
export async function atenderBoton(data, ctx, msgTexto = "") {
  const [, acc, a, b] = String(data).split(":");
  const pag = id => ctx.paginas().find(p => p.id === id);
  const soloLectura = () => { const i = ctx.info(); return i.editable ? null : { aviso: `🔒 ${recorta(i.motivo || "Solo lectura", 180)}` }; };
  const cambiar = async (id, cambios, vuelta) => {
    const bloqueo = soloLectura(); if (bloqueo) return bloqueo;
    const r = await ctx.cambiar(id, cambios);
    const p = pag(id);
    return { editar: p ? vuelta(p) : inicio(ctx), aviso: r?.nota || "✅ Hecho" };
  };
  const cambiarG = async (cambios) => {
    const bloqueo = soloLectura(); if (bloqueo) return bloqueo;
    const r = await ctx.cambiarGlobal(cambios);
    return { editar: globales(ctx), aviso: r?.nota || "✅ Hecho" };
  };
  const p = a ? pag(a) : null;
  const falta = { editar: lista(ctx, 0), aviso: "Esa página ya no está en la lista." };

  switch (acc) {
    case "h": return { editar: inicio(ctx) };
    case "l": return { editar: lista(ctx, a) };
    case "e": return { editar: estado(ctx), aviso: "Actualizado" };
    case "a": return { editar: ayuda(ctx) };
    case "g": return { editar: globales(ctx) };
    case "p": return p ? { editar: ficha(ctx, p) } : falta;
    case "f": return p ? { editar: frecuencia(ctx, p) } : falta;
    case "fl": return p ? { editar: filtros(ctx, p) } : falta;
    case "hi": return p ? { editar: historial(ctx, p) } : falta;
    case "fs": return p ? cambiar(a, { interval: Number(b) }, x => ficha(ctx, x)) : falta;
    case "fp": return p ? (soloLectura() || { forzar: `✏️ ¿Cada cuánto compruebo ${nombre(p, ctx.paginas())}?\nEscribe por ejemplo: 90 s, 10 min, 2 h o 1 día. (ref f:${p.id})` }) : falta;
    case "pp": return p ? cambiar(a, { paused: b === "1" }, x => ficha(ctx, x)) : falta;
    case "fx": return p ? cambiar(a, { ignore: p.ignore.filter(r => h6(r) !== b) }, x => filtros(ctx, x)) : falta;
    case "nx": return p ? cambiar(a, { normas: p.normas.filter(n => h6(n.tag + " " + n.attr) !== b) }, x => filtros(ctx, x)) : falta;
    case "ox": return p ? cambiar(a, { orden: false }, x => filtros(ctx, x)) : falta;
    case "fa": return p ? (soloLectura() || { forzar: `✏️ Escribe el texto a ignorar en ${corta(p.url)}.\nSe ignorarán las líneas que lo contengan. (ref p:${p.id})` }) : falta;
    case "gx": { const g = ctx.global(); return cambiarG({ ignore: g.ignore.filter(r => h6(r) !== a) }); }
    case "gnx": { const g = ctx.global(); return cambiarG({ normas: g.normas.filter(n => h6(n.tag + " " + n.attr) !== a) }); }
    case "go": return cambiarG({ orden: a === "1" });
    case "ga": return soloLectura() || { forzar: "✏️ Escribe el texto a ignorar en todas las páginas.\nSe ignorarán las líneas que lo contengan. (ref global)" };
    case "del": return p ? { editar: confirmar(`¿Dejar de vigilar <b>${esc(corta(p.url))}</b>?`, ["🗑 Sí, quitar", `m:dy:${p.id}`], ["Cancelar", `m:p:${p.id}`]) } : falta;
    case "dy": {
      if (!p) return { editar: lista(ctx, 0), aviso: "Ya estaba quitada." };
      const bloqueo = soloLectura(); if (bloqueo) return bloqueo;
      await ctx.borrar(a);
      return { editar: lista(ctx, 0), aviso: "🗑 Página quitada" };
    }
    case "pt": {
      const bloqueo = soloLectura(); if (bloqueo) return bloqueo;
      for (const x of ctx.paginas()) if (!!x.paused !== (a === "1")) await ctx.cambiar(x.id, { paused: a === "1" });
      return { editar: inicio(ctx), aviso: a === "1" ? "⏸ Todo en pausa" : "▶️ Todo reanudado" };
    }
    case "x": { const r = await ctx.ejecutar(); return { aviso: r, editar: inicio(ctx) }; }
    case "n": return soloLectura() || { forzar: "✏️ Envíame la dirección de la página que quieres vigilar. (ref nueva)" };
    case "nm": { // la dirección viaja en el texto del propio mensaje
      const bloqueo = soloLectura(); if (bloqueo) return bloqueo;
      const url = (String(msgTexto).match(/https?:\/\/\S+/) || [])[0];
      if (!url) return { aviso: "No encuentro la dirección: empieza con /nueva https://…" };
      const r = await ctx.nueva({ url, watch: a });
      if (r?.error) return { aviso: r.error };
      const nuevaP = pag(r.id);
      return { editar: nuevaP ? ficha(ctx, nuevaP) : inicio(ctx), aviso: r.nota || "✅ Página añadida" };
    }
  }
  return { aviso: "Botón desconocido." };
}

export async function atenderTexto(texto, ctx, respondeA = "") {
  texto = String(texto || "").trim();
  const ref = String(respondeA).match(/\(ref (p:([\w-]+)|f:([\w-]+)|global|nueva)\)/);
  if (ref && !texto.startsWith("/")) {
    if (ref[1] === "nueva") return pedirModo(texto);
    const bloqueo = !ctx.info().editable && { enviar: { texto: `🔒 ${esc(ctx.info().motivo || "Solo lectura")}`, teclado: [[boton("🏠 Menú", "m:h")]] } };
    if (bloqueo) return bloqueo;
    if (ref[3]) {
      const p = ctx.paginas().find(x => x.id === ref[3]);
      if (!p) return { enviar: lista(ctx, 0) };
      const seg = leerDuracion(texto);
      if (!seg) return { forzar: `No lo he entendido. Escribe un número y una unidad, por ejemplo: 90 s, 10 min, 2 h o 1 día. (ref f:${p.id})` };
      const r = await ctx.cambiar(p.id, { interval: seg });
      return { enviar: ficha(ctx, ctx.paginas().find(x => x.id === p.id) || p), aviso: r?.nota };
    }
    const regla = texto.split("\n").map(s => s.trim()).filter(Boolean)[0];
    if (!regla || regla.length < 3) return { enviar: { texto: "Ese texto es demasiado corto: taparía demasiado. Prueba con algo más concreto.", teclado: [[boton("🏠 Menú", "m:h")]] } };
    if (ref[1] === "global") {
      const g = ctx.global();
      await ctx.cambiarGlobal({ ignore: [...new Set([...g.ignore, regla])] });
      return { enviar: globales(ctx) };
    }
    const p = ctx.paginas().find(x => x.id === ref[2]);
    if (!p) return { enviar: lista(ctx, 0) };
    await ctx.cambiar(p.id, { ignore: [...new Set([...p.ignore, regla])] });
    return { enviar: filtros(ctx, ctx.paginas().find(x => x.id === p.id) || p) };
  }
  const [cmd, ...resto] = texto.split(/\s+/);
  const c = cmd.toLowerCase().replace(/@\w+$/, "");
  switch (c) {
    case "/start": case "/menu": return { enviar: inicio(ctx) };
    case "/paginas": case "/páginas": return { enviar: lista(ctx, 0) };
    case "/estado": return { enviar: estado(ctx) };
    case "/ayuda": case "/help": return { enviar: ayuda(ctx) };
    case "/pausar": case "/reanudar": {
      const r = await atenderBoton(`m:pt:${c === "/pausar" ? 1 : 0}`, ctx);
      return { enviar: r.editar || inicio(ctx), aviso: r.aviso };
    }
    case "/ejecutar": return { enviar: { texto: esc(await ctx.ejecutar()), teclado: [[boton("🏠 Menú", "m:h")]] } };
    case "/nueva": {
      if (!ctx.info().editable) return { enviar: { texto: `🔒 ${esc(ctx.info().motivo || "Solo lectura")}`, teclado: [[boton("🏠 Menú", "m:h")]] } };
      return resto.length ? pedirModo(resto.join(" ")) : { forzar: "✏️ Envíame la dirección de la página que quieres vigilar. (ref nueva)" };
    }
  }
  if (/^(https?:\/\/|www\.)\S+$/i.test(texto)) return pedirModo(texto);
  return { enviar: { texto: "No te he entendido. Usa /menu para ver las opciones.", teclado: [[boton("🏠 Menú", "m:h")]] } };
}

function pedirModo(url) {
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try { new URL(url); } catch { return { enviar: { texto: "Esa dirección no parece válida. Prueba con /nueva https://ejemplo.com", teclado: [[boton("🏠 Menú", "m:h")]] } }; }
  return { enviar: { texto: `➕ Nueva página:\n${esc(url)}\n\n¿De qué quieres que te avise?`, teclado: [
    [boton("🆕 Información nueva", "m:nm:nuevo"), boton("✏️ Cualquier cambio", "m:nm:cambios")],
    [boton("🔗 Enlaces nuevos", "m:nm:enlaces"), boton("Cancelar", "m:h")]
  ] } };
}

/* ---------------------------------------------------------------- ejecutar */
// Traduce la respuesta a llamadas de Telegram. tg(método, cuerpo) la aporta cada atendedor.
export async function responder(u, ctx, tg) {
  const q = u.callback_query;
  if (q) {
    if (!mismoChat(q.message?.chat, ctx.chat)) {
      await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Este botón no es para este chat." }).catch(() => {});
      return;
    }
    const r = await atenderBoton(q.data, ctx, q.message?.text || "");
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: r.aviso ? recorta(r.aviso, 190) : undefined }).catch(() => {});
    if (r.editar && q.message) {
      await tg("editMessageText", { chat_id: q.message.chat.id, message_id: q.message.message_id, text: r.editar.texto, parse_mode: "HTML",
        disable_web_page_preview: true, reply_markup: { inline_keyboard: r.editar.teclado } })
        .catch(e => { if (!/not modified/i.test(e.message)) return enviarPantalla(tg, q.message.chat.id, r.editar); });
    }
    if (r.forzar && q.message) await tg("sendMessage", { chat_id: q.message.chat.id, text: r.forzar, reply_markup: { force_reply: true, input_field_placeholder: "Escribe aquí…" } });
    return r;
  }
  const m = u.message;
  if (!m || !mismoChat(m.chat, ctx.chat)) return;
  const r = await atenderTexto(m.text, ctx, m.reply_to_message?.text || "");
  if (r.enviar) await enviarPantalla(tg, m.chat.id, r.enviar, r.aviso);
  if (r.forzar) await tg("sendMessage", { chat_id: m.chat.id, text: r.forzar, reply_markup: { force_reply: true, input_field_placeholder: "Escribe aquí…" } });
  return r;
}

const enviarPantalla = (tg, chat, p, aviso) => tg("sendMessage", {
  chat_id: chat, text: (aviso ? `${esc(aviso)}\n\n` : "") + p.texto, parse_mode: "HTML",
  disable_web_page_preview: true, reply_markup: { inline_keyboard: p.teclado }
});

/* ---------------------------------------------------------------- lista compartida */
// VIGIA_CONFIG la escriben la web y GitHub Actions (cuando se cambia algo desde
// el bot). Para no pisarse, antes de guardar se fusiona con lo que haya: por
// cada página gana la versión con «editado» más reciente, y lo borrado no vuelve
// a aparecer salvo que se edite después. Los borrados se recuerdan 30 días.
export function fusionarConfigs(a = {}, b = {}, ahora = Date.now()) {
  const borrados = new Map();
  for (const x of [...(a.borrados || []), ...(b.borrados || [])]) {
    if (x && x.id) borrados.set(x.id, Math.max(borrados.get(x.id) || 0, x.t || 0));
  }
  const porId = new Map();
  for (const m of [...(a.monitors || []), ...(b.monitors || [])]) {
    if (!m || !m.id) continue;
    const prev = porId.get(m.id);
    if (!prev || (m.editado || 0) >= (prev.editado || 0)) porId.set(m.id, m);
  }
  const monitors = [...porId.values()].filter(m => !(borrados.has(m.id) && borrados.get(m.id) >= (m.editado || 0)));
  const ga = a.global || {}, gb = b.global || {};
  const limite = ahora - 30 * 86400000;
  return {
    ...a, ...b, version: 2, monitors,
    global: (gb.editado || 0) >= (ga.editado || 0) ? gb : ga,
    borrados: [...borrados].filter(([, t]) => t > limite).map(([id, t]) => ({ id, t }))
  };
}
