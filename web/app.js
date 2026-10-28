// Arranque del front: sesión, clave de acceso, buzón, chat, panel de registro y consola de consumo.
import { fijarClave, pedir } from "./api.js"
import { limpiarChat, mostrarPensando, pintarAgente, pintarAviso, pintarBienvenida, pintarEvento, pintarUsuario } from "./chat.js"
import { fijarModelo, registrarConsumo, reiniciarConsola } from "./consola.js"
import { aplicarLlamadas, iniciarRegistro, mostrarSeccion, refrescar, reiniciarRevision } from "./registro.js"

const $ = (selector) => document.querySelector(selector)
const campoMensaje = $("#mensaje")
const botonEnviar = $("#enviar")

/** El prompt de ejemplo de la sección 11 del PRD, con la fecha de hoy. */
function promptDelBuzon() {
  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date())
  return `Procesa el buzón de contratos con fecha de hoy ${hoy}. Registra lo que esté limpio, muéstrame lo que requiere revisión campo por campo y termina con el reporte de alertas. No registres nada dudoso sin preguntarme.`
}

const almacen = {
  leer(clave) {
    try {
      return window.sessionStorage.getItem(clave) ?? window.localStorage.getItem(clave)
    } catch {
      return null
    }
  },
  guardar(clave, valor, duradero = false) {
    try {
      ;(duradero ? window.localStorage : window.sessionStorage).setItem(clave, valor)
    } catch {
      // Sin almacenamiento el chat funciona igual; solo no recuerda la sesión.
    }
  },
}

let sesionId = almacen.leer("sesion") ?? nuevaSesionId()
let ocupado = false
let mensajes = []
fijarClave(almacen.leer("claveAcceso") ?? "")

function nuevaSesionId() {
  const id = crypto.randomUUID()
  almacen.guardar("sesion", id)
  return id
}

function fijarOcupado(valor) {
  ocupado = valor
  botonEnviar.disabled = valor
  $("#reiniciar").disabled = valor
}

function cambiarVista(vista) {
  document.body.dataset.vista = vista
  for (const boton of document.querySelectorAll(".pestanas button")) {
    boton.setAttribute("aria-pressed", String(boton.dataset.vista === vista))
    if (boton.dataset.vista === vista) boton.classList.remove("novedad")
  }
}

function avisarNovedad(vista) {
  if (document.body.dataset.vista === vista) return
  document.querySelector(`.pestanas button[data-vista="${vista}"]`)?.classList.add("novedad")
}

async function enviar(texto, confirmar = false) {
  if (ocupado || !texto.trim()) return
  fijarOcupado(true)
  pintarUsuario(texto)
  const ocultar = mostrarPensando()
  const { ok, estado, datos } = await pedir("/api/chat", { metodo: "POST", cuerpo: { sessionId: sesionId, message: texto, confirmar } })
  ocultar()
  if (estado === 401) pedirClave()
  if (!ok) pintarAviso(datos.error ?? `El servidor respondió ${estado}.`)
  else {
    pintarAgente(datos, {
      alConfirmar: () => enviar("Confirmo el registro con los valores propuestos.", true),
      alCancelar: () => enviar("No lo registres todavía; lo reviso primero."),
    })
    aplicarLlamadas(datos.toolCalls)
    registrarConsumo(datos.consumo)
    if (datos.toolCalls?.some((llamada) => llamada.herramienta === "contratos_alertas" && llamada.ok)) mostrarSeccion("alertas")
    if (datos.toolCalls?.length) avisarNovedad("registro")
    avisarNovedad("consumo")
  }
  await refrescar()
  fijarOcupado(false)
  campoMensaje.focus()
}

function pintarInicio() {
  limpiarChat()
  pintarBienvenida(mensajes, {
    alProcesarBuzon: () => enviar(promptDelBuzon()),
    alProcesarMensaje: (id) => enviar(`Procesa solo el mensaje ${id} del buzón. Si algo requiere revisión, muéstramelo campo por campo y no lo registres sin preguntarme.`),
  })
}

async function restaurar() {
  const { ok, datos } = await pedir(`/api/sessions/${sesionId}`)
  for (const entrada of ok ? datos.historial : []) {
    if (entrada.rol === "usuario") pintarUsuario(entrada.texto)
    else if (entrada.rol === "evento") pintarEvento(entrada.texto, entrada.ts)
    else {
      pintarAgente({ reply: entrada.texto, toolCalls: entrada.toolCalls, needsConfirmation: entrada.needsConfirmation, consumo: entrada.consumo, error: entrada.error }, { conBotones: false })
      aplicarLlamadas(entrada.toolCalls)
      registrarConsumo(entrada.consumo, entrada.ts)
    }
  }
  await refrescar()
}

async function arrancar() {
  const respuesta = await pedir("/api/buzon")
  if (respuesta.estado === 401) return pedirClave()
  mensajes = respuesta.ok ? respuesta.datos.mensajes : []
  pintarInicio()
  await restaurar()
}

function pedirClave() {
  $("#acceso").hidden = false
  $("#clave").focus()
}

async function iniciar() {
  iniciarRegistro({
    alActualizar: (lista) => {
      mensajes = lista
    },
  })
  const { ok, datos } = await pedir("/api/health")
  $("#chip-modelo").textContent = ok ? datos.model : "sin conexión con el servidor"
  if (ok) fijarModelo(datos.provider, datos.model)
  if (ok && datos.acceso === "con_clave" && !almacen.leer("claveAcceso")) return pedirClave()
  await arrancar()
}

// ─── Eventos ─────────────────────────────────────────────────────────────────

$("#formulario").addEventListener("submit", (evento) => {
  evento.preventDefault()
  const texto = campoMensaje.value
  campoMensaje.value = ""
  campoMensaje.style.height = ""
  enviar(texto)
})

campoMensaje.addEventListener("keydown", (evento) => {
  if (evento.key === "Enter" && !evento.shiftKey) {
    evento.preventDefault()
    $("#formulario").requestSubmit()
  }
})

campoMensaje.addEventListener("input", () => {
  campoMensaje.style.height = ""
  campoMensaje.style.height = `${Math.min(campoMensaje.scrollHeight, 160)}px`
})

$("#form-acceso").addEventListener("submit", async (evento) => {
  evento.preventDefault()
  const clave = $("#clave").value
  fijarClave(clave)
  const prueba = await pedir("/api/buzon")
  if (prueba.estado === 401) {
    $("#error-acceso").hidden = false
    return
  }
  almacen.guardar("claveAcceso", clave, true)
  $("#acceso").hidden = true
  $("#error-acceso").hidden = true
  await arrancar()
})

$("#nueva").addEventListener("click", async () => {
  sesionId = nuevaSesionId()
  reiniciarRevision()
  reiniciarConsola()
  mensajes = await refrescar()
  pintarInicio()
  cambiarVista("chat")
})

$("#reiniciar").addEventListener("click", () => {
  $("#confirmar-reinicio").hidden = false
  $("#reinicio-no").focus()
})
$("#reinicio-no").addEventListener("click", () => {
  $("#confirmar-reinicio").hidden = true
})
$("#reinicio-si").addEventListener("click", async () => {
  $("#confirmar-reinicio").hidden = true
  const { ok, datos } = await pedir("/api/reiniciar", { metodo: "POST", cuerpo: { sessionId: sesionId } })
  if (!ok) return pintarAviso(datos.error ?? "No se pudo reiniciar el buzón.")
  mensajes = await refrescar()
  pintarInicio()
  await restaurar()
  // Lo que estaba en revisión antes del reinicio ya no aplica.
  reiniciarRevision()
  await refrescar()
  mostrarSeccion("buzon")
})

for (const boton of document.querySelectorAll(".pestanas button")) {
  boton.addEventListener("click", () => cambiarVista(boton.dataset.vista))
}

iniciar()
