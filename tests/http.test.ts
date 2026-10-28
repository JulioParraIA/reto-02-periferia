/** Pruebas de las rutas HTTP sin levantar un servidor: el manejador se llama con Request directamente. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cp } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { HERRAMIENTAS } from "../src/agente/herramientas.ts"
import { Sesiones } from "../src/agente/sesiones.ts"
import { crearManejador } from "../src/http/app.ts"
import type { AdaptadorLLM, RespuestaModelo } from "../src/llm/adapter.ts"
import * as contratos from "../src/tools/contratos.ts"
import { HOY, RAIZ, borrar, proyectoTemporal } from "./apoyo.ts"

const CLAVE = "clave-de-prueba"
let directorio = ""
let manejar: (peticion: Request) => Promise<Response>
let promptRecibido = ""

const respuestaFija: RespuestaModelo = {
  texto: "Hola, soy el agente.",
  llamadas: [],
  uso: { entrada: 1200, entradaEnCache: 800, entradaEscritaEnCache: 0, salida: 60, salidaRazonamiento: 10, costoEntrada: 0.001, costoSalida: 0.0006, costo: 0.0016 },
  modeloUsado: "modelo/de-prueba",
  proveedorUsado: "Proveedor de prueba",
}
const modelo: AdaptadorLLM = {
  proveedor: "prueba",
  modelo: "modelo/de-prueba",
  enviar: async (mensajes) => {
    const sistema = mensajes[0]
    promptRecibido = sistema?.rol === "system" ? sistema.contenido : ""
    return respuestaFija
  },
}

function pedir(ruta: string, opciones: { metodo?: string; cuerpo?: unknown; clave?: string | null } = {}): Promise<Response> {
  const clave = opciones.clave === undefined ? CLAVE : opciones.clave
  return manejar(
    new Request(`http://prueba${ruta}`, {
      method: opciones.metodo ?? "GET",
      headers: { "Content-Type": "application/json", ...(clave ? { "x-clave-acceso": clave } : {}) },
      body: opciones.cuerpo === undefined ? undefined : JSON.stringify(opciones.cuerpo),
    }),
  )
}

const BuzonSchema = z.object({ mensajes: z.array(z.object({ id: z.string(), estado: z.string() })) })

beforeAll(async () => {
  directorio = await proyectoTemporal()
  await cp(path.join(RAIZ, "web"), path.join(directorio, "web"), { recursive: true })
  manejar = crearManejador({
    raiz: directorio,
    claveAcceso: CLAVE,
    promptSistema: "prompt de prueba",
    sesiones: new Sesiones(),
    ciclo: { llm: modelo, herramientas: HERRAMIENTAS, directorio, maxIteraciones: 5, maxTokensSesion: 100_000 },
  })
})
afterAll(() => borrar(directorio))

describe("rutas HTTP", () => {
  test("/api/health responde sin clave y sin exponer secretos", async () => {
    const respuesta = await pedir("/api/health", { clave: null })
    expect(await respuesta.json()).toEqual({ ok: true, provider: "prueba", model: "modelo/de-prueba", acceso: "con_clave" })
  })

  test("el resto de la API exige la clave de acceso", async () => {
    expect((await pedir("/api/buzon", { clave: null })).status).toBe(401)
    expect((await pedir("/api/buzon", { clave: "otra" })).status).toBe(401)
    const { mensajes } = BuzonSchema.parse(await (await pedir("/api/buzon")).json())
    expect(mensajes.map((mensaje) => mensaje.id)).toEqual(["msg-001", "msg-002", "msg-003", "msg-004", "msg-005", "msg-006"])
    expect(mensajes.every((mensaje) => mensaje.estado === "pendiente")).toBe(true)
  })

  test("los archivos solo se sirven desde out/ y los adjuntos solo si el correo los lista", async () => {
    for (const ruta of ["../.env", "out/../.env", "fixtures/reto-02/maestro-contratos.csv", "out/../../x"]) {
      expect((await pedir(`/api/archivo?ruta=${encodeURIComponent(ruta)}`)).status).toBe(400)
    }
    expect((await pedir("/api/buzon/msg-001/adjuntos/correo.json")).status).toBe(404)
    expect((await pedir(`/api/buzon/msg-001/adjuntos/${encodeURIComponent("../msg-002/contrato.txt")}`)).status).toBe(404)
    const contrato = await pedir("/api/buzon/msg-001/adjuntos/contrato.txt")
    expect(await contrato.text()).toStartWith("CONTRATO DE PRESTACIÓN DE SERVICIOS No. CT-2026-015")
  })

  test("/api/chat devuelve la respuesta y el consumo del turno, y el prompt lleva la fecha de hoy", async () => {
    const respuesta = await pedir("/api/chat", { metodo: "POST", cuerpo: { sessionId: "sesion-http-1", message: "Hola" } })
    expect(await respuesta.json()).toMatchObject({
      reply: "Hola, soy el agente.",
      toolCalls: [],
      needsConfirmation: false,
      consumo: { modelo: "modelo/de-prueba", llamadas: 1, entrada: { tokens: 1200, enCache: 800, usd: 0.001 }, salida: { tokens: 60, usd: 0.0006 }, totalUsd: 0.0016 },
    })
    expect(promptRecibido).toMatch(/^prompt de prueba\n\nHoy es \d{4}-\d{2}-\d{2} \(hora de Bogotá\)\.$/)
  })

  test("el maestro, el historial y el reinicio reflejan lo que hicieron las herramientas", async () => {
    const ctx = { directory: directorio, sessionId: "http" }
    await contratos.registrar.execute({ mensaje_id: "msg-003", hoy: HOY }, ctx)
    const maestro = z
      .object({ origen: z.string(), filas: z.array(z.object({ celdas: z.record(z.string(), z.string()), marca: z.string().nullable(), cambiados: z.array(z.string()) })) })
      .parse(await (await pedir("/api/maestro")).json())
    expect(maestro.origen).toBe("out")
    expect(maestro.filas.find((fila) => fila.celdas.id_contrato === "CT-2026-011")).toMatchObject({ marca: "actualizacion", cambiados: ["valor", "fecha_fin", "estado_poliza"] })
    const { mensajes } = BuzonSchema.parse(await (await pedir("/api/buzon")).json())
    expect(mensajes.find((mensaje) => mensaje.id === "msg-003")?.estado).toBe("actualizado")

    expect((await pedir("/api/reiniciar", { metodo: "POST", cuerpo: {} })).status).toBe(200)
    const despues = BuzonSchema.parse(await (await pedir("/api/buzon")).json())
    expect(despues.mensajes.every((mensaje) => mensaje.estado === "pendiente")).toBe(true)
    expect(z.object({ origen: z.string() }).parse(await (await pedir("/api/maestro")).json()).origen).toBe("fixture")
  })

  test("sirve el front y rechaza archivos fuera de web/", async () => {
    expect((await pedir("/", { clave: null })).status).toBe(200)
    expect((await pedir("/registro.js", { clave: null })).status).toBe(200)
    expect((await pedir("/../.env", { clave: null })).status).toBe(404)
  })
})
