/**
 * Robustez de la extracción con 22 redacciones distintas a las de los fixtures (tests/variaciones/casos.ts).
 * Cada caso fija lo que debe salir: los valores que un humano leería o, si el texto no alcanza, que el
 * campo vaya a revisión. Ningún caso puede registrar un dato equivocado sin pasar por la analista.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import * as contratos from "../src/tools/contratos.ts"
import { ExtraccionSchema, ValidacionSchema, borrar, datos, proyectoTemporal } from "./apoyo.ts"
import { CASOS } from "./variaciones/casos.ts"

type Esperado = { valores?: Record<string, unknown>; revision?: string[]; clasificacion?: string }

/** El resultado correcto de cada caso y el error que tenía antes de la corrección. */
const ESPERADOS: Record<string, Esperado & { antes: string }> = {
  "msg-101": { valores: { valor: 486_500_000, moneda: "COP", fecha_fin: "2027-09-30" }, revision: [], antes: "bien" },
  "msg-102": { valores: { fecha_inicio: "2026-08-15", fecha_fin: "2027-08-14" }, revision: [], antes: "no leía 15/08/2026" },
  "msg-103": { valores: { cliente: "Consorcio Vial del Norte" }, revision: ["cliente", "nit_cliente"], antes: "registraba a la primera integrante como cliente" },
  "msg-104": { valores: { valor: 800_000_000 }, revision: ["valor"], antes: "registraba el tope como valor sin revisión" },
  "msg-105": { valores: { valor: 90_000_000, fecha_inicio: "2026-11-01", fecha_fin: "2027-04-30" }, revision: [], antes: "rechazaba el contrato" },
  "msg-106": { valores: { valor: 1_250_000_000, moneda: "COP" }, revision: ["fecha_inicio", "fecha_fin"], antes: "no leía la cifra sin paréntesis" },
  "msg-107": { valores: { fecha_inicio: "2026-09-01", fecha_fin: "2027-08-31" }, revision: [], antes: "ponía como inicio la fecha final, con confianza 0,93" },
  "msg-108": { valores: { fecha_fin: "2027-12-31" }, clasificacion: "actualizacion", antes: "rechazaba la «MODIFICACIÓN No. 2»" },
  "msg-109": { revision: ["cliente"], antes: "registraba al proveedor como cliente" },
  "msg-110": { valores: { nit_cliente: "155612345", valor: 210_000.5, moneda: "PAB" }, revision: [], antes: "juntaba los guiones del RUC de Panamá" },
  "msg-201": { valores: { requiere_poliza: false }, revision: [], antes: "«no deberá constituir pólizas» contaba como que sí" },
  "msg-202": { valores: { cliente: "Industrias Norte S.A.S.", nit_cliente: "900555666" }, revision: [], antes: "rechazaba «sociedad identificada con NIT.»" },
  "msg-203": { valores: { fecha_inicio: "2026-08-01", fecha_fin: "2027-07-31" }, revision: [], antes: "no calculaba el fin con el plazo en meses" },
  "msg-204": { clasificacion: "actualizacion", revision: ["otrosi", "valor"], antes: "marcaba «actualizado» sin cambiar nada" },
  "msg-205": { clasificacion: "duplicado", antes: "«CT 2026 012» creaba una fila duplicada" },
  "msg-206": { valores: { id_contrato: "CT-2026-206" }, revision: [], antes: "no leía «N°»" },
  "msg-207": { valores: { valor: 600_000_000, moneda: "COP" }, revision: [], antes: "bien" },
  "msg-208": { valores: { fecha_inicio: "2026-08-01", fecha_fin: "2027-07-31" }, revision: [], antes: "no leía «agosto 1 de 2026»" },
  // El domicilio de la plantilla es Bogotá y el RUC es de Ecuador: la contradicción va a revisión.
  "msg-209": { valores: { valor: 120_000, moneda: "USD" }, revision: ["pais"], antes: "bien" },
  "msg-210": { valores: { cliente: "Unión Temporal Salud Digital 2026", nit_cliente: "901000111" }, revision: [], antes: "bien" },
  "msg-211": { valores: { valor: 1_250_000_000 }, revision: [], antes: "bien" },
  "msg-212": { valores: { valor: 240_000_000 }, revision: ["valor"], antes: "registraba el valor mensual como total" },
}

let directorio = ""
const ctx = () => ({ directory: directorio, sessionId: "variaciones" })

beforeAll(async () => {
  directorio = await proyectoTemporal()
  for (const caso of CASOS) {
    const carpeta = path.join(directorio, "fixtures", "reto-02", "buzon", caso.id)
    await mkdir(carpeta, { recursive: true })
    const correo = { id: caso.id, de: "lgomez@periferia-ficticia.com", para: "contratos@periferia-ficticia.com", asunto: caso.prueba, fecha: "2026-09-10T10:00:00-05:00", cuerpo: caso.correo, adjuntos: ["contrato.txt"] }
    await writeFile(path.join(carpeta, "correo.json"), JSON.stringify(correo), "utf8")
    await writeFile(path.join(carpeta, "contrato.txt"), caso.texto, "utf8")
  }
})
afterAll(() => borrar(directorio))

describe("redacciones distintas a las del fixture", () => {
  test("todos los casos tienen su resultado esperado", () => {
    expect(CASOS.map((caso) => caso.id).sort()).toEqual(Object.keys(ESPERADOS).sort())
  })

  for (const caso of CASOS) {
    const esperado = ESPERADOS[caso.id]
    test(`${caso.id} · ${caso.prueba} (antes: ${esperado?.antes})`, async () => {
      if (!esperado) throw new Error(`Falta el resultado esperado de ${caso.id}`)
      const validacion = datos(await contratos.validar.execute({ mensaje_id: caso.id }, ctx()), ValidacionSchema)
      expect(validacion.clasificacion).toBe(esperado.clasificacion ?? "nuevo")
      if (esperado.revision) expect(validacion.requiere_revision).toEqual(esperado.revision)
      if (esperado.valores) {
        const { valores } = datos(await contratos.extraer.execute({ mensaje_id: caso.id }, ctx()), ExtraccionSchema)
        expect(valores).toMatchObject(esperado.valores)
      }
    })
  }
})
