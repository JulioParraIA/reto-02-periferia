/**
 * Rutas HTTP: la API del chat (sección 6.4 del PRD) y las que usa la interfaz para mostrar el
 * buzón, el maestro, el historial y las alertas. Se arma con sus dependencias para poder
 * probarla sin levantar un servidor.
 */
import { timingSafeEqual } from "node:crypto"
import path from "node:path"
import { z } from "zod"
import { procesarTurno, type DependenciasCiclo } from "../agente/ciclo.ts"
import type { Sesiones } from "../agente/sesiones.ts"
import type { Sesion } from "../agente/tipos.ts"
import { leerAdjunto, leerAlertas, leerHistorial, listarBuzon, reiniciar, resolverRutaSegura, vistaMaestro } from "../buzon.ts"

export type OpcionesApp = {
  raiz: string
  /** Si no está vacía, toda la API (menos /api/health) exige la cabecera x-clave-acceso. */
  claveAcceso: string
  promptSistema: string
  sesiones: Sesiones
  ciclo: DependenciasCiclo
}

type Manejador = (peticion: Request, parametro: string, segundo: string) => Promise<Response> | Response

const CABECERAS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" }
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'"
const ID_SESION = /^[A-Za-z0-9_-]{8,64}$/
const ARCHIVO_WEB = /^\/([a-z]+\.(?:js|css))$/

const ChatSchema = z.object({
  sessionId: z.string().regex(ID_SESION),
  message: z.string().trim().min(1).max(4000),
  /** true cuando la persona pulsa «Confirmar registro» en el chat. */
  confirmar: z.boolean().optional(),
})
const ReinicioSchema = z.object({ sessionId: z.string().regex(ID_SESION).optional() })

function hoyEnBogota(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
}

function json(datos: unknown, estado = 200): Response {
  return Response.json(datos, { status: estado, headers: CABECERAS })
}

function error(mensaje: string, estado: number): Response {
  return json({ error: mensaje }, estado)
}

function texto(contenido: string, nombre: string): Response {
  const seguro = nombre.replace(/[^\w.-]/g, "_")
  return new Response(contenido, { headers: { ...CABECERAS, "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `inline; filename="${seguro}"` } })
}

export function crearManejador(opciones: OpcionesApp): (peticion: Request) => Promise<Response> {
  const { raiz, sesiones, ciclo } = opciones

  function autorizado(peticion: Request): boolean {
    if (!opciones.claveAcceso) return true
    const recibida = Buffer.from(peticion.headers.get("x-clave-acceso") ?? "")
    const esperada = Buffer.from(opciones.claveAcceso)
    return recibida.length === esperada.length && timingSafeEqual(recibida, esperada)
  }

  async function chat(peticion: Request): Promise<Response> {
    const cuerpo = ChatSchema.safeParse(await peticion.json().catch(() => null))
    if (!cuerpo.success) return error("Petición inválida: se espera { sessionId, message }.", 400)
    // La fecha va en el prompt de cada sesión nueva para que el agente sepa qué «hoy» usar en las alertas.
    const prompt = `${opciones.promptSistema}\n\nHoy es ${hoyEnBogota()} (hora de Bogotá).`
    const sesion = sesiones.obtenerOCrear(cuerpo.data.sessionId, prompt)
    if (sesion.ocupada) return error("La sesión todavía está respondiendo el mensaje anterior.", 409)
    sesion.ocupada = true
    try {
      return json(await procesarTurno(sesion, cuerpo.data.message, cuerpo.data.confirmar ?? false, ciclo))
    } finally {
      sesion.ocupada = false
    }
  }

  function historialSesion(_peticion: Request, id: string): Response {
    const sesion = sesiones.obtener(id)
    if (!sesion) return error("No existe esa sesión.", 404)
    const { creada, historial: entradas, tokens, tokensEnCache, costo } = sesion
    return json({ sessionId: sesion.id, creada, historial: entradas, tokens, tokensEnCache, costo })
  }

  async function adjunto(_peticion: Request, mensaje: string, nombre: string): Promise<Response> {
    const contenido = await leerAdjunto(raiz, mensaje, nombre)
    return contenido === null ? error("Ese adjunto no existe en el buzón.", 404) : texto(contenido, nombre)
  }

  async function archivo(peticion: Request): Promise<Response> {
    const absoluta = resolverRutaSegura(raiz, new URL(peticion.url).searchParams.get("ruta") ?? "")
    if (!absoluta) return error("Ruta no permitida: solo se sirven archivos de out/.", 400)
    const contenido = Bun.file(absoluta)
    if (!(await contenido.exists())) return error("El archivo no existe.", 404)
    return texto(await contenido.text(), path.basename(absoluta))
  }

  function registrarEvento(sesion: Sesion | undefined, contenido: string): void {
    if (!sesion) return
    // Para que el agente sepa lo que hizo la persona fuera del chat.
    sesion.mensajes.push({ rol: "user", contenido: `[Evento de la interfaz] ${contenido}` })
    sesion.historial.push({ rol: "evento", texto: contenido, ts: new Date().toISOString() })
    sesion.pendiente = null
  }

  async function reiniciarBuzon(peticion: Request): Promise<Response> {
    const cuerpo = ReinicioSchema.safeParse(await peticion.json().catch(() => ({})))
    const sesion = cuerpo.success && cuerpo.data.sessionId ? sesiones.obtener(cuerpo.data.sessionId) : undefined
    if (sesion?.ocupada) return error("Espera a que el agente termine de responder para reiniciar.", 409)
    await reiniciar(raiz)
    registrarEvento(sesion, "Reiniciaste el buzón: out/ quedó vacío, el maestro vuelve al congelado del 2026-05-30 y los 6 mensajes están otra vez por procesar.")
    return json({ ok: true })
  }

  const rutas: [string, RegExp, Manejador][] = [
    ["POST", /^\/api\/chat$/, chat],
    ["GET", /^\/api\/sessions\/([^/]+)$/, historialSesion],
    ["GET", /^\/api\/buzon$/, async () => json({ mensajes: await listarBuzon(raiz) })],
    ["GET", /^\/api\/buzon\/([^/]+)\/adjuntos\/([^/]+)$/, adjunto],
    ["GET", /^\/api\/maestro$/, async () => json(await vistaMaestro(raiz))],
    ["GET", /^\/api\/historial$/, async () => json({ historial: await leerHistorial(raiz) })],
    ["GET", /^\/api\/alertas$/, async () => json({ markdown: await leerAlertas(raiz) })],
    ["GET", /^\/api\/archivo$/, archivo],
    ["POST", /^\/api\/reiniciar$/, reiniciarBuzon],
  ]

  function salud(): Response {
    return json({ ok: true, provider: ciclo.llm.proveedor, model: ciclo.llm.modelo, acceso: opciones.claveAcceso ? "con_clave" : "abierto" })
  }

  async function estatico(pathname: string): Promise<Response> {
    const nombre = pathname === "/" ? "index.html" : pathname.match(ARCHIVO_WEB)?.[1]
    const contenido = nombre ? Bun.file(path.join(raiz, "web", nombre)) : null
    if (!contenido || !(await contenido.exists())) return error("No encontrado.", 404)
    return new Response(contenido, { headers: { ...CABECERAS, "Content-Security-Policy": CSP } })
  }

  return async function enrutar(peticion: Request): Promise<Response> {
    const { pathname } = new URL(peticion.url)
    if (peticion.method === "GET" && pathname === "/api/health") return salud()
    if (pathname.startsWith("/api/")) {
      if (!autorizado(peticion)) return error("Clave de acceso inválida.", 401)
      for (const [metodo, patron, manejar] of rutas) {
        const coincidencia = pathname.match(patron)
        if (coincidencia && peticion.method === metodo) {
          return manejar(peticion, decodeURIComponent(coincidencia[1] ?? ""), decodeURIComponent(coincidencia[2] ?? ""))
        }
      }
      return error("No encontrado.", 404)
    }
    if (peticion.method === "GET") return estatico(pathname)
    return error("Método no permitido.", 405)
  }
}
