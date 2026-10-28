/**
 * AdaptadorLLM para OpenRouter (API de chat completions con el formato de herramientas de OpenAI).
 * Documentación: https://openrouter.ai/docs
 */
import { z } from "zod"
import {
  ErrorLLM,
  type AdaptadorLLM,
  type EsquemaHerramienta,
  type LlamadaHerramienta,
  type Mensaje,
  type OpcionesEnvio,
  type RespuestaModelo,
  type UsoModelo,
} from "./adapter.ts"

const URL_CHAT = "https://openrouter.ai/api/v1/chat/completions"

export type ConfigOpenRouter = {
  clave: string
  modelo: string
  maxTokens: number
  timeoutMs: number
  /** Esfuerzo de razonamiento (low, medium, high…); si no se da, el del proveedor. */
  esfuerzo?: string
}

type LlamadaOpenRouter = { id: string; type: "function"; function: { name: string; arguments: string } }
type MensajeOpenRouter =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: LlamadaOpenRouter[]; reasoning_details?: unknown[] }
  | { role: "tool"; tool_call_id: string; content: string }

const RespuestaSchema = z.object({
  model: z.string().nullish(),
  provider: z.string().nullish(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z
            .array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string().nullish() }) }))
            .nullish(),
          reasoning_details: z.array(z.unknown()).nullish(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      cost: z.number().nullish(),
      prompt_tokens_details: z.object({ cached_tokens: z.number().nullish(), cache_write_tokens: z.number().nullish() }).nullish(),
      completion_tokens_details: z.object({ reasoning_tokens: z.number().nullish() }).nullish(),
      cost_details: z
        .object({ upstream_inference_prompt_cost: z.number().nullish(), upstream_inference_completions_cost: z.number().nullish() })
        .nullish(),
    })
    .nullish(),
})

type UsoOpenRouter = z.infer<typeof RespuestaSchema>["usage"]

/** OpenRouter informa el costo total y, aparte, lo que costó la entrada y la salida. */
function aUso(uso: UsoOpenRouter): UsoModelo {
  return {
    entrada: uso?.prompt_tokens ?? 0,
    entradaEnCache: uso?.prompt_tokens_details?.cached_tokens ?? 0,
    entradaEscritaEnCache: uso?.prompt_tokens_details?.cache_write_tokens ?? 0,
    salida: uso?.completion_tokens ?? 0,
    salidaRazonamiento: uso?.completion_tokens_details?.reasoning_tokens ?? 0,
    costoEntrada: uso?.cost_details?.upstream_inference_prompt_cost ?? null,
    costoSalida: uso?.cost_details?.upstream_inference_completions_cost ?? null,
    costo: uso?.cost ?? null,
  }
}
const ErrorSchema = z.object({ error: z.object({ message: z.string() }) })

const MENSAJES_POR_ESTADO: Record<number, string> = {
  401: "OpenRouter rechazó la clave (401): revisa OPENROUTER_API_KEY.",
  402: "La cuenta de OpenRouter no tiene crédito suficiente (402).",
  429: "OpenRouter está limitando las solicitudes (429); espera un momento y vuelve a intentar.",
}

function aOpenRouter(mensaje: Mensaje): MensajeOpenRouter {
  switch (mensaje.rol) {
    case "system":
    case "user":
      return { role: mensaje.rol, content: mensaje.contenido }
    case "tool":
      return { role: "tool", tool_call_id: mensaje.idLlamada, content: mensaje.contenido }
    case "assistant":
      return {
        role: "assistant",
        content: mensaje.contenido.length > 0 ? mensaje.contenido : null,
        ...(mensaje.llamadas.length > 0 ? { tool_calls: mensaje.llamadas.map(aLlamadaOpenRouter) } : {}),
        // OpenRouter pide devolver el razonamiento sin cambios para que el modelo no pierda el hilo entre herramientas.
        ...(Array.isArray(mensaje.datosProveedor) ? { reasoning_details: mensaje.datosProveedor } : {}),
      }
  }
}

function aLlamadaOpenRouter(llamada: LlamadaHerramienta): LlamadaOpenRouter {
  return { id: llamada.id, type: "function", function: { name: llamada.nombre, arguments: llamada.argumentos } }
}

function aHerramientaOpenRouter(herramienta: EsquemaHerramienta) {
  return { type: "function", function: { name: herramienta.nombre, description: herramienta.descripcion, parameters: herramienta.parametros } }
}

async function mensajeDeError(respuesta: Response): Promise<string> {
  const conocido = MENSAJES_POR_ESTADO[respuesta.status]
  if (conocido) return conocido
  const cuerpo = ErrorSchema.safeParse(await respuesta.json().catch(() => null))
  return `OpenRouter respondió ${respuesta.status}${cuerpo.success ? `: ${cuerpo.data.error.message}` : ""}.`
}

export class AdaptadorOpenRouter implements AdaptadorLLM {
  readonly proveedor = "openrouter"
  readonly modelo: string

  constructor(private readonly config: ConfigOpenRouter) {
    this.modelo = config.modelo
  }

  async enviar(mensajes: Mensaje[], herramientas: EsquemaHerramienta[], opciones: OpcionesEnvio = {}): Promise<RespuestaModelo> {
    if (!this.config.clave) throw new ErrorLLM("El servidor no tiene configurada la clave del modelo (OPENROUTER_API_KEY).", "configuracion")
    const respuesta = await this.llamar(this.cuerpo(mensajes, herramientas, opciones))
    if (!respuesta.ok) throw new ErrorLLM(await mensajeDeError(respuesta), "proveedor")
    const datos = RespuestaSchema.safeParse(await respuesta.json().catch(() => null))
    const mensaje = datos.success ? datos.data.choices[0]?.message : undefined
    if (!datos.success || !mensaje) throw new ErrorLLM("OpenRouter devolvió una respuesta que no se pudo leer.", "respuesta")
    return {
      texto: mensaje.content ?? "",
      llamadas: (mensaje.tool_calls ?? []).map((llamada) => ({
        id: llamada.id,
        nombre: llamada.function.name,
        argumentos: llamada.function.arguments || "{}",
      })),
      uso: aUso(datos.data.usage),
      modeloUsado: datos.data.model ?? undefined,
      proveedorUsado: datos.data.provider ?? undefined,
      datosProveedor: mensaje.reasoning_details ?? undefined,
    }
  }

  private cuerpo(mensajes: Mensaje[], herramientas: EsquemaHerramienta[], opciones: OpcionesEnvio): Record<string, unknown> {
    return {
      model: this.config.modelo,
      messages: mensajes.map(aOpenRouter),
      max_tokens: this.config.maxTokens,
      // Caché automática: cada vuelta reutiliza lo ya enviado y lo cobra al 10 %.
      cache_control: { type: "ephemeral" },
      ...(herramientas.length > 0
        ? { tools: herramientas.map(aHerramientaOpenRouter), tool_choice: opciones.sinHerramientas ? "none" : "auto" }
        : {}),
      ...(this.config.esfuerzo ? { reasoning: { effort: this.config.esfuerzo } } : {}),
    }
  }

  private async llamar(cuerpo: Record<string, unknown>): Promise<Response> {
    try {
      return await fetch(URL_CHAT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.clave}`,
          "Content-Type": "application/json",
          "X-Title": "Reto 02 Periferia - Registro de contratos",
        },
        body: JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new ErrorLLM(`El modelo no respondió en ${Math.round(this.config.timeoutMs / 1000)} segundos.`, "timeout")
      }
      throw new ErrorLLM("No se pudo conectar con OpenRouter; revisa la conexión a internet.", "red")
    }
  }
}
