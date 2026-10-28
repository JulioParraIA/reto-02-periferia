/**
 * Verificación sin modelo (sección 6.6 del PRD): procesa los 6 mensajes del buzón en orden
 * llamando directamente a las herramientas e imprime por mensaje la clasificación, los campos
 * en revisión y la acción tomada. Lo que requiere revisión queda sin registrar en la primera
 * pasada; después se muestra la segunda llamada con `confirmado: true` para msg-006.
 * No usa ninguna clave.
 *
 *   bun install && bun run demo.ts
 */
import { rm } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import * as contratos from "./src/tools/contratos.ts"

/** Fecha fija para que la demo dé siempre lo mismo: la del prompt de ejemplo del PRD (sección 11). */
const HOY = "2026-09-03"
const ctx = { directory: import.meta.dir, sessionId: "demo" }

const BuzonSchema = z.object({ mensajes: z.array(z.object({ id: z.string(), asunto: z.string(), tiene_contrato: z.boolean() })) })
const ExtraccionSchema = z.object({ resumen: z.string(), valores: z.record(z.string(), z.unknown()) })
const ValidacionSchema = z.object({
  clasificacion: z.string(),
  motivo: z.string().nullable(),
  detalle_revision: z.array(z.object({ campo: z.string(), motivo: z.string() })),
  diferencias: z.array(z.object({ campo: z.string(), maestro: z.string(), documento: z.string() })),
  avisos: z.array(z.string()),
})
const RegistroSchema = z.object({ accion: z.string(), id_contrato: z.string().nullable(), ruta_archivo: z.string().nullable() })
const AlertasSchema = z.object({
  ruta: z.string(),
  vencen: z.array(z.object({ id_contrato: z.string(), fecha_fin: z.string(), dias: z.number() })),
  polizas_pendientes: z.array(z.object({ id_contrato: z.string(), estado_poliza: z.string() })),
  registrados_desde_corte: z.array(z.object({ id_contrato: z.string() })),
})

type Respuesta<T> = { ok: true; data: T } | { ok: false; error: string }

/** Las herramientas devuelven texto JSON; aquí se valida la parte que la demo imprime. */
async function llamar<T>(salida: Promise<string>, esquema: z.ZodType<T>): Promise<Respuesta<T>> {
  const respuesta = z
    .union([z.object({ ok: z.literal(true), data: esquema }), z.object({ ok: z.literal(false), error: z.string() })])
    .safeParse(JSON.parse(await salida))
  return respuesta.success ? respuesta.data : { ok: false, error: `respuesta inesperada: ${respuesta.error.message}` }
}

/** extraer → validar → registrar sin confirmación. Devuelve los valores extraídos para la segunda pasada. */
async function procesar(mensaje_id: string): Promise<Record<string, unknown> | undefined> {
  const extraccion = await llamar(contratos.extraer.execute({ mensaje_id }, ctx), ExtraccionSchema)
  console.log(`  Extracción: ${extraccion.ok ? extraccion.data.resumen : extraccion.error}`)
  const contrato = extraccion.ok ? extraccion.data.valores : undefined

  const validacion = await llamar(contratos.validar.execute({ mensaje_id, contrato }, ctx), ValidacionSchema)
  if (!validacion.ok) return console.log(`  Error al validar: ${validacion.error}`), undefined
  const { clasificacion, motivo, detalle_revision, diferencias, avisos } = validacion.data
  console.log(`  Clasificación: ${clasificacion.toUpperCase()}${motivo ? ` · ${motivo}` : ""}`)
  for (const diferencia of diferencias) console.log(`    cambia ${diferencia.campo}: ${diferencia.maestro || "(vacío)"} → ${diferencia.documento}`)
  console.log(`  Campos en revisión: ${detalle_revision.length === 0 ? "ninguno" : ""}`)
  for (const item of detalle_revision) console.log(`    ${item.campo}: ${item.motivo}`)
  for (const aviso of avisos) console.log(`    aviso: ${aviso}`)

  const registro = await llamar(contratos.registrar.execute({ mensaje_id, contrato, hoy: HOY }, ctx), RegistroSchema)
  const accion = registro.ok
    ? `${registro.data.accion}${registro.data.id_contrato ? ` ${registro.data.id_contrato}` : ""}${registro.data.ruta_archivo ? ` → ${registro.data.ruta_archivo}` : ""}`
    : `SIN REGISTRAR (${registro.error.split(":")[0]})`
  console.log(`  Acción: ${accion}`)
  return contrato
}

async function confirmar(mensaje_id: string, contrato: Record<string, unknown>): Promise<void> {
  // Lo que respondería la analista en el chat (sección 11): «confirmo el valor 0 y la fecha fin 2027-08-31».
  const corregido = { ...contrato, valor: 0, fecha_fin: "2027-08-31" }
  console.log(`\n■ Segunda pasada de ${mensaje_id}: la analista confirma el valor 0 y corrige la fecha fin a 2027-08-31`)
  const revision = await llamar(contratos.validar.execute({ mensaje_id, contrato: corregido }, ctx), ValidacionSchema)
  if (revision.ok) console.log(`  En revisión antes de confirmar: ${revision.data.detalle_revision.map((item) => item.campo).join(", ")}`)
  const sinConfirmar = await llamar(contratos.registrar.execute({ mensaje_id, contrato: corregido, hoy: HOY }, ctx), RegistroSchema)
  console.log(`  Sin confirmado: ${sinConfirmar.ok ? sinConfirmar.data.accion : `rechazado → "${sinConfirmar.error.split(":")[0]}"`}`)
  const confirmado = await llamar(contratos.registrar.execute({ mensaje_id, contrato: corregido, confirmado: true, hoy: HOY }, ctx), RegistroSchema)
  console.log(`  Con confirmado: true → ${confirmado.ok ? `${confirmado.data.accion} ${confirmado.data.id_contrato} → ${confirmado.data.ruta_archivo}` : confirmado.error}`)
  const repetido = await llamar(contratos.registrar.execute({ mensaje_id, contrato: corregido, confirmado: true, hoy: HOY }, ctx), RegistroSchema)
  console.log(`  Otra vez (idempotencia): ${repetido.ok ? repetido.data.accion : repetido.error}`)
}

async function main(): Promise<void> {
  await rm(path.join(ctx.directory, "out"), { recursive: true, force: true })
  const buzon = await llamar(contratos.leer_buzon.execute({}, ctx), BuzonSchema)
  if (!buzon.ok) return console.log(`Error: ${buzon.error}`)
  console.log(`Demo reto 02: herramientas sin modelo · hoy ${HOY} · ${buzon.data.mensajes.length} mensajes en el buzón`)

  const extraidos = new Map<string, Record<string, unknown>>()
  for (const mensaje of buzon.data.mensajes) {
    console.log(`\n■ ${mensaje.id} · ${mensaje.asunto}${mensaje.tiene_contrato ? "" : " (sin contrato)"}`)
    const contrato = await procesar(mensaje.id)
    if (contrato) extraidos.set(mensaje.id, contrato)
  }

  const msg006 = extraidos.get("msg-006")
  if (msg006) await confirmar("msg-006", msg006)

  console.log("\n■ Mensaje que no existe (el error no detiene la demo)")
  await procesar("msg-999")

  const pendientes = await llamar(contratos.leer_buzon.execute({}, ctx), BuzonSchema)
  console.log(`\n■ Buzón después del lote: ${pendientes.ok ? `${pendientes.data.mensajes.length} mensajes sin procesar` : pendientes.error}`)

  const alertas = await llamar(contratos.alertas.execute({ hoy: HOY }, ctx), AlertasSchema)
  if (!alertas.ok) return console.log(`Error en alertas: ${alertas.error}`)
  const { ruta, vencen, polizas_pendientes, registrados_desde_corte } = alertas.data
  console.log(`\n■ Alertas al ${HOY} → ${ruta}`)
  console.log(`  Vencen en ≤ 60 días: ${vencen.map((c) => `${c.id_contrato} (${c.fecha_fin}, ${c.dias} días)`).join("; ") || "ninguno"}`)
  console.log(`  Pólizas pendientes: ${polizas_pendientes.map((p) => p.id_contrato).join(", ") || "ninguna"}`)
  console.log(`  Registrados desde el corte: ${registrados_desde_corte.map((r) => r.id_contrato).join(", ") || "ninguno"}`)
  console.log("\nMaestro en out/sharepoint/maestro-contratos.csv · historial en out/sharepoint/historial.jsonl · registro en out/log.jsonl")
}

await main()
