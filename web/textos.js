// Nombres legibles y formatos de número en español de Colombia.

export const NOMBRES_HERRAMIENTAS = {
  contratos_leer_buzon: "Leer el buzón",
  contratos_extraer: "Extraer los datos del contrato",
  contratos_validar: "Validar contra el maestro",
  contratos_registrar: "Registrar en el maestro",
  contratos_alertas: "Generar las alertas",
}

/** Estado de un mensaje del buzón: lo que hizo contratos_registrar, o pendiente. */
export const ESTADOS = {
  pendiente: { texto: "Por procesar", tono: "neutro" },
  insertado: { texto: "Nuevo · registrado", tono: "bien" },
  actualizado: { texto: "Actualización · registrada", tono: "info" },
  duplicado: { texto: "Duplicado · sin cambios", tono: "neutro" },
  rechazado: { texto: "Rechazado", tono: "mal" },
}

export const COLUMNAS_MAESTRO = {
  id_contrato: "Contrato",
  cliente: "Cliente",
  nit_cliente: "NIT / RUC / RTN",
  pais: "País",
  objeto: "Objeto",
  valor: "Valor",
  moneda: "Moneda",
  fecha_inicio: "Inicio",
  fecha_fin: "Fin",
  requiere_poliza: "Póliza",
  tipo_poliza: "Tipo de póliza",
  estado_poliza: "Estado póliza",
  comercial: "Comercial",
  ruta_sharepoint: "Archivo",
  fecha_registro: "Registro",
  fuente: "Fuente",
}

const ENTERO = new Intl.NumberFormat("es-CO")
const DOLARES = new Intl.NumberFormat("es-CO", { minimumFractionDigits: 4, maximumFractionDigits: 4 })

export function tokens(n) {
  return ENTERO.format(n ?? 0)
}

export function dolares(n) {
  return n === null || n === undefined ? "—" : `USD ${DOLARES.format(n)}`
}

export function dinero(valor, moneda) {
  const numero = Number(valor)
  if (valor === "" || !Number.isFinite(numero)) return valor
  if (numero === 0) return "Indeterminado (0)"
  return `${moneda} ${ENTERO.format(numero)}`
}

export function segundos(ms) {
  return `${(ms / 1000).toLocaleString("es-CO", { maximumFractionDigits: 1 })} s`
}

export function hora(iso) {
  return new Date(iso).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })
}

export function fechaCorta(iso) {
  const fecha = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso)
  return Number.isNaN(fecha.getTime()) ? iso : fecha.toLocaleDateString("es-CO", { day: "numeric", month: "short", year: "numeric" })
}
