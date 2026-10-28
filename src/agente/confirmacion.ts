/**
 * Decide si un mensaje del usuario confirma los registros que el agente dejó pendientes (CA3 y RN5).
 * Es deliberadamente estricto: cualquier negación o una pregunta anulan la confirmación.
 */

/** Solo palabras de aprobación: «registra» no cuenta, porque también aparece en instrucciones como «registra lo que esté limpio». */
const AFIRMACIONES = new Set(["si", "confirmo", "confirmado", "apruebo", "aprobado", "adelante", "dale", "hazlo", "procede", "ok", "okay", "acuerdo"])
const NEGACIONES = new Set(["no", "cancela", "cancelar", "cancelo", "espera", "todavia", "detente", "nunca", "tampoco"])

function palabras(texto: string): string[] {
  return texto
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
}

export function esAfirmativo(mensaje: string): boolean {
  if (mensaje.trim().endsWith("?")) return false
  const lista = palabras(mensaje)
  return !lista.some((palabra) => NEGACIONES.has(palabra)) && lista.some((palabra) => AFIRMACIONES.has(palabra))
}
