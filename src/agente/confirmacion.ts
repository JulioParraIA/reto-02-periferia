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

function digitos(texto: string): string {
  return texto.replace(/\D/g, "")
}

/** Si el valor aparece en el mensaje: un número con o sin separadores, una fecha AAAA-MM-DD o DD/MM/AAAA, o un texto. */
function aparece(valor: unknown, mensaje: string): boolean {
  if (typeof valor === "number") {
    const buscado = digitos(String(valor))
    return (mensaje.match(/\d[\d.,]*/g) ?? []).some((numero) => digitos(numero) === buscado)
  }
  if (typeof valor === "string" && /^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    const [anio, mes, dia] = valor.split("-")
    return mensaje.includes(valor) || mensaje.includes(`${dia}/${mes}/${anio}`) || mensaje.includes(`${Number(dia)}/${Number(mes)}/${anio}`)
  }
  if (typeof valor === "string") return palabras(mensaje).join(" ").includes(palabras(valor).join(" "))
  if (typeof valor === "boolean") return /poliza|indeterminad/.test(palabras(mensaje).join(" "))
  return false
}

/**
 * Campos que cambiaron frente a lo que se le mostró a la analista y que ella no dictó en su mensaje.
 * Una corrección vale solo si su valor aparece en lo que escribió («confirmo la fecha fin 2027-08-31»).
 * `valor_indeterminado` se deriva del valor, así que no cuenta si el valor sí se dictó.
 */
export function cambiosNoDictados(mostrados: Record<string, unknown>, nuevos: Record<string, unknown>, mensaje: string): string[] {
  const distintos = Object.keys({ ...mostrados, ...nuevos }).filter((campo) => JSON.stringify(mostrados[campo] ?? null) !== JSON.stringify(nuevos[campo] ?? null))
  return distintos.filter((campo) => {
    if (campo === "valor_indeterminado" && distintos.includes("valor")) return false
    return !aparece(nuevos[campo], mensaje)
  })
}

export function esAfirmativo(mensaje: string): boolean {
  if (mensaje.trim().endsWith("?")) return false
  const lista = palabras(mensaje)
  return !lista.some((palabra) => NEGACIONES.has(palabra)) && lista.some((palabra) => AFIRMACIONES.has(palabra))
}
