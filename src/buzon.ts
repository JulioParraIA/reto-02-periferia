/**
 * Datos de solo lectura para la interfaz: el buzón con el estado de cada mensaje, el maestro
 * con las filas que tocó el agente, el historial y las alertas. No pasa por el agente ni deja
 * registro en out/log.jsonl; lo único que escribe es el reinicio de out/ para volver a la demo.
 */
import { readdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

const ID_MENSAJE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const NOMBRE_ADJUNTO = /^[\w.-]+$/

const CorreoSchema = z.object({ id: z.string(), de: z.string(), asunto: z.string(), fecha: z.string(), cuerpo: z.string(), adjuntos: z.array(z.string()) })
const ProcesadosSchema = z.record(z.string(), z.object({ ts: z.string(), accion: z.string(), id_contrato: z.string().nullable(), motivo: z.string().nullable() }))
const HistorialSchema = z.object({
  ts: z.string(),
  id_contrato: z.string(),
  accion: z.string(),
  mensaje_id: z.string(),
  cambios: z.record(z.string(), z.unknown()),
  /** Documento archivado de una actualización (el de un alta va en cambios.ruta_sharepoint). */
  documento: z.string().optional(),
})

export type MensajeVista = {
  id: string
  de: string
  asunto: string
  fecha: string
  cuerpo: string
  adjuntos: { nombre: string; titulo: string | null }[]
  /** pendiente mientras no se procese; después, lo que hizo contratos_registrar. */
  estado: string
  id_contrato: string | null
  motivo: string | null
}

export type FilaVista = { celdas: Record<string, string>; marca: "alta" | "actualizacion" | null; cambiados: string[] }

function buzon(raiz: string, ...partes: string[]): string {
  return path.join(raiz, "fixtures", "reto-02", "buzon", ...partes)
}

async function leerJson<T>(ruta: string, esquema: z.ZodType<T>): Promise<T | null> {
  try {
    const leido = esquema.safeParse(JSON.parse(await readFile(ruta, "utf8")))
    return leido.success ? leido.data : null
  } catch {
    return null
  }
}

async function procesados(raiz: string): Promise<z.infer<typeof ProcesadosSchema>> {
  return (await leerJson(path.join(raiz, "out", "procesados.json"), ProcesadosSchema)) ?? {}
}

async function tituloDe(raiz: string, mensaje: string, nombre: string): Promise<string | null> {
  if (!NOMBRE_ADJUNTO.test(nombre)) return null
  const texto = await readFile(buzon(raiz, mensaje, nombre), "utf8").catch(() => null)
  return texto?.split("\n").find((linea) => linea.trim())?.trim() ?? null
}

export async function listarBuzon(raiz: string): Promise<MensajeVista[]> {
  let carpetas: string[] = []
  try {
    const entradas = await readdir(buzon(raiz), { withFileTypes: true })
    carpetas = entradas.filter((entrada) => entrada.isDirectory() && ID_MENSAJE.test(entrada.name)).map((entrada) => entrada.name).sort()
  } catch {
    return []
  }
  const hechos = await procesados(raiz)
  const mensajes = await Promise.all(
    carpetas.map(async (mensaje) => {
      const correo = await leerJson(buzon(raiz, mensaje, "correo.json"), CorreoSchema)
      if (!correo) return null
      const hecho = hechos[mensaje]
      return {
        id: mensaje,
        de: correo.de,
        asunto: correo.asunto,
        fecha: correo.fecha,
        cuerpo: correo.cuerpo,
        adjuntos: await Promise.all(correo.adjuntos.map(async (nombre) => ({ nombre, titulo: await tituloDe(raiz, mensaje, nombre) }))),
        estado: hecho?.accion ?? "pendiente",
        id_contrato: hecho?.id_contrato ?? null,
        motivo: hecho?.motivo ?? null,
      }
    }),
  )
  return mensajes.filter((mensaje) => mensaje !== null)
}

/** Texto de un adjunto del buzón, solo si el correo lo lista. */
export async function leerAdjunto(raiz: string, mensaje: string, nombre: string): Promise<string | null> {
  if (!ID_MENSAJE.test(mensaje) || !NOMBRE_ADJUNTO.test(nombre)) return null
  const correo = await leerJson(buzon(raiz, mensaje, "correo.json"), CorreoSchema)
  if (!correo?.adjuntos.includes(nombre)) return null
  return readFile(buzon(raiz, mensaje, nombre), "utf8").catch(() => null)
}

function leerCsv(texto: string): string[][] {
  const filas: string[][] = []
  let fila: string[] = []
  let celda = ""
  let comillas = false
  for (let i = 0; i < texto.length; i++) {
    const caracter = texto[i]
    if (comillas) {
      if (caracter === '"' && texto[i + 1] === '"') {
        celda += '"'
        i++
      } else if (caracter === '"') comillas = false
      else celda += caracter
    } else if (caracter === '"') comillas = true
    else if (caracter === ",") {
      fila.push(celda)
      celda = ""
    } else if (caracter === "\n" || caracter === "\r") {
      if (caracter === "\r" && texto[i + 1] === "\n") i++
      fila.push(celda)
      filas.push(fila)
      fila = []
      celda = ""
    } else celda += caracter
  }
  if (celda !== "" || fila.length > 0) filas.push([...fila, celda])
  return filas.filter((partes) => partes.some((parte) => parte !== ""))
}

export async function leerHistorial(raiz: string): Promise<z.infer<typeof HistorialSchema>[]> {
  const texto = await readFile(path.join(raiz, "out", "sharepoint", "historial.jsonl"), "utf8").catch(() => "")
  return texto
    .split("\n")
    .filter((linea) => linea.trim())
    .map((linea) => {
      try {
        const leido = HistorialSchema.safeParse(JSON.parse(linea))
        return leido.success ? leido.data : null
      } catch {
        return null
      }
    })
    .filter((entrada) => entrada !== null)
}

/** El maestro de out/sharepoint/ (o el congelado, si todavía no se procesa nada), con las filas que tocó el agente. */
export async function vistaMaestro(raiz: string): Promise<{ origen: "out" | "fixture"; columnas: string[]; filas: FilaVista[] }> {
  const deOut = await readFile(path.join(raiz, "out", "sharepoint", "maestro-contratos.csv"), "utf8").catch(() => null)
  const texto = deOut ?? (await readFile(path.join(raiz, "fixtures", "reto-02", "maestro-contratos.csv"), "utf8").catch(() => ""))
  const [columnas = [], ...filas] = leerCsv(texto)
  const marcas = new Map<string, { marca: "alta" | "actualizacion"; cambiados: Set<string> }>()
  for (const entrada of await leerHistorial(raiz)) {
    const previa = marcas.get(entrada.id_contrato)
    const marca = previa?.marca === "alta" || entrada.accion === "alta" ? "alta" : "actualizacion"
    const cambiados = new Set([...(previa?.cambiados ?? []), ...(entrada.accion === "alta" ? [] : Object.keys(entrada.cambios))])
    marcas.set(entrada.id_contrato, { marca, cambiados })
  }
  return {
    origen: deOut === null ? "fixture" : "out",
    columnas,
    filas: filas.map((partes) => {
      const celdas = Object.fromEntries(columnas.map((columna, indice) => [columna, partes[indice] ?? ""]))
      const marca = marcas.get(celdas.id_contrato ?? "")
      return { celdas, marca: marca?.marca ?? null, cambiados: [...(marca?.cambiados ?? [])] }
    }),
  }
}

export async function leerAlertas(raiz: string): Promise<string | null> {
  return readFile(path.join(raiz, "out", "alertas.md"), "utf8").catch(() => null)
}

/** Devuelve la ruta absoluta solo si queda dentro de out/; cualquier intento de salir devuelve null. */
export function resolverRutaSegura(raiz: string, ruta: string): string | null {
  if (!ruta.startsWith("out/") || ruta.includes("\0")) return null
  const salida = path.resolve(raiz, "out")
  const absoluta = path.resolve(raiz, ruta)
  return absoluta.startsWith(salida + path.sep) ? absoluta : null
}

/** Borra out/ para que el buzón vuelva a su estado inicial (el maestro se copia otra vez del fixture). */
export async function reiniciar(raiz: string): Promise<void> {
  await rm(path.join(raiz, "out"), { recursive: true, force: true })
}
