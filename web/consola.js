// Consola negra de consumo: por cada interacción, tokens y dólares de entrada y de salida, y el modelo que respondió.
import { escapar } from "./markdown.js"
import { dolares, hora, segundos, tokens } from "./textos.js"

const cuerpo = document.querySelector("#consola-cuerpo")
const interacciones = []
let modeloConfigurado = "—"

export function fijarModelo(proveedor, modelo) {
  modeloConfigurado = `${modelo} · vía ${proveedor}`
  pintar()
}

export function reiniciarConsola() {
  interacciones.length = 0
  pintar()
}

/** Agrega el consumo de un turno; `ts` es la hora en que terminó. */
export function registrarConsumo(consumo, ts = new Date().toISOString()) {
  if (!consumo) return
  interacciones.push({ ...consumo, ts })
  pintar()
}

function sumar(campo) {
  return interacciones.reduce((total, item) => total + (campo(item) ?? 0), 0)
}

function linea(etiqueta, valor, extra = "", usd = "") {
  return `<div class="c-linea"><span class="c-etiqueta">${etiqueta}</span><span class="c-valor">${valor}</span><span class="c-extra">${extra}</span><span class="c-usd">${usd}</span></div>`
}

function pintarInteraccion(item, indice) {
  const ultimo = interacciones.at(-1)
  const proveedor = item.proveedor ? ` · ${escapar(item.proveedor)}` : ""
  return `<div class="c-interaccion${item === ultimo ? " c-ultima" : ""}">
    <div class="c-titulo">#${indice + 1} · ${hora(item.ts)} · ${item.llamadas} ${item.llamadas === 1 ? "llamada" : "llamadas"} · ${segundos(item.duracionMs)}</div>
    <div class="c-modelo">${escapar(item.modelo)}${proveedor}</div>
    ${linea("entrada", `${tokens(item.entrada.tokens)} tok`, item.entrada.enCache ? `caché ${tokens(item.entrada.enCache)}` : "", dolares(item.entrada.usd))}
    ${linea("salida", `${tokens(item.salida.tokens)} tok`, item.salida.razonamiento ? `razonamiento ${tokens(item.salida.razonamiento)}` : "", dolares(item.salida.usd))}
    ${linea("total", "", "", `<strong>${dolares(item.totalUsd)}</strong>`)}
  </div>`
}

function pintar() {
  const totalTokens = sumar((item) => item.entrada.tokens + item.salida.tokens)
  const cabecera = `<div class="c-modelo-configurado">modelo <strong>${escapar(modeloConfigurado)}</strong></div>`
  const lista = interacciones.length
    ? interacciones.map(pintarInteraccion).join("")
    : `<div class="c-vacio">Aquí aparece el consumo de cada mensaje que le mandes al agente.</div>`
  const pie = interacciones.length
    ? `<div class="c-pie">
        ${linea("entrada", `${tokens(sumar((i) => i.entrada.tokens))} tok`, "", dolares(sumar((i) => i.entrada.usd)))}
        ${linea("salida", `${tokens(sumar((i) => i.salida.tokens))} tok`, "", dolares(sumar((i) => i.salida.usd)))}
        ${linea("sesión", `${tokens(totalTokens)} tok`, `${interacciones.length} ${interacciones.length === 1 ? "interacción" : "interacciones"}`, `<strong>${dolares(sumar((i) => i.totalUsd))}</strong>`)}
      </div>`
    : ""
  cuerpo.innerHTML = `${cabecera}<div class="c-lista">${lista}</div>${pie}`
  const listaNodo = cuerpo.querySelector(".c-lista")
  listaNodo.scrollTop = listaNodo.scrollHeight
}

document.querySelector("#plegar-consola").addEventListener("click", (evento) => {
  const consola = document.querySelector("#consola")
  const plegada = consola.classList.toggle("plegada")
  evento.currentTarget.textContent = plegada ? "+" : "–"
  evento.currentTarget.setAttribute("aria-expanded", String(!plegada))
})

pintar()
