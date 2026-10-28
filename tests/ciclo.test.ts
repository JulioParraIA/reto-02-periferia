/**
 * Pruebas del ciclo del agente con un modelo de guion (sin red ni clave): confirmación
 * humana por mensaje, tope de iteraciones, argumentos inválidos y errores del proveedor.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { procesarTurno, type DependenciasCiclo } from "../src/agente/ciclo.ts"
import { esAfirmativo } from "../src/agente/confirmacion.ts"
import { HERRAMIENTAS } from "../src/agente/herramientas.ts"
import { Sesiones } from "../src/agente/sesiones.ts"
import type { Sesion } from "../src/agente/tipos.ts"
import {
  ErrorLLM,
  type AdaptadorLLM,
  type EsquemaHerramienta,
  type Mensaje,
  type OpcionesEnvio,
  type RespuestaModelo,
} from "../src/llm/adapter.ts"
import { ExtraccionSchema, borrar, datos, maestro, proyectoTemporal } from "./apoyo.ts"

type Paso = (mensajes: Mensaje[], opciones: OpcionesEnvio) => RespuestaModelo

const USO = { entrada: 100, entradaEnCache: 40, entradaEscritaEnCache: 10, salida: 20, salidaRazonamiento: 5, costoEntrada: 0.0004, costoSalida: 0.0002, costo: 0.0006 }

/** Modelo falso: responde cada vuelta con el siguiente paso del guion. */
class ModeloDeGuion implements AdaptadorLLM {
  readonly proveedor = "guion"
  readonly modelo = "guion"
  readonly opcionesRecibidas: OpcionesEnvio[] = []

  constructor(private readonly pasos: Paso[]) {}

  async enviar(mensajes: Mensaje[], _herramientas: EsquemaHerramienta[], opciones: OpcionesEnvio = {}): Promise<RespuestaModelo> {
    this.opcionesRecibidas.push(opciones)
    const paso = this.pasos.shift()
    if (!paso) throw new Error("El guion se quedó sin pasos")
    return paso(mensajes, opciones)
  }
}

let contador = 0
function llamar(nombre: string, argumentos: unknown): Paso {
  return () => ({ texto: "", llamadas: [{ id: `llamada-${++contador}`, nombre, argumentos: JSON.stringify(argumentos) }], uso: USO })
}

function llamarCon(nombre: string, argumentos: (anterior: string) => unknown): Paso {
  return (mensajes) => llamar(nombre, argumentos(ultimoResultado(mensajes)))(mensajes, {})
}

function decir(texto: string): Paso {
  return () => ({ texto, llamadas: [], uso: USO })
}

function ultimoResultado(mensajes: Mensaje[]): string {
  const ultimo = mensajes.at(-1)
  if (ultimo?.rol !== "tool") throw new Error("Se esperaba el resultado de una herramienta")
  return ultimo.contenido
}

/** Lo que haría el modelo real con msg-006: extraer, validar (queda en revisión) y preguntar. */
function revisarMsg006(): Paso[] {
  return [
    llamar("contratos_extraer", { mensaje_id: "msg-006" }),
    llamarCon("contratos_validar", (anterior) => ({ mensaje_id: "msg-006", contrato: datos(anterior, ExtraccionSchema).valores })),
    decir("msg-006 requiere revisión de valor, fecha_inicio, fecha_fin y requiere_poliza. ¿Confirmas los valores propuestos?"),
  ]
}

let directorio = ""
let sesion: Sesion

function dependencias(llm: AdaptadorLLM, cambios: Partial<DependenciasCiclo> = {}): DependenciasCiclo {
  return { llm, herramientas: HERRAMIENTAS, directorio, maxIteraciones: 25, maxTokensSesion: 1_000_000, ...cambios }
}

function turno(mensaje: string, llm: AdaptadorLLM, cambios: Partial<DependenciasCiclo> = {}, confirmar = false) {
  return procesarTurno(sesion, mensaje, confirmar, dependencias(llm, cambios))
}

async function registrado(id: string): Promise<boolean> {
  return Bun.file(`${directorio}/out/sharepoint/maestro-contratos.csv`).exists().then(async (existe) => existe && (await maestro(directorio)).some((fila) => fila.id_contrato === id))
}

beforeEach(async () => {
  directorio = await proyectoTemporal()
  sesion = new Sesiones().obtenerOCrear("sesion-de-prueba", "prompt de prueba")
})
afterEach(() => borrar(directorio))

describe("confirmación humana (CA3 y RN5)", () => {
  test("validar con campos en revisión deja el turno esperando y el «confirmo» siguiente registra", async () => {
    const primero = await turno("Procesa msg-006", new ModeloDeGuion(revisarMsg006()))
    expect(primero.toolCalls.map((llamada) => llamada.herramienta)).toEqual(["contratos_extraer", "contratos_validar"])
    expect(primero.needsConfirmation).toBe(true)
    // Tres llamadas al modelo (dos con herramientas y la pregunta final), sumadas en el consumo del turno.
    expect(primero.consumo).toMatchObject({ llamadas: 3, entrada: { tokens: 300, enCache: 120, escritosEnCache: 30 }, salida: { tokens: 60, razonamiento: 15 } })
    expect(primero.consumo.totalUsd).toBeCloseTo(0.0018)
    expect(sesion.pendiente).toEqual({ mensajes: ["msg-006"] })

    // El modelo manda confirmado: false por descuido: el backend lo fija en true porque la analista confirmó.
    const segundo = await turno(
      "Confirmo el valor 0 y la fecha fin 2027-08-31",
      new ModeloDeGuion([
        llamar("contratos_extraer", { mensaje_id: "msg-006" }),
        llamarCon("contratos_registrar", (anterior) => ({ mensaje_id: "msg-006", contrato: { ...datos(anterior, ExtraccionSchema).valores, fecha_fin: "2027-08-31" }, confirmado: false })),
        decir("Listo, registrado CM-2026-03."),
      ]),
    )
    expect(segundo.toolCalls[1]).toMatchObject({ herramienta: "contratos_registrar", ok: true, argumentos: { confirmado: true } })
    expect(segundo.needsConfirmation).toBe(false)
    expect(await registrado("CM-2026-03")).toBe(true)
  })

  test("el modelo no puede confirmar por la analista", async () => {
    await turno("Procesa msg-006", new ModeloDeGuion(revisarMsg006()))
    const intento = await turno("¿qué dice la cláusula de garantías?", new ModeloDeGuion([llamar("contratos_registrar", { mensaje_id: "msg-006", confirmado: true }), decir("¿Confirmas?")]))
    expect(intento.toolCalls[0]).toMatchObject({ ok: false, argumentos: { confirmado: false } })
    expect(intento.toolCalls[0]?.resumen).toStartWith("requiere revisión")
    expect(intento.needsConfirmation).toBe(true)
    expect(await registrado("CM-2026-03")).toBe(false)
  })

  test("una negación no confirma y la confirmación solo vale para el mensaje pendiente", async () => {
    await turno("Procesa msg-006", new ModeloDeGuion(revisarMsg006()))
    const negado = await turno("no, espera", new ModeloDeGuion([llamar("contratos_registrar", { mensaje_id: "msg-006" }), decir("Entendido.")]))
    expect(negado.toolCalls[0]?.ok).toBe(false)
    // Se vuelve a dejar pendiente msg-006 y se confirma, pero el modelo intenta registrar otro mensaje.
    const otro = await turno("sí", new ModeloDeGuion([llamar("contratos_registrar", { mensaje_id: "msg-001" }), decir("…")]))
    expect(otro.toolCalls[0]).toMatchObject({ ok: true, argumentos: { confirmado: false } })
    expect(await registrado("CM-2026-03")).toBe(false)
  })

  test("el botón «Confirmar registro» confirma aunque el texto no lo diga", async () => {
    await turno("Procesa msg-006", new ModeloDeGuion(revisarMsg006()))
    const confirmado = await turno("Hazme ese favor", new ModeloDeGuion([llamar("contratos_registrar", { mensaje_id: "msg-006" }), decir("Registrado.")]), {}, true)
    expect(confirmado.toolCalls[0]?.ok).toBe(true)
  })
})

describe("topes y errores (CA1, CA5 y HU-6)", () => {
  test("al llegar al tope de iteraciones responde sin herramientas con lo que tiene", async () => {
    const modelo = new ModeloDeGuion([llamar("contratos_leer_buzon", {}), llamar("contratos_extraer", { mensaje_id: "msg-001" }), decir("Leí el buzón y extraje msg-001; faltan los demás.")])
    const resultado = await turno("Procesa el buzón", modelo, { maxIteraciones: 2 })
    expect(resultado.toolCalls).toHaveLength(2)
    expect(resultado.reply).toBe("Leí el buzón y extraje msg-001; faltan los demás.")
    expect(modelo.opcionesRecibidas.at(-1)).toEqual({ sinHerramientas: true })
  })

  test("argumentos inválidos y herramientas desconocidas vuelven al modelo como error sin romper el turno", async () => {
    const modelo = new ModeloDeGuion([
      () => ({ texto: "", llamadas: [{ id: "x1", nombre: "contratos_extraer", argumentos: "{no es json" }], uso: USO }),
      llamar("contratos_borrar_todo", {}),
      decir("No pude extraer el contrato."),
    ])
    const resultado = await turno("Procesa algo", modelo)
    expect(resultado.toolCalls.map((llamada) => llamada.ok)).toEqual([false, false])
    expect(resultado.toolCalls[0]?.resumen).toContain("Argumentos inválidos")
    expect(resultado.toolCalls[1]?.resumen).toContain("no existe")
    expect(resultado.reply).toBe("No pude extraer el contrato.")
    // Las llamadas que no se ejecutaron también quedan en out/log.jsonl (CA4).
    const log = await Bun.file(`${directorio}/out/log.jsonl`).text()
    expect(log.trim().split("\n")).toHaveLength(2)
  })

  test("un error del proveedor se explica en el chat y la sesión sigue", async () => {
    const caido: AdaptadorLLM = {
      proveedor: "caido",
      modelo: "caido",
      enviar: async () => {
        throw new ErrorLLM("El modelo no respondió en 90 segundos.", "timeout")
      },
    }
    const fallido = await turno("Hola", caido)
    expect(fallido).toMatchObject({ error: true, reply: "No pude completar la respuesta: El modelo no respondió en 90 segundos." })
    expect(sesion.mensajes.at(-1)?.rol).toBe("assistant")
    const siguiente = await turno("¿Sigues ahí?", new ModeloDeGuion([decir("Sí, aquí estoy.")]))
    expect(siguiente.reply).toBe("Sí, aquí estoy.")
  })

  test("el tope de tokens de la sesión corta sin llamar al modelo", async () => {
    sesion.tokens = 500
    const modelo = new ModeloDeGuion([])
    const resultado = await turno("Procesa el buzón", modelo, { maxTokensSesion: 500 })
    expect(resultado.reply).toContain("tope de tokens")
    expect(modelo.opcionesRecibidas).toHaveLength(0)
  })
})

describe("esAfirmativo", () => {
  test.each([
    ["Confirmo el valor 0 y la fecha fin 2027-08-31", true],
    ["Sí, adelante", true],
    ["dale", true],
    ["Registra lo que esté limpio", false],
    ["No registres nada dudoso sin preguntarme", false],
    ["¿ya quedó registrado?", false],
    ["no, espera", false],
    ["procesa el buzón", false],
  ])("«%s» → %p", (mensaje, esperado) => {
    expect(esAfirmativo(mensaje)).toBe(esperado)
  })
})
