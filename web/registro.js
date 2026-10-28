// Panel «Registro»: el buzón con el estado de cada mensaje, el maestro con lo que cambió, las alertas y el historial.
import { pedir, rutaAdjunto, rutaArchivo, traerTexto } from "./api.js"
import { escapar, markdown } from "./markdown.js"
import { COLUMNAS_MAESTRO, dinero, ESTADOS, fechaCorta, hora } from "./textos.js"
import { abrirVisor } from "./visor.js"

const contenido = document.querySelector("#registro-contenido")
const COLUMNAS_TABLA = ["id_contrato", "cliente", "pais", "valor", "fecha_inicio", "fecha_fin", "estado_poliza", "comercial"]

let seccion = "buzon"
let datos = { mensajes: [], maestro: null, alertas: null, historial: [] }
/** Mensajes que el agente dejó en revisión en esta sesión (se sabe por las llamadas del chat). */
const enRevision = new Map()
let alCambiar = () => {}

export function iniciarRegistro({ alActualizar }) {
  alCambiar = alActualizar
  for (const boton of document.querySelectorAll(".subpestanas button")) {
    boton.addEventListener("click", () => mostrarSeccion(boton.dataset.seccion))
  }
  contenido.addEventListener("click", alHacerClic)
}

export function mostrarSeccion(nueva) {
  seccion = nueva
  for (const boton of document.querySelectorAll(".subpestanas button")) boton.setAttribute("aria-pressed", String(boton.dataset.seccion === nueva))
  pintar()
}

export function reiniciarRevision() {
  enRevision.clear()
}

/** Lee las llamadas de un turno: validar con campos en revisión marca el mensaje; registrar con éxito lo libera. */
export function aplicarLlamadas(llamadas = []) {
  for (const llamada of llamadas) {
    const mensaje = llamada.argumentos?.mensaje_id
    if (!mensaje) continue
    if (llamada.herramienta === "contratos_validar" && llamada.ok) {
      const campos = llamada.datos?.requiere_revision ?? []
      if (campos.length > 0 && !llamada.datos?.ya_procesado) enRevision.set(mensaje, llamada.datos.detalle_revision ?? campos.map((campo) => ({ campo, motivo: "" })))
      else enRevision.delete(mensaje)
    }
    if (llamada.herramienta === "contratos_registrar" && llamada.ok) enRevision.delete(mensaje)
  }
}

export async function refrescar() {
  const [buzon, maestro, alertas, historial] = await Promise.all([pedir("/api/buzon"), pedir("/api/maestro"), pedir("/api/alertas"), pedir("/api/historial")])
  datos = {
    mensajes: buzon.ok ? buzon.datos.mensajes : [],
    maestro: maestro.ok ? maestro.datos : null,
    alertas: alertas.ok ? alertas.datos.markdown : null,
    historial: historial.ok ? historial.datos.historial : [],
  }
  for (const mensaje of datos.mensajes) if (mensaje.estado !== "pendiente") enRevision.delete(mensaje.id)
  pintar()
  alCambiar(datos.mensajes)
  return datos.mensajes
}

function contar() {
  const pendientes = datos.mensajes.filter((mensaje) => mensaje.estado === "pendiente").length
  const tocadas = datos.maestro?.filas.filter((fila) => fila.marca).length ?? 0
  document.querySelector("#cuenta-buzon").textContent = pendientes ? String(pendientes) : ""
  document.querySelector("#cuenta-maestro").textContent = tocadas ? `+${tocadas}` : ""
  document.querySelector("#cuenta-historial").textContent = datos.historial.length ? String(datos.historial.length) : ""
}

function pintar() {
  contar()
  const vistas = { buzon: vistaBuzon, maestro: vistaMaestro, alertas: vistaAlertas, historial: vistaHistorial }
  contenido.innerHTML = vistas[seccion]()
}

// ─── Buzón ───────────────────────────────────────────────────────────────────

function estadoDe(mensaje) {
  if (mensaje.estado === "pendiente" && enRevision.has(mensaje.id)) return { texto: "En revisión · espera tu confirmación", tono: "alerta" }
  return ESTADOS[mensaje.estado] ?? { texto: mensaje.estado, tono: "neutro" }
}

function tarjetaBuzon(mensaje) {
  const estado = estadoDe(mensaje)
  const revision = enRevision.get(mensaje.id)
  const adjuntos = mensaje.adjuntos
    .map((adjunto) => `<button type="button" class="enlace" data-adjunto="${escapar(adjunto.nombre)}" data-mensaje="${escapar(mensaje.id)}" title="${escapar(adjunto.titulo ?? "")}">📎 ${escapar(adjunto.nombre)}</button>`)
    .join("")
  const detalle = revision
    ? `<ul class="revision">${revision.map((item) => `<li><strong>${escapar(item.campo)}</strong>${item.motivo ? ` · ${escapar(item.motivo)}` : ""}</li>`).join("")}</ul>`
    : ""
  const resultado = mensaje.estado === "pendiente" ? "" : `<p class="resultado">${mensaje.id_contrato ? `<code>${escapar(mensaje.id_contrato)}</code> ` : ""}${escapar(mensaje.motivo ?? "")}</p>`
  return `<article class="mensaje-buzon ${estado.tono}">
    <header><span class="caso-pais">${escapar(mensaje.id)}</span><span class="estado ${estado.tono}">${escapar(estado.texto)}</span></header>
    <h4>${escapar(mensaje.asunto)}</h4>
    <p class="dim">${escapar(mensaje.de)} · ${escapar(fechaCorta(mensaje.fecha))}</p>
    <p class="cuerpo-correo">${escapar(mensaje.cuerpo)}</p>
    <div class="fila adjuntos">${adjuntos || "<span class='dim'>sin adjuntos</span>"}</div>
    ${resultado}${detalle}
  </article>`
}

function vistaBuzon() {
  if (datos.mensajes.length === 0) return `<p class="vacio">No hay mensajes en el buzón.</p>`
  return `<div class="lista-buzon">${datos.mensajes.map(tarjetaBuzon).join("")}</div>`
}

// ─── Maestro ─────────────────────────────────────────────────────────────────

function celda(fila, columna) {
  const valor = fila.celdas[columna] ?? ""
  const cambiado = fila.cambiados.includes(columna) ? " cambiado" : ""
  const texto = columna === "valor" ? dinero(valor, fila.celdas.moneda) : valor || "—"
  return `<td class="${columna}${cambiado}">${escapar(texto)}</td>`
}

function vistaMaestro() {
  const maestro = datos.maestro
  if (!maestro) return `<p class="vacio">No se pudo leer el maestro.</p>`
  const origen =
    maestro.origen === "fixture"
      ? "Maestro congelado al 2026-05-30 (fixture). Se copia a out/sharepoint/ en la primera ejecución."
      : "Copia de trabajo: out/sharepoint/maestro-contratos.csv"
  const cabecera = COLUMNAS_TABLA.map((columna) => `<th>${escapar(COLUMNAS_MAESTRO[columna] ?? columna)}</th>`).join("")
  const filas = maestro.filas
    .map(
      (fila, indice) =>
        `<tr class="${fila.marca ?? ""}" data-fila="${indice}" tabindex="0" title="Ver la fila completa">${COLUMNAS_TABLA.map((columna) => celda(fila, columna)).join("")}</tr>`,
    )
    .join("")
  return `<p class="nota-maestro">${escapar(origen)} <span class="leyenda"><span class="muestra alta"></span>nuevo <span class="muestra actualizacion"></span>actualizado</span></p>
    <div class="tabla-desplazable"><table class="tabla-maestro"><thead><tr>${cabecera}</tr></thead><tbody>${filas}</tbody></table></div>`
}

function detalleFila(fila) {
  const lineas = Object.entries(fila.celdas).map(([columna, valor]) => {
    const marca = fila.cambiados.includes(columna) ? " (cambió)" : ""
    return `| ${COLUMNAS_MAESTRO[columna] ?? columna} | ${String(valor || "—").replace(/\|/g, "\\|")}${marca} |`
  })
  return [`| Campo | Valor |`, `|---|---|`, ...lineas].join("\n")
}

// ─── Alertas e historial ─────────────────────────────────────────────────────

function vistaAlertas() {
  if (!datos.alertas) return `<p class="vacio">Todavía no hay reporte. Pídele al agente que genere las alertas (lo hace al final de procesar el buzón).</p>`
  return `<div class="documento">${markdown(datos.alertas)}</div><button type="button" class="enlace" data-archivo="out/alertas.md">Abrir out/alertas.md</button>`
}

function cambiosDe(entrada) {
  if (entrada.accion === "alta") {
    const c = entrada.cambios
    return `<p>${escapar(String(c.cliente ?? ""))} · ${escapar(dinero(String(c.valor ?? ""), String(c.moneda ?? "")))} · ${escapar(String(c.fecha_inicio ?? ""))} → ${escapar(String(c.fecha_fin ?? ""))}</p>`
  }
  const filas = Object.entries(entrada.cambios).map(
    ([campo, cambio]) => `<li><strong>${escapar(campo)}</strong>: ${escapar(String(cambio?.antes ?? ""))} → ${escapar(String(cambio?.despues ?? ""))}</li>`,
  )
  return `<ul>${filas.join("")}</ul>`
}

function documentoDe(entrada) {
  const ruta = entrada.accion === "alta" ? entrada.cambios.ruta_sharepoint : entrada.documento
  return ruta ? `<button type="button" class="enlace" data-archivo="out/sharepoint/${escapar(String(ruta))}">📄 ${escapar(String(ruta))}</button>` : ""
}

function vistaHistorial() {
  if (datos.historial.length === 0) return `<p class="vacio">Sin movimientos todavía: aquí queda cada alta y cada actualización del maestro.</p>`
  const entradas = [...datos.historial].reverse().map(
    (entrada) => `<article class="entrada-historial ${entrada.accion === "alta" ? "alta" : "actualizacion"}">
      <header><strong>${entrada.accion === "alta" ? "Alta" : "Actualización"} · ${escapar(entrada.id_contrato)}</strong><span class="dim">${escapar(entrada.mensaje_id)} · ${hora(entrada.ts)}</span></header>
      ${cambiosDe(entrada)}
      ${documentoDe(entrada)}
    </article>`,
  )
  return `<div class="lista-historial">${entradas.join("")}</div><button type="button" class="enlace" data-archivo="out/sharepoint/historial.jsonl">Abrir historial.jsonl</button>`
}

// ─── Clics ───────────────────────────────────────────────────────────────────

function alHacerClic(evento) {
  const adjunto = evento.target.closest("[data-adjunto]")
  if (adjunto) return abrirVisor(`${adjunto.dataset.mensaje} / ${adjunto.dataset.adjunto}`, () => traerTexto(rutaAdjunto(adjunto.dataset.mensaje, adjunto.dataset.adjunto)))
  const archivo = evento.target.closest("[data-archivo]")
  if (archivo) return abrirVisor(archivo.dataset.archivo, () => traerTexto(rutaArchivo(archivo.dataset.archivo)))
  const fila = evento.target.closest("[data-fila]")
  if (fila) {
    const datosFila = datos.maestro.filas[Number(fila.dataset.fila)]
    const ruta = datosFila.celdas.ruta_sharepoint
    abrirVisor(`${datosFila.celdas.id_contrato}.md`, async () => {
      const archivado = datosFila.marca && ruta ? `\n\n**Documento archivado:** \`out/sharepoint/${ruta}\`\n` : ""
      return detalleFila(datosFila) + archivado
    })
  }
}
