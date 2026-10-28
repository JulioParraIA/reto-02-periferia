/**
 * Arranque del servidor: API del chat, rutas de la interfaz y el front de web/, con un solo comando.
 *   bun run dev   →   http://localhost:3000
 */
import path from "node:path"
import { HERRAMIENTAS } from "./agente/herramientas.ts"
import { cargarPromptSistema } from "./agente/prompt.ts"
import { Sesiones } from "./agente/sesiones.ts"
import { leerConfig } from "./config.ts"
import { crearManejador } from "./http/app.ts"
import { AdaptadorOpenRouter } from "./llm/openrouter.ts"

const RAIZ = path.resolve(import.meta.dir, "..")
const config = leerConfig()
const llm = new AdaptadorOpenRouter({
  clave: config.claveModelo,
  modelo: config.modelo,
  maxTokens: config.maxTokensRespuesta,
  timeoutMs: config.timeoutMs,
  esfuerzo: config.esfuerzo,
})

const manejador = crearManejador({
  raiz: RAIZ,
  claveAcceso: config.claveAcceso,
  promptSistema: await cargarPromptSistema(RAIZ),
  sesiones: new Sesiones(),
  ciclo: {
    llm,
    herramientas: HERRAMIENTAS,
    directorio: RAIZ,
    maxIteraciones: config.maxIteraciones,
    maxTokensSesion: config.maxTokensSesion,
  },
})

const servidor = Bun.serve({
  port: config.puerto,
  hostname: "0.0.0.0",
  // Un turno con varias herramientas puede tardar; Bun corta a los 10 s por defecto.
  idleTimeout: 255,
  fetch: manejador,
  error(error) {
    console.error("Error no controlado:", error)
    return Response.json({ error: "Error interno del servidor." }, { status: 500 })
  },
})

console.log(`Agente de registro de contratos en http://localhost:${servidor.port} · ${llm.proveedor} ${llm.modelo}`)
if (!config.claveModelo) console.log("Aviso: falta OPENROUTER_API_KEY; el chat responderá con un error hasta configurarla.")
