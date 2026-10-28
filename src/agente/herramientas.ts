/**
 * Registro de herramientas del backend. Cada export de src/tools/<archivo>.ts se vuelve una
 * herramienta llamada `<archivo>_<export>`. Aquí se validan los argumentos con zod antes de
 * ejecutar (sección 6.2). Cada herramienta deja su línea en out/log.jsonl (RN7); el backend
 * solo agrega allí las llamadas que no llegaron a ejecutarse, para que también queden (CA4).
 */
import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import type { EsquemaHerramienta } from "../llm/adapter.ts"
import * as contratos from "../tools/contratos.ts"

export type ContextoHerramienta = { directory: string; sessionId: string }

/** Forma de cada export de src/tools/ (description, args y execute). */
type HerramientaExportada = {
  description: string
  args: z.ZodRawShape
  execute(args: Record<string, unknown>, ctx: ContextoHerramienta): Promise<string>
}

export type Herramienta = EsquemaHerramienta & {
  /** Tiene el argumento `confirmado`: el backend lo fija según la confirmación del usuario, no el modelo. */
  controlaConfirmacion: boolean
  ejecutar(argumentos: unknown, ctx: ContextoHerramienta): Promise<string>
}

export type ResultadoHerramienta = {
  /** JSON que recibe el modelo. */
  texto: string
  /** false si no llegó a ejecutarse (no existe, argumentos inválidos o falló sin control). */
  ejecutada: boolean
  ok: boolean
  resumen: string
  error: string | null
  datos: unknown
}

const ERRORES_EN_ESPANOL = { error: z.locales.es().localeError }
const RespuestaSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

function describirProblemas(error: z.ZodError): string {
  return error.issues.map((problema) => `${problema.path.join(".") || "argumentos"}: ${problema.message}`).join("; ")
}

class ArgumentosInvalidos extends Error {}

function crearHerramienta(nombre: string, exportada: HerramientaExportada): Herramienta {
  const esquema = z.object(exportada.args)
  const { $schema: _, ...parametros } = z.toJSONSchema(esquema)
  return {
    nombre,
    descripcion: exportada.description,
    parametros,
    controlaConfirmacion: "confirmado" in exportada.args,
    async ejecutar(argumentos, ctx) {
      const validados = esquema.safeParse(argumentos, ERRORES_EN_ESPANOL)
      if (!validados.success) throw new ArgumentosInvalidos(`Argumentos inválidos: ${describirProblemas(validados.error)}`)
      return exportada.execute(validados.data, ctx)
    },
  }
}

export function registrarModulo(archivo: string, modulo: Record<string, HerramientaExportada>): Herramienta[] {
  return Object.entries(modulo).map(([exportado, herramienta]) => crearHerramienta(`${archivo}_${exportado}`, herramienta))
}

export const HERRAMIENTAS: Herramienta[] = registrarModulo("contratos", contratos)

function interpretar(texto: string): Omit<ResultadoHerramienta, "texto" | "ejecutada"> {
  let json: unknown = null
  try {
    json = JSON.parse(texto)
  } catch {
    // Se trata abajo como respuesta inválida.
  }
  const respuesta = RespuestaSchema.safeParse(json)
  if (!respuesta.success) return { ok: false, resumen: "respuesta inválida de la herramienta", error: "respuesta inválida", datos: null }
  if (!respuesta.data.ok) return { ok: false, resumen: respuesta.data.error, error: respuesta.data.error, datos: null }
  const { data } = respuesta.data
  const resumen = z.object({ resumen: z.string() }).safeParse(data)
  return { ok: true, resumen: resumen.success ? resumen.data.resumen : "ok", error: null, datos: data }
}

async function registrarNoEjecutada(ctx: ContextoHerramienta, herramienta: string, argumentos: unknown, resumen: string): Promise<void> {
  const mensaje = typeof argumentos === "object" && argumentos !== null && "mensaje_id" in argumentos ? argumentos.mensaje_id : null
  const linea = { ts: new Date().toISOString(), herramienta, mensaje_id: mensaje, ok: false, resumen, sesion: ctx.sessionId }
  try {
    await mkdir(path.join(ctx.directory, "out"), { recursive: true })
    await appendFile(path.join(ctx.directory, "out", "log.jsonl"), `${JSON.stringify(linea)}\n`, "utf8")
  } catch {
    // Un fallo del registro no interrumpe la conversación.
  }
}

/** Ejecuta una herramienta por nombre; nunca lanza: los errores vuelven como `{ ok: false, error }` para el modelo. */
export async function ejecutarHerramienta(
  herramientas: Herramienta[],
  nombre: string,
  argumentos: unknown,
  ctx: ContextoHerramienta,
): Promise<ResultadoHerramienta> {
  const herramienta = herramientas.find((candidata) => candidata.nombre === nombre)
  let texto: string
  let ejecutada = false
  try {
    if (!herramienta) throw new ArgumentosInvalidos(`La herramienta ${nombre} no existe.`)
    texto = await herramienta.ejecutar(argumentos, ctx)
    ejecutada = true
  } catch (error) {
    const mensaje = error instanceof ArgumentosInvalidos ? error.message : `La herramienta ${nombre} falló de forma inesperada.`
    texto = JSON.stringify({ ok: false, error: mensaje })
  }
  const resultado = interpretar(texto)
  if (!ejecutada) await registrarNoEjecutada(ctx, nombre, argumentos, resultado.resumen)
  return { texto, ejecutada, ...resultado }
}
