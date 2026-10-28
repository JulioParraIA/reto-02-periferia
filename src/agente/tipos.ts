import type { Mensaje } from "../llm/adapter.ts"

/** Cómo se muestra una llamada a herramienta en el chat: nombre, argumentos, resultado resumido y sus datos. */
export type LlamadaVisible = {
  herramienta: string
  argumentos: unknown
  ok: boolean
  resumen: string
  /** `data` de la herramienta cuando salió bien; el front arma con esto el expediente del caso. */
  datos?: unknown
}

/** Consumo del modelo en un turno (una interacción del usuario), sumando todas las llamadas del turno. */
export type ConsumoTurno = {
  modelo: string
  proveedor: string | null
  llamadas: number
  duracionMs: number
  entrada: { tokens: number; enCache: number; escritosEnCache: number; usd: number | null }
  salida: { tokens: number; razonamiento: number; usd: number | null }
  totalUsd: number | null
}

/** Respuesta de POST /api/chat (sección 6.4 del PRD, más el consumo del turno). */
export type ResultadoTurno = {
  reply: string
  toolCalls: LlamadaVisible[]
  needsConfirmation: boolean
  consumo: ConsumoTurno
  error?: boolean
}

export type EntradaHistorial = {
  /** `evento` es algo que hizo la persona en la interfaz (por ejemplo, reiniciar el buzón). */
  rol: "usuario" | "agente" | "evento"
  texto: string
  ts: string
  toolCalls?: LlamadaVisible[]
  needsConfirmation?: boolean
  consumo?: ConsumoTurno
  error?: boolean
}

/** Registros que esperan la confirmación de la analista: los mensajes del buzón con campos en revisión. */
export type Pendiente = { mensajes: string[] }

export type Sesion = {
  id: string
  creada: string
  /** Transcripción completa que se le envía al modelo. */
  mensajes: Mensaje[]
  /** Lo que ve la persona en el chat. */
  historial: EntradaHistorial[]
  tokens: number
  /** De los tokens de entrada, cuántos salieron de la caché del proveedor. */
  tokensEnCache: number
  costo: number
  pendiente: Pendiente | null
  ocupada: boolean
}
