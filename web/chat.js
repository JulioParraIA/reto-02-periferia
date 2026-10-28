// Mensajes del chat: bienvenida con el buzón, mensajes del usuario y del agente, eventos y avisos.
import { escapar, markdown } from "./markdown.js"
import { dolares, ESTADOS, fechaCorta, hora, NOMBRES_HERRAMIENTAS, segundos, tokens } from "./textos.js"

const conversacion = document.querySelector("#conversacion")

function agregar(elemento) {
  conversacion.querySelector(".bienvenida")?.classList.add("compacta")
  conversacion.append(elemento)
  // Desplazamiento inmediato: el suave se interrumpe cuando cambia la altura (por ejemplo, al quitar «trabajando…»).
  const largo = elemento.offsetHeight > conversacion.clientHeight * 0.7
  elemento.scrollIntoView({ block: largo ? "start" : "end" })
  return elemento
}

function nodo(etiqueta, clase, html = "") {
  const elemento = document.createElement(etiqueta)
  elemento.className = clase
  elemento.innerHTML = html
  return elemento
}

export function limpiarChat() {
  conversacion.innerHTML = ""
}

function tarjetaMensaje(mensaje) {
  const estado = ESTADOS[mensaje.estado] ?? { texto: mensaje.estado, tono: "neutro" }
  const adjuntos = mensaje.adjuntos.map((adjunto) => adjunto.nombre).join(", ") || "sin adjuntos"
  const pendiente = mensaje.estado === "pendiente"
  return `<button type="button" class="caso-tarjeta" data-mensaje="${escapar(mensaje.id)}" ${pendiente ? "" : "disabled"}>
    <span class="caso-cabecera"><span class="caso-pais">${escapar(mensaje.id)}</span><span class="estado ${estado.tono}">${escapar(estado.texto)}</span></span>
    <span class="caso-cliente">${escapar(mensaje.asunto)}</span>
    <span class="caso-asunto">${escapar(mensaje.de)} · ${escapar(adjuntos)}</span>
    <span class="caso-pie"><span>${escapar(fechaCorta(mensaje.fecha))}</span>${pendiente ? `<span class="caso-accion">Procesar →</span>` : ""}</span>
  </button>`
}

export function pintarBienvenida(mensajes, { alProcesarBuzon, alProcesarMensaje }) {
  const pendientes = mensajes.filter((mensaje) => mensaje.estado === "pendiente").length
  const bienvenida = nodo(
    "section",
    "bienvenida",
    `<h2>¿Procesamos el buzón de contratos?</h2>
    <p>El agente lee cada correo, extrae los datos del contrato con su nivel de confianza, detecta si es nuevo, una actualización o un duplicado, lo registra en el maestro y archiva el documento. Lo dudoso no se registra sin ti.</p>
    <ol class="flujo">
      <li><span>1</span>Lee el buzón</li><li><span>2</span>Extrae los datos</li><li><span>3</span>Valida contra el maestro</li>
      <li><span>4</span>Registra y archiva</li><li class="humano"><span>5</span>Tú confirmas lo dudoso</li><li><span>6</span>Genera las alertas</li>
    </ol>
    <div class="fila accion-principal">
      <button type="button" class="boton primario" data-accion="buzon" ${pendientes === 0 ? "disabled" : ""}>Procesar el buzón (${pendientes} por procesar)</button>
      ${pendientes === 0 ? `<span class="dim">Todo está procesado; usa «Reiniciar buzón» en el panel para repetir la demo.</span>` : ""}
    </div>
    <h3>Mensajes del buzón</h3>
    <div class="casos">${mensajes.map(tarjetaMensaje).join("") || "<p class='dim'>No hay mensajes en fixtures/reto-02/buzon/.</p>"}</div>`,
  )
  bienvenida.addEventListener("click", (evento) => {
    if (evento.target.closest("[data-accion='buzon']")) return alProcesarBuzon()
    const tarjeta = evento.target.closest("[data-mensaje]")
    if (tarjeta) alProcesarMensaje(tarjeta.dataset.mensaje)
  })
  conversacion.prepend(bienvenida)
}

export function pintarUsuario(texto) {
  agregar(nodo("div", "mensaje usuario", `<p>${escapar(texto).replace(/\n/g, "<br>")}</p>`))
}

function pasoDelAgente(llamada) {
  const nombre = NOMBRES_HERRAMIENTAS[llamada.herramienta] ?? llamada.herramienta
  return `<li class="paso ${llamada.ok ? "bien" : "mal"}"><details>
    <summary><span class="icono">${llamada.ok ? "✓" : "✗"}</span><span class="paso-nombre">${escapar(nombre)}</span><span class="paso-resumen">${escapar(llamada.resumen)}</span></summary>
    <div class="paso-detalle"><code>${escapar(llamada.herramienta)}</code><pre>${escapar(JSON.stringify(llamada.argumentos, null, 2))}</pre></div>
  </details></li>`
}

function pieDeConsumo(consumo) {
  if (!consumo) return ""
  const total = consumo.entrada.tokens + consumo.salida.tokens
  return `<footer class="pie-mensaje">${segundos(consumo.duracionMs)} · ${tokens(total)} tokens · ${dolares(consumo.totalUsd)}</footer>`
}

function botonesConfirmacion(alConfirmar, alCancelar) {
  const fila = nodo("div", "acciones")
  const confirmar = nodo("button", "boton primario", "Confirmar registro")
  const cancelar = nodo("button", "boton secundario", "No registrar todavía")
  confirmar.type = cancelar.type = "button"
  const usar = (accion) => {
    confirmar.disabled = cancelar.disabled = true
    accion()
  }
  confirmar.addEventListener("click", () => usar(alConfirmar))
  cancelar.addEventListener("click", () => usar(alCancelar))
  fila.append(confirmar, cancelar)
  return fila
}

/** Mensaje del agente: los pasos que dio (herramientas), su respuesta y, si hace falta, la confirmación. */
export function pintarAgente(respuesta, { alConfirmar, alCancelar, conBotones = true } = {}) {
  const clases = ["mensaje", "agente", respuesta.needsConfirmation ? "confirmacion" : "", respuesta.error ? "error" : ""].filter(Boolean).join(" ")
  const pasos = respuesta.toolCalls?.length ? `<ol class="pasos-agente">${respuesta.toolCalls.map(pasoDelAgente).join("")}</ol>` : ""
  const etiqueta = respuesta.needsConfirmation ? `<p class="etiqueta-confirmacion">Esperando tu confirmación</p>` : ""
  const burbuja = nodo(
    "article",
    clases,
    `<div class="avatar" aria-hidden="true">P</div>
    <div class="cuerpo-mensaje">${pasos}${etiqueta}<div class="texto">${markdown(respuesta.reply)}</div>${pieDeConsumo(respuesta.consumo)}</div>`,
  )
  if (respuesta.needsConfirmation && conBotones) burbuja.querySelector(".cuerpo-mensaje").append(botonesConfirmacion(alConfirmar, alCancelar))
  agregar(burbuja)
}

export function pintarEvento(texto, ts = new Date().toISOString()) {
  agregar(nodo("div", "evento", `<span>↺ ${escapar(texto)} · ${hora(ts)}</span>`))
}

export function pintarAviso(texto) {
  agregar(nodo("div", "mensaje agente error", `<div class="avatar" aria-hidden="true">!</div><div class="cuerpo-mensaje"><p>${escapar(texto)}</p></div>`))
}

export function mostrarPensando() {
  const indicador = agregar(nodo("div", "pensando", "<span></span><span></span><span></span> <em>El agente está trabajando… 0 s</em>"))
  const inicio = Date.now()
  const reloj = setInterval(() => {
    indicador.querySelector("em").textContent = `El agente está trabajando… ${Math.round((Date.now() - inicio) / 1000)} s`
  }, 1000)
  return () => {
    clearInterval(reloj)
    indicador.remove()
  }
}
