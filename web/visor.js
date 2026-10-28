// Vista previa de un texto: el contrato del buzón, el documento archivado o un Markdown formateado.
import { escapar, markdown } from "./markdown.js"

const modal = document.querySelector("#visor")
const titulo = document.querySelector("#visor-titulo")
const contenido = document.querySelector("#visor-contenido")

function cerrar() {
  modal.hidden = true
  contenido.innerHTML = ""
}

/** `cargar` es una función que devuelve el texto; así el visor no sabe de rutas ni de claves. */
export async function abrirVisor(nombre, cargar) {
  titulo.textContent = nombre
  contenido.innerHTML = `<p class="cargando">Cargando…</p>`
  modal.hidden = false
  document.querySelector("#visor-cerrar").focus()
  try {
    const texto = await cargar()
    contenido.innerHTML = nombre.endsWith(".md") ? `<div class="documento">${markdown(texto)}</div>` : `<pre class="documento-plano">${escapar(texto)}</pre>`
  } catch (error) {
    contenido.innerHTML = `<p class="texto-error">${escapar(error.message)}</p>`
  }
}

document.querySelector("#visor-cerrar").addEventListener("click", cerrar)
modal.addEventListener("click", (evento) => evento.target === modal && cerrar())
document.addEventListener("keydown", (evento) => evento.key === "Escape" && !modal.hidden && cerrar())
