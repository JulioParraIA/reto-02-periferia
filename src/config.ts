/**
 * Configuración desde variables de entorno (Bun lee .env solo; ver .env.example).
 * La clave del modelo se queda en el backend: no viaja al front, a los registros ni a la API.
 */
import { z } from "zod"

/** Una variable vacía en .env cuenta como no definida. */
function opcional<T extends z.ZodType>(esquema: T) {
  return z.preprocess((valor) => (valor === "" ? undefined : valor), esquema)
}

const EntornoSchema = z.object({
  OPENROUTER_API_KEY: opcional(z.string().default("")),
  LLM_MODELO: opcional(z.string().default("anthropic/claude-sonnet-5.5")),
  LLM_ESFUERZO: opcional(z.enum(["low", "medium", "high"]).optional()),
  LLM_MAX_TOKENS: opcional(z.coerce.number().int().positive().default(8000)),
  LLM_TIMEOUT_MS: opcional(z.coerce.number().int().positive().default(90_000)),
  MAX_ITERACIONES: opcional(z.coerce.number().int().positive().default(25)),
  MAX_TOKENS_SESION: opcional(z.coerce.number().int().positive().default(400_000)),
  CLAVE_ACCESO: opcional(z.string().default("")),
  PORT: opcional(z.coerce.number().int().positive().default(3000)),
})

export type Config = {
  claveModelo: string
  modelo: string
  esfuerzo: string | undefined
  maxTokensRespuesta: number
  timeoutMs: number
  maxIteraciones: number
  maxTokensSesion: number
  claveAcceso: string
  puerto: number
}

export function leerConfig(entorno: Record<string, string | undefined> = process.env): Config {
  const leido = EntornoSchema.safeParse(entorno)
  if (!leido.success) {
    const problemas = leido.error.issues.map((problema) => `${problema.path.join(".")}: ${problema.message}`).join("; ")
    throw new Error(`Configuración inválida en las variables de entorno: ${problemas}`)
  }
  const variables = leido.data
  return {
    claveModelo: variables.OPENROUTER_API_KEY,
    modelo: variables.LLM_MODELO,
    esfuerzo: variables.LLM_ESFUERZO,
    maxTokensRespuesta: variables.LLM_MAX_TOKENS,
    timeoutMs: variables.LLM_TIMEOUT_MS,
    maxIteraciones: variables.MAX_ITERACIONES,
    maxTokensSesion: variables.MAX_TOKENS_SESION,
    claveAcceso: variables.CLAVE_ACCESO,
    puerto: variables.PORT,
  }
}
