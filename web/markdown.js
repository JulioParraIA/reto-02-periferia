// Markdown mínimo y seguro: primero se escapa todo el HTML y después se aplican unos pocos formatos.

export function escapar(texto) {
  return String(texto ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

function enLinea(texto) {
  return escapar(texto)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
}

function tabla(lineas) {
  const celdas = (linea) => linea.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((celda) => enLinea(celda.replace(/\\\|/g, "|").trim()))
  const [cabecera, , ...filas] = lineas
  const th = celdas(cabecera).map((c) => `<th>${c}</th>`).join("")
  const tr = filas.map((fila) => `<tr>${celdas(fila).map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")
  return `<div class="tabla-desplazable"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`
}

export function markdown(texto) {
  const lineas = String(texto ?? "").replace(/\r/g, "").split("\n")
  const html = []
  let lista = null
  const cerrarLista = () => {
    if (lista) html.push(`</${lista}>`)
    lista = null
  }
  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i]
    if (linea.trim().startsWith("|") && /^\s*\|?\s*:?-{2,}/.test(lineas[i + 1] ?? "")) {
      cerrarLista()
      const bloque = []
      while (i < lineas.length && lineas[i].trim().startsWith("|")) bloque.push(lineas[i++])
      i--
      html.push(tabla(bloque))
      continue
    }
    const titulo = linea.match(/^(#{1,4})\s+(.*)$/)
    const cita = linea.match(/^>\s?(.*)$/)
    const vineta = linea.match(/^\s*[-*]\s+(.*)$/)
    const numero = linea.match(/^\s*\d+[.)]\s+(.*)$/)
    if (titulo) {
      cerrarLista()
      html.push(`<h4>${enLinea(titulo[2])}</h4>`)
    } else if (cita) {
      cerrarLista()
      html.push(`<blockquote>${enLinea(cita[1])}</blockquote>`)
    } else if (vineta || numero) {
      const tipo = vineta ? "ul" : "ol"
      if (lista !== tipo) {
        cerrarLista()
        html.push(`<${tipo}>`)
        lista = tipo
      }
      html.push(`<li>${enLinea((vineta ?? numero)[1])}</li>`)
    } else if (linea.trim() === "") {
      cerrarLista()
    } else {
      cerrarLista()
      html.push(`<p>${enLinea(linea)}</p>`)
    }
  }
  cerrarLista()
  return html.join("")
}
