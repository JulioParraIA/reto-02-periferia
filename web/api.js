// Llamadas al backend con la clave de acceso en la cabecera.

let claveAcceso = ""

export function fijarClave(clave) {
  claveAcceso = clave ?? ""
}

function cabeceras(extra = {}) {
  return { ...(claveAcceso ? { "x-clave-acceso": claveAcceso } : {}), ...extra }
}

/** Devuelve { ok, estado, datos } y nunca lanza: un fallo de red vuelve con estado 0. */
export async function pedir(ruta, { metodo = "GET", cuerpo } = {}) {
  try {
    const respuesta = await fetch(ruta, {
      method: metodo,
      headers: cabeceras(cuerpo ? { "Content-Type": "application/json" } : {}),
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    })
    const datos = await respuesta.json().catch(() => ({}))
    return { ok: respuesta.ok, estado: respuesta.status, datos }
  } catch {
    return { ok: false, estado: 0, datos: { error: "No hay conexión con el servidor." } }
  }
}

/** Trae un texto (un adjunto del buzón o un archivo de out/) con la clave en la cabecera. */
export async function traerTexto(ruta) {
  const respuesta = await fetch(ruta, { headers: cabeceras() })
  if (!respuesta.ok) throw new Error(`No se pudo abrir el archivo (${respuesta.status}).`)
  return respuesta.text()
}

export function rutaArchivo(ruta) {
  return `/api/archivo?ruta=${encodeURIComponent(ruta)}`
}

export function rutaAdjunto(mensaje, nombre) {
  return `/api/buzon/${encodeURIComponent(mensaje)}/adjuntos/${encodeURIComponent(nombre)}`
}
