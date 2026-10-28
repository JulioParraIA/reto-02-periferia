/** Utilidades de prueba: cada prueba trabaja sobre una copia temporal de fixtures/ y nunca toca out/ del proyecto. */
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { z } from "zod"

export const RAIZ = path.resolve(import.meta.dir, "..")
export const HOY = "2026-09-03"

export async function proyectoTemporal(): Promise<string> {
  const directorio = await mkdtemp(path.join(os.tmpdir(), "reto02-"))
  await cp(path.join(RAIZ, "fixtures"), path.join(directorio, "fixtures"), { recursive: true })
  return directorio
}

export function borrar(directorio: string): Promise<void> {
  return rm(directorio, { recursive: true, force: true })
}

/** Lee la respuesta JSON de una herramienta y valida `data` con el esquema dado (falla la prueba si no es ok). */
export function datos<T>(texto: string, esquema: z.ZodType<T>): T {
  const respuesta = z.object({ ok: z.literal(true), data: esquema }).safeParse(JSON.parse(texto))
  if (!respuesta.success) throw new Error(`Se esperaba { ok: true } con otra forma y llegó: ${texto}`)
  return respuesta.data.data
}

/** Lee una respuesta de error de una herramienta y devuelve el mensaje. */
export function error(texto: string): string {
  const respuesta = z.object({ ok: z.literal(false), error: z.string() }).safeParse(JSON.parse(texto))
  if (!respuesta.success) throw new Error(`Se esperaba { ok: false } y llegó: ${texto}`)
  return respuesta.data.error
}

/** Filas del maestro de out/sharepoint/ como objetos (el CSV de prueba no tiene comas dentro de comillas que importen aquí). */
export async function maestro(directorio: string): Promise<Record<string, string>[]> {
  const texto = await readFile(path.join(directorio, "out", "sharepoint", "maestro-contratos.csv"), "utf8")
  const filas = texto.trim().split("\n")
  const columnas = (filas[0] ?? "").split(",")
  return filas.slice(1).map((linea) => {
    const celdas: string[] = []
    let actual = ""
    let comillas = false
    for (const caracter of linea) {
      if (caracter === '"') comillas = !comillas
      else if (caracter === "," && !comillas) {
        celdas.push(actual)
        actual = ""
      } else actual += caracter
    }
    celdas.push(actual)
    return Object.fromEntries(columnas.map((columna, indice) => [columna, celdas[indice] ?? ""]))
  })
}

export const ExtraccionSchema = z.object({
  tipo_documento: z.string(),
  campos: z.record(z.string(), z.object({ valor: z.unknown(), confianza: z.number() })),
  valores: z.record(z.string(), z.unknown()),
  campos_baja_confianza: z.array(z.string()),
})
export const ValidacionSchema = z.object({
  clasificacion: z.string(),
  motivo: z.string().nullable(),
  id_contrato_existente: z.string().nullable(),
  requiere_revision: z.array(z.string()),
  diferencias: z.array(z.object({ campo: z.string(), maestro: z.string(), documento: z.string() })),
  avisos: z.array(z.string()),
  confirmacion_pendiente: z.object({ mensaje_id: z.string(), campos: z.array(z.string()) }).optional(),
})
export const RegistroSchema = z.object({ id_contrato: z.string().nullable(), accion: z.string(), ruta_archivo: z.string().nullable() })
