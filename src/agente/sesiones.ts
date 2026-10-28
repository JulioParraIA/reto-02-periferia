/** Sesiones en memoria (el PRD no pide persistencia). Se descartan las más viejas al pasar el máximo. */
import type { Sesion } from "./tipos.ts"

export class Sesiones {
  private readonly sesiones = new Map<string, Sesion>()

  constructor(private readonly maximo = 500) {}

  obtener(id: string): Sesion | undefined {
    return this.sesiones.get(id)
  }

  obtenerOCrear(id: string, promptSistema: string): Sesion {
    const existente = this.sesiones.get(id)
    if (existente) return existente
    const nueva: Sesion = {
      id,
      creada: new Date().toISOString(),
      mensajes: [{ rol: "system", contenido: promptSistema }],
      historial: [],
      tokens: 0,
      tokensEnCache: 0,
      costo: 0,
      pendiente: null,
      ocupada: false,
    }
    this.sesiones.set(id, nueva)
    if (this.sesiones.size > this.maximo) {
      const masVieja = this.sesiones.keys().next().value
      if (masVieja !== undefined) this.sesiones.delete(masVieja)
    }
    return nueva
  }
}
