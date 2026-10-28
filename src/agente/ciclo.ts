/**
 * Ciclo del agente (sección 6.3 del PRD): mensaje → modelo → herramientas → … → respuesta.
 *   CA1 tope de iteraciones por turno.
 *   CA3 confirmación humana: la decide el backend con lo que escribió el usuario, no el modelo.
 *   CA4 cada llamada queda en el chat y en out/log.jsonl.
 *   CA5 un error se explica en el chat y la sesión sigue viva.
 * Además suma el consumo del modelo de cada turno (tokens y dólares de entrada y de salida).
 */
import { ErrorLLM, type AdaptadorLLM, type LlamadaHerramienta, type OpcionesEnvio, type RespuestaModelo } from "../llm/adapter.ts"
import { esAfirmativo } from "./confirmacion.ts"
import { ejecutarHerramienta, type Herramienta, type ResultadoHerramienta } from "./herramientas.ts"
import type { ConsumoTurno, LlamadaVisible, ResultadoTurno, Sesion } from "./tipos.ts"

export type DependenciasCiclo = {
  llm: AdaptadorLLM
  herramientas: Herramienta[]
  directorio: string
  maxIteraciones: number
  maxTokensSesion: number
}

/** Error de contratos_registrar cuando hay campos en revisión sin confirmar (sección 6.2 del PRD). */
const ERROR_REVISION = "requiere revisión"
const SIN_TEXTO = "El modelo no devolvió texto; intenta de nuevo."

type EstadoTurno = {
  llamadas: LlamadaVisible[]
  /** Mensajes que el usuario confirmó en este mensaje; cada uno se gasta al registrarse. */
  otorgada: Set<string>
  /** Mensajes que quedan esperando confirmación al terminar el turno. */
  pendiente: Set<string>
  inicio: number
  consumo: ConsumoTurno
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor)
}

function mensajeDe(argumentos: unknown): string | null {
  return esObjeto(argumentos) && typeof argumentos.mensaje_id === "string" ? argumentos.mensaje_id : null
}

/** Si el modelo escribió un JSON inválido, se pasa el texto tal cual y la validación con zod lo rechaza. */
function leerArgumentos(texto: string): unknown {
  try {
    return JSON.parse(texto)
  } catch {
    return texto
  }
}

/** `confirmado` solo es true si el usuario confirmó este mensaje en su último mensaje; el modelo no lo decide. */
function fijarConfirmacion(argumentos: unknown, otorgada: Set<string>): unknown {
  if (!esObjeto(argumentos)) return argumentos
  const mensaje = mensajeDe(argumentos)
  return { ...argumentos, confirmado: mensaje !== null && otorgada.has(mensaje) }
}

function anunciaConfirmacion(datos: unknown): boolean {
  return esObjeto(datos) && esObjeto(datos.confirmacion_pendiente)
}

function actualizarConfirmacion(turno: EstadoTurno, herramienta: Herramienta | undefined, argumentos: unknown, resultado: ResultadoHerramienta): void {
  const mensaje = mensajeDe(argumentos)
  if (mensaje === null) return
  if (herramienta?.controlaConfirmacion && resultado.ok) {
    turno.otorgada.delete(mensaje)
    turno.pendiente.delete(mensaje)
    return
  }
  if (resultado.error?.startsWith(ERROR_REVISION) || anunciaConfirmacion(resultado.datos)) turno.pendiente.add(mensaje)
}

// ─── Consumo ─────────────────────────────────────────────────────────────────

function consumoVacio(modelo: string): ConsumoTurno {
  return {
    modelo,
    proveedor: null,
    llamadas: 0,
    duracionMs: 0,
    entrada: { tokens: 0, enCache: 0, escritosEnCache: 0, usd: null },
    salida: { tokens: 0, razonamiento: 0, usd: null },
    totalUsd: null,
  }
}

/** Suma dólares que pueden faltar: null solo si ninguna llamada informó el valor. */
function sumarUsd(acumulado: number | null, nuevo: number | null): number | null {
  if (nuevo === null) return acumulado
  return (acumulado ?? 0) + nuevo
}

function sumarConsumo(consumo: ConsumoTurno, respuesta: RespuestaModelo): void {
  const { uso } = respuesta
  consumo.llamadas += 1
  consumo.modelo = respuesta.modeloUsado ?? consumo.modelo
  consumo.proveedor = respuesta.proveedorUsado ?? consumo.proveedor
  consumo.entrada.tokens += uso.entrada
  consumo.entrada.enCache += uso.entradaEnCache
  consumo.entrada.escritosEnCache += uso.entradaEscritaEnCache
  consumo.entrada.usd = sumarUsd(consumo.entrada.usd, uso.costoEntrada)
  consumo.salida.tokens += uso.salida
  consumo.salida.razonamiento += uso.salidaRazonamiento
  consumo.salida.usd = sumarUsd(consumo.salida.usd, uso.costoSalida)
  consumo.totalUsd = sumarUsd(consumo.totalUsd, uso.costo)
}

// ─── Vueltas del turno ───────────────────────────────────────────────────────

async function pedirAlModelo(sesion: Sesion, turno: EstadoTurno, deps: DependenciasCiclo, opciones?: OpcionesEnvio): Promise<RespuestaModelo> {
  const respuesta = await deps.llm.enviar(sesion.mensajes, deps.herramientas, opciones)
  sesion.tokens += respuesta.uso.entrada + respuesta.uso.salida
  sesion.tokensEnCache += respuesta.uso.entradaEnCache
  sesion.costo += respuesta.uso.costo ?? 0
  sumarConsumo(turno.consumo, respuesta)
  const texto = respuesta.texto || (respuesta.llamadas.length > 0 ? "" : SIN_TEXTO)
  sesion.mensajes.push({ rol: "assistant", contenido: texto, llamadas: respuesta.llamadas, datosProveedor: respuesta.datosProveedor })
  return { ...respuesta, texto }
}

async function atenderLlamada(sesion: Sesion, turno: EstadoTurno, llamada: LlamadaHerramienta, deps: DependenciasCiclo): Promise<void> {
  const herramienta = deps.herramientas.find((candidata) => candidata.nombre === llamada.nombre)
  const leidos = leerArgumentos(llamada.argumentos)
  const argumentos = herramienta?.controlaConfirmacion ? fijarConfirmacion(leidos, turno.otorgada) : leidos
  const ctx = { directory: deps.directorio, sessionId: sesion.id }
  const resultado = await ejecutarHerramienta(deps.herramientas, llamada.nombre, argumentos, ctx)
  actualizarConfirmacion(turno, herramienta, argumentos, resultado)
  sesion.mensajes.push({ rol: "tool", idLlamada: llamada.id, contenido: resultado.texto })
  turno.llamadas.push({
    herramienta: llamada.nombre,
    argumentos,
    ok: resultado.ok,
    resumen: resultado.resumen,
    ...(resultado.ok ? { datos: resultado.datos } : {}),
  })
}

function responderSinModelo(sesion: Sesion, texto: string): string {
  sesion.mensajes.push({ rol: "assistant", contenido: texto, llamadas: [] })
  return texto
}

/** CA1: al llegar al tope, el modelo responde con lo que tiene y lo que falta, sin más herramientas. */
async function cerrarPorTope(sesion: Sesion, turno: EstadoTurno, deps: DependenciasCiclo): Promise<string> {
  sesion.mensajes.push({
    rol: "user",
    contenido: `[Aviso del sistema] Se alcanzó el tope de ${deps.maxIteraciones} pasos de este turno. Sin llamar más herramientas, responde con lo que ya tienes y lo que falta por hacer.`,
  })
  const respuesta = await pedirAlModelo(sesion, turno, deps, { sinHerramientas: true })
  for (const llamada of respuesta.llamadas) {
    const contenido = JSON.stringify({ ok: false, error: "No se ejecutó: se alcanzó el tope de pasos del turno." })
    sesion.mensajes.push({ rol: "tool", idLlamada: llamada.id, contenido })
  }
  if (respuesta.llamadas.length === 0 && respuesta.texto !== SIN_TEXTO) return respuesta.texto
  return `Llegué al tope de ${deps.maxIteraciones} pasos en este turno sin terminar; pídeme que continúe.`
}

async function iterar(sesion: Sesion, turno: EstadoTurno, deps: DependenciasCiclo): Promise<string> {
  for (let vuelta = 0; vuelta < deps.maxIteraciones; vuelta++) {
    if (sesion.tokens >= deps.maxTokensSesion) {
      return responderSinModelo(sesion, "Esta sesión llegó a su tope de tokens; abre una sesión nueva para seguir.")
    }
    const respuesta = await pedirAlModelo(sesion, turno, deps)
    if (respuesta.llamadas.length === 0) return respuesta.texto
    for (const llamada of respuesta.llamadas) await atenderLlamada(sesion, turno, llamada, deps)
  }
  return cerrarPorTope(sesion, turno, deps)
}

function cerrar(sesion: Sesion, turno: EstadoTurno, texto: string, error: boolean): ResultadoTurno {
  sesion.pendiente = turno.pendiente.size > 0 ? { mensajes: [...turno.pendiente] } : null
  const needsConfirmation = sesion.pendiente !== null
  const consumo = { ...turno.consumo, duracionMs: Date.now() - turno.inicio }
  const marca = error ? { error: true } : {}
  sesion.historial.push({ rol: "agente", texto, ts: new Date().toISOString(), toolCalls: turno.llamadas, needsConfirmation, consumo, ...marca })
  return { reply: texto, toolCalls: turno.llamadas, needsConfirmation, consumo, ...marca }
}

export async function procesarTurno(sesion: Sesion, mensaje: string, confirmar: boolean, deps: DependenciasCiclo): Promise<ResultadoTurno> {
  const turno: EstadoTurno = {
    llamadas: [],
    otorgada: new Set(sesion.pendiente && (confirmar || esAfirmativo(mensaje)) ? sesion.pendiente.mensajes : []),
    pendiente: new Set(),
    inicio: Date.now(),
    consumo: consumoVacio(deps.llm.modelo),
  }
  sesion.pendiente = null
  sesion.mensajes.push({ rol: "user", contenido: mensaje })
  sesion.historial.push({ rol: "usuario", texto: mensaje, ts: new Date().toISOString() })
  try {
    return cerrar(sesion, turno, await iterar(sesion, turno, deps), false)
  } catch (error) {
    if (!(error instanceof ErrorLLM)) console.error("Error inesperado en el ciclo del agente:", error)
    const texto =
      error instanceof ErrorLLM
        ? `No pude completar la respuesta: ${error.message}`
        : "No pude completar la respuesta por un error inesperado del servidor; intenta de nuevo."
    return cerrar(sesion, turno, responderSinModelo(sesion, texto), true)
  }
}
