/**
 * Herramientas del agente «Registro de Contratos Vigentes».
 *
 * Cada export es una herramienta y el modelo la ve como `contratos_<export>`.
 * Son la única fuente de valores del agente: leen fixtures/ (solo lectura) y escriben en out/.
 * Ninguna lanza excepciones: todas devuelven JSON con { ok: true, data } o { ok: false, error }.
 *
 * La extracción es determinista (expresiones regulares y reglas sobre el texto): el mismo
 * contrato da siempre los mismos valores y la misma confianza. Validar y registrar vuelven a
 * extraer del documento, así que lo que el modelo devuelva en `contrato` solo cuenta como una
 * corrección de la analista, y toda corrección exige su confirmación antes de escribirse.
 *
 * El archivo es autocontenido (solo depende de zod y node) para que modulo/tools/contratos.ts
 * sea una copia exacta que otras plataformas de agentes puedan cargar.
 */
import { appendFile, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

// ─── Tipos y constantes ──────────────────────────────────────────────────────

/** Contexto que entrega el backend. `sessionID` es el nombre que usa OpenCode. */
type Contexto = { directory: string; sessionId?: string; sessionID?: string }
type Fallo = { ok: false; error: string }
type Resultado<T> = { ok: true; data: T } | Fallo

/** RN5: un campo con confianza menor a esta pasa a revisión humana. */
const UMBRAL_CONFIANZA = 0.8
/** RN2: similitud mínima del objeto, con el mismo NIT, para tratar un documento como actualización. */
const UMBRAL_SIMILITUD = 0.9
/** El maestro quedó congelado en esta fecha; lo registrado después cubre el hueco (HU-5). */
const FECHA_CORTE = "2026-05-30"
const DIAS_ALERTA = 60
const MAX_OBJETO = 200
const ERROR_REVISION = "requiere revisión"
const NIT_PERIFERIA = "900123456"
const ZONA_HORARIA = "America/Bogota"
const ID_MENSAJE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ERRORES_EN_ESPANOL = { error: z.locales.es().localeError }

const PAISES = ["CO", "EC", "PE", "PA", "HN"] as const
const MONEDAS = ["COP", "USD", "PEN", "PAB", "HNL"] as const
const ESTADOS_POLIZA = ["vigente", "pendiente", "vencida", "no_aplica"] as const
/** Sección 7.2: columnas del maestro, en orden. */
const COLUMNAS = [
  "id_contrato",
  "cliente",
  "nit_cliente",
  "pais",
  "objeto",
  "valor",
  "moneda",
  "fecha_inicio",
  "fecha_fin",
  "requiere_poliza",
  "tipo_poliza",
  "estado_poliza",
  "comercial",
  "ruta_sharepoint",
  "fecha_registro",
  "fuente",
] as const

type Pais = (typeof PAISES)[number]
type Moneda = (typeof MONEDAS)[number]
type EstadoPoliza = (typeof ESTADOS_POLIZA)[number]
type Columna = (typeof COLUMNAS)[number]
/** Una fila del maestro tal como está en el CSV: se guarda en texto para no alterar las filas que no se tocan. */
type Fila = Record<Columna, string>

// ─── Esquemas ────────────────────────────────────────────────────────────────

const FechaSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "debe tener la forma AAAA-MM-DD")
  .refine((texto) => fechaValida(texto), "no es una fecha real del calendario")

const CorreoSchema = z.object({
  id: z.string(),
  de: z.string(),
  para: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  cuerpo: z.string(),
  adjuntos: z.array(z.string()),
})
const ComercialesSchema = z.array(z.object({ email: z.string(), nombre: z.string(), region: z.string() }))
const ProcesadosSchema = z.record(
  z.string(),
  z.object({ ts: z.string(), accion: z.string(), id_contrato: z.string().nullable(), motivo: z.string().nullable() }),
)

/** Los valores de un contrato que el modelo devuelve a validar y registrar (campo → valor). */
const ValoresSchema = z
  .object({
    id_contrato: z.string().trim().min(1).nullable(),
    cliente: z.string().trim().min(1).nullable(),
    nit_cliente: z.string().regex(/^[0-9]+$/, "solo dígitos, sin puntos ni dígito de verificación").nullable(),
    pais: z.enum(PAISES).nullable(),
    objeto: z.string().trim().min(1).max(MAX_OBJETO).nullable(),
    valor: z.number().nonnegative().nullable(),
    valor_indeterminado: z.boolean().nullable(),
    moneda: z.enum(MONEDAS, { error: `moneda desconocida; las válidas son ${MONEDAS.join(", ")}` }).nullable(),
    fecha_inicio: FechaSchema.nullable(),
    fecha_fin: FechaSchema.nullable(),
    requiere_poliza: z.boolean().nullable(),
    tipo_poliza: z.string().nullable(),
  })
  .partial()

type Correo = z.infer<typeof CorreoSchema>
type Comercial = z.infer<typeof ComercialesSchema>[number]
type Procesados = z.infer<typeof ProcesadosSchema>

type Campo<T> = { valor: T | null; confianza: number; evidencia: string | null; nota?: string }
type Campos = {
  id_contrato: Campo<string>
  cliente: Campo<string>
  nit_cliente: Campo<string>
  pais: Campo<Pais>
  objeto: Campo<string>
  valor: Campo<number>
  valor_indeterminado: Campo<boolean>
  moneda: Campo<Moneda>
  fecha_inicio: Campo<string>
  fecha_fin: Campo<string>
  requiere_poliza: Campo<boolean>
  tipo_poliza: Campo<string>
}
type NombreCampo = keyof Campos
type Valores = { [K in NombreCampo]: Campos[K]["valor"] }

type TipoDocumento = "contrato" | "contrato_marco" | "otrosi"
type Extraccion = {
  mensaje_id: string
  archivo: string
  tipo_documento: TipoDocumento
  /** Solo en un otrosí: su número, los campos que modifica y si obliga a ampliar las pólizas. */
  otrosi: { numero: string | null; modifica: NombreCampo[]; amplia_polizas: boolean; adiciona_valor: boolean } | null
  campos: Campos
  remitente: Remitente
}
type Remitente = { email: string; nombre: string | null; registrado: boolean }

type Clasificacion = "nuevo" | "actualizacion" | "duplicado" | "rechazado"
type Revision = { campo: string; motivo: string }
type Diferencia = { campo: Columna; maestro: string; documento: string }
type Validacion = {
  clasificacion: Clasificacion
  motivo: string | null
  id_contrato_existente: string | null
  requiere_revision: string[]
  detalle_revision: Revision[]
  diferencias: Diferencia[]
  /** La fila tal como quedaría en el maestro (null si no se escribe nada). */
  registro: Fila | null
  /** Los valores con los que se validó: los del documento con las correcciones del chat (null si se rechaza). */
  valores: Valores | null
  comercial: Remitente | null
  avisos: string[]
}

// ─── Utilidades generales ────────────────────────────────────────────────────

function exito<T>(data: T): { ok: true; data: T } {
  return { ok: true, data }
}

function fallo(error: string): Fallo {
  return { ok: false, error }
}

function hoyEnBogota(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONA_HORARIA, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
}

function describirProblema(error: z.ZodError): string {
  return error.issues.map((problema) => `${problema.path.join(".") || "valor"}: ${problema.message}`).join("; ")
}

/** Minúsculas, sin tildes y con espacios simples: para comparar textos. */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

function redondear(valor: number): number {
  return Math.round(valor * 100) / 100
}

function recortar(texto: string, largo = 160): string {
  const limpio = texto.replace(/\s+/g, " ").trim()
  return limpio.length > largo ? `${limpio.slice(0, largo - 1)}…` : limpio
}

// ─── Fechas ──────────────────────────────────────────────────────────────────

const MESES: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
}
const PATRON_MES = Object.keys(MESES).join("|")

function fechaValida(texto: string): boolean {
  const [anio, mes, dia] = texto.split("-").map(Number)
  if (anio === undefined || mes === undefined || dia === undefined) return false
  const fecha = new Date(Date.UTC(anio, mes - 1, dia))
  return fecha.getUTCFullYear() === anio && fecha.getUTCMonth() === mes - 1 && fecha.getUTCDate() === dia
}

function iso(anio: number, mes: number, dia: number): string {
  return `${anio}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`
}

function aFecha(texto: string): Date {
  return new Date(`${texto}T00:00:00Z`)
}

function desdeFecha(fecha: Date): string {
  return fecha.toISOString().slice(0, 10)
}

function sumarDias(texto: string, dias: number): string {
  const fecha = aFecha(texto)
  fecha.setUTCDate(fecha.getUTCDate() + dias)
  return desdeFecha(fecha)
}

/** Fin de un plazo de N meses que empieza en `inicio`: el día anterior al mismo día N meses después. */
function finDePlazo(inicio: string, meses: number): string {
  const [anio = 0, mes = 1, dia = 1] = inicio.split("-").map(Number)
  const total = mes - 1 + meses
  const anioFin = anio + Math.floor(total / 12)
  const mesFin = (total % 12) + 1
  const ultimoDia = new Date(Date.UTC(anioFin, mesFin, 0)).getUTCDate()
  return sumarDias(iso(anioFin, mesFin, Math.min(dia, ultimoDia)), -1)
}

function diasEntre(desde: string, hasta: string): number {
  return Math.round((aFecha(hasta).getTime() - aFecha(desde).getTime()) / 86_400_000)
}

type FechaEnTexto = { fecha: string; indice: number; texto: string }

/**
 * Fechas escritas como «quince (15) de agosto de 2026», «15 de agosto de 2026», «1° de agosto de 2026»,
 * «primero de agosto de 2026» o «15/08/2026» (día/mes/año, como se escribe en Colombia).
 */
function fechasEn(texto: string): FechaEnTexto[] {
  const enLetras = new RegExp(`(\\d{1,2}|primero)\\s*[°º]?\\)?\\s+(?:d[ií]as\\s+del\\s+mes\\s+)?de\\s+(${PATRON_MES})\\s+(?:de|del)\\s+(\\d{4})`, "gi")
  const fechas: FechaEnTexto[] = []
  for (const coincidencia of texto.matchAll(enLetras)) {
    const [completo, dia, mes, anio] = coincidencia
    const numeroMes = MESES[normalizar(mes ?? "")]
    if (!numeroMes || !dia || !anio) continue
    const fecha = iso(Number(anio), numeroMes, normalizar(dia) === "primero" ? 1 : Number(dia))
    if (fechaValida(fecha)) fechas.push({ fecha, indice: coincidencia.index ?? 0, texto: completo })
  }
  for (const coincidencia of texto.matchAll(new RegExp(`\\b(${PATRON_MES})\\s+(\\d{1,2})\\s*,?\\s+(?:de|del)\\s+(\\d{4})`, "gi"))) {
    const [completo, mes, dia, anio] = coincidencia
    const numeroMes = MESES[normalizar(mes ?? "")]
    const fecha = numeroMes ? iso(Number(anio), numeroMes, Number(dia)) : ""
    if (fechaValida(fecha)) fechas.push({ fecha, indice: coincidencia.index ?? 0, texto: completo })
  }
  for (const coincidencia of texto.matchAll(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/g)) {
    const [completo, dia, mes, anio] = coincidencia
    const fecha = iso(Number(anio), Number(mes), Number(dia))
    if (fechaValida(fecha)) fechas.push({ fecha, indice: coincidencia.index ?? 0, texto: completo })
  }
  return fechas.sort((a, b) => a.indice - b.indice)
}

/** La primera fecha que aparece después de la palabra dada (por ejemplo «desde» o «hasta»). */
function fechaDespuesDe(texto: string, palabra: RegExp): FechaEnTexto | null {
  const marca = texto.search(palabra)
  if (marca < 0) return null
  return fechasEn(texto).find((fecha) => fecha.indice > marca) ?? null
}

// ─── Números ─────────────────────────────────────────────────────────────────

const UNIDADES: Record<string, number> = {
  cero: 0,
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  dieciseis: 16,
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  veintiun: 21,
  veintiuno: 21,
  veintidos: 22,
  veintitres: 23,
  veinticuatro: 24,
  veinticinco: 25,
  veintiseis: 26,
  veintisiete: 27,
  veintiocho: 28,
  veintinueve: 29,
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  sesenta: 60,
  setenta: 70,
  ochenta: 80,
  noventa: 90,
  cien: 100,
  ciento: 100,
  doscientos: 200,
  trescientos: 300,
  cuatrocientos: 400,
  quinientos: 500,
  seiscientos: 600,
  setecientos: 700,
  ochocientos: 800,
  novecientos: 900,
}

function esPalabraNumero(palabra: string): boolean {
  return palabra in UNIDADES || palabra === "mil" || palabra === "millon" || palabra === "millones" || palabra === "y"
}

/** Convierte «doscientos sesenta y cinco millones» en 265000000. */
function numeroEnLetras(palabras: string[]): number | null {
  let total = 0
  let grupo = 0
  let vistas = 0
  for (const palabra of palabras) {
    if (palabra === "y") continue
    vistas++
    if (palabra === "mil") grupo = (grupo || 1) * 1000
    else if (palabra === "millon" || palabra === "millones") {
      total += (grupo || 1) * 1_000_000
      grupo = 0
    } else {
      const valor = UNIDADES[palabra]
      if (valor === undefined) return null
      grupo += valor
    }
  }
  return vistas > 0 ? total + grupo : null
}

/** La racha más larga de palabras numéricas de un texto, por ejemplo el valor en letras de una cláusula. */
function valorEnLetras(texto: string): number | null {
  const palabras = normalizar(texto).replace(/[^a-z ]/g, " ").split(" ").filter(Boolean)
  let mejor: string[] = []
  let actual: string[] = []
  for (const palabra of palabras) {
    if (esPalabraNumero(palabra) && !(actual.length === 0 && palabra === "y")) actual.push(palabra)
    else {
      if (actual.length > mejor.length) mejor = actual
      actual = []
    }
  }
  if (actual.length > mejor.length) mejor = actual
  while (mejor.at(-1) === "y") mejor = mejor.slice(0, -1)
  return mejor.length > 0 ? numeroEnLetras(mejor) : null
}

/** «265.000.000» (miles con punto) o «120,000.00» (miles con coma y decimales con punto). */
function leerCifra(texto: string): number | null {
  const limpio = texto.replace(/[^\d.,]/g, "")
  if (!/\d/.test(limpio)) return null
  const ultimoPunto = limpio.lastIndexOf(".")
  const ultimaComa = limpio.lastIndexOf(",")
  const decimal = ultimoPunto >= 0 && ultimaComa >= 0 ? Math.max(ultimoPunto, ultimaComa) : -1
  const separadorUnico = decimal < 0 ? (ultimoPunto >= 0 ? "." : ultimaComa >= 0 ? "," : "") : ""
  let entero = limpio
  let fraccion = ""
  if (decimal >= 0) {
    entero = limpio.slice(0, decimal)
    fraccion = limpio.slice(decimal + 1)
  } else if (separadorUnico) {
    const partes = limpio.split(separadorUnico)
    // Grupos de tres dígitos: es separador de miles. Si no, es la coma o el punto decimal.
    if (!partes.slice(1).every((parte) => parte.length === 3)) {
      fraccion = partes.pop() ?? ""
      entero = partes.join("")
    }
  }
  const numero = Number(`${entero.replace(/[.,]/g, "")}${fraccion ? `.${fraccion}` : ""}`)
  return Number.isFinite(numero) ? numero : null
}

// ─── Lectura del documento ───────────────────────────────────────────────────

const ORDINALES = "PRIMERA|SEGUNDA|TERCERA|CUARTA|QUINTA|SEXTA|S[ÉE]PTIMA|OCTAVA|NOVENA|D[ÉE]CIMA"
type Clausula = { titulo: string; texto: string }

/** Cláusulas «PRIMERA. OBJETO. …» o «CLÁUSULA PRIMERA - OBJETO: …»; las de un otrosí no tienen título y quedan con título vacío. */
function clausulas(texto: string): Clausula[] {
  const patron = new RegExp(`^(?:CL[ÁA]USULA\\s+)?(?:${ORDINALES})\\s*[.:\\-–]\\s*(?:([A-ZÁÉÍÓÚÑ ]{3,40}?)\\s*[.:\\-–]\\s*)?(.+)$`, "u")
  return texto
    .split(/\n\s*\n/)
    .map((parrafo) => parrafo.replace(/\s+/g, " ").trim().match(patron))
    .filter((coincidencia) => coincidencia !== null)
    .map((coincidencia) => ({ titulo: normalizar(coincidencia[1] ?? ""), texto: coincidencia[2] ?? "" }))
}

function clausula(lista: Clausula[], titulo: RegExp): Clausula | null {
  return lista.find((candidata) => titulo.test(candidata.titulo)) ?? null
}

/** En un otrosí, el texto nuevo de la cláusula que modifica: «Modificar la cláusula TERCERA (PLAZO), la cual quedará así: "…"». */
function modificacionDe(lista: Clausula[], nombre: RegExp): string | null {
  for (const { texto } of lista) {
    const coincidencia = texto.match(/modificar la cl[aá]usula [^(]*\(([^)]+)\)[^"“]*["“]([^"”]+)["”]/i)
    if (coincidencia && nombre.test(normalizar(coincidencia[1] ?? ""))) return coincidencia[2] ?? null
  }
  return null
}

function tipoDeDocumento(texto: string): TipoDocumento | null {
  const titulo = normalizar(texto.split("\n").find((linea) => linea.trim()) ?? "")
  if (/^(otrosi|modificacion|adicion|prorroga|enmienda)\b/.test(titulo)) return "otrosi"
  if (titulo.startsWith("contrato marco")) return "contrato_marco"
  if (titulo.startsWith("contrato")) return "contrato"
  return null
}

type Parte = { nombre: string; tipo: string; numero: string; indice: number }

/**
 * Partes del encabezado: «INDUSTRIAS DELTA S.A.S., identificada con NIT 890.900.111-4». Acepta «NIT.»,
 * «N.I.T.», «RUC No.» y razones sociales con minúsculas; quita el «Entre» que puede quedar pegado.
 */
function partesDe(texto: string): Parte[] {
  // Sin la bandera «i»: el nombre debe empezar en mayúscula; la sigla acepta «NIT», «Nit» o «N.I.T.».
  const patron = /([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ0-9 .&-]+?),\s+(?:identificad[ao]s? con\s+(?:el\s+)?)?([Nn]\.?[Ii]\.?[Tt]\.?|[Rr]\.?[Uu]\.?[Cc]\.?|[Rr]\.?[Tt]\.?[Nn]\.?)\s*(?:No\.?\s*)?(\d[\d.\- ]*\d)/g
  return [...texto.replace(/,\s+(?:sociedad|empresa|entidad|persona jur[ií]dica)\s+(?=identificad)/g, ", ").matchAll(patron)].map((coincidencia) => ({
    nombre: (coincidencia[1] ?? "").trim().replace(/^(?:entre(?: los suscritos)?|y)\s+/i, ""),
    tipo: (coincidencia[2] ?? "").replace(/\./g, "").toUpperCase(),
    numero: (coincidencia[3] ?? "").trim(),
    indice: coincidencia.index ?? 0,
  }))
}

/** NIT sin puntos ni dígito de verificación; RUC de Panamá («155612345-2-2021»), solo el primer tramo; el resto, solo los dígitos. */
function limpiarIdentificador(tipo: string, numero: string): string {
  if (tipo === "NIT" || (tipo === "RUC" && /\d-\d+-\d/.test(numero))) return (numero.split("-")[0] ?? numero).replace(/\D/g, "")
  return numero.replace(/\D/g, "")
}

function esPeriferia(parte: Parte): boolean {
  return limpiarIdentificador(parte.tipo, parte.numero) === NIT_PERIFERIA || normalizar(parte.nombre).includes("periferia")
}

/** El nombre con mayúsculas y minúsculas tal como aparece en el bloque de firmas, si aparece. */
function nombreEnFirmas(texto: string, nombre: string): string | null {
  const buscado = normalizar(nombre)
  for (const linea of texto.split("\n")) {
    for (const celda of linea.split(/\s{2,}/)) {
      const limpia = celda.trim()
      if (limpia && limpia !== limpia.toUpperCase() && normalizar(limpia) === buscado) return limpia
    }
  }
  return null
}

const SUFIJOS_SOCIEDAD = /\b(s\.?a\.?s|s\.?a\.?c|s\.?a|ltda|s\.? de r\.?l|s\.?r\.?l|e\.?u)\.?$/i

function tipoTitulo(nombre: string): string {
  return nombre
    .toLowerCase()
    .split(" ")
    .map((palabra, indice) =>
      indice > 0 && ["de", "del", "la", "las", "los", "y"].includes(palabra) ? palabra : palabra.charAt(0).toUpperCase() + palabra.slice(1),
    )
    .join(" ")
    .replace(SUFIJOS_SOCIEDAD, (sufijo) => sufijo.toUpperCase())
}

const PAISES_POR_NOMBRE: Record<string, Pais> = { colombia: "CO", ecuador: "EC", peru: "PE", panama: "PA", honduras: "HN" }
/** Ciudades principales, para cuando el domicilio no dice el país. */
const PAISES_POR_CIUDAD: Record<string, Pais> = {
  bogota: "CO",
  medellin: "CO",
  cali: "CO",
  barranquilla: "CO",
  cartagena: "CO",
  bucaramanga: "CO",
  quito: "EC",
  guayaquil: "EC",
  lima: "PE",
  arequipa: "PE",
  tegucigalpa: "HN",
  "san pedro sula": "HN",
}

/** País por la forma del identificador tributario: NIT colombiano, RUC de 13 (Ecuador) u 11 dígitos (Perú), RTN de 14 (Honduras). */
function paisPorIdentificador(tipo: string, numero: string): Pais | null {
  const digitos = numero.replace(/\D/g, "")
  if (tipo === "NIT") return "CO"
  if (tipo === "RTN") return "HN"
  if (tipo === "RUC" && digitos.length === 13 && digitos.endsWith("001")) return "EC"
  if (tipo === "RUC" && digitos.length === 11 && /^(10|15|17|20)/.test(digitos)) return "PE"
  if (tipo === "RUC" && /-/.test(numero)) return "PA"
  return null
}

function paisPorDomicilio(texto: string, desde: number): Pais | null {
  const tramo = normalizar(texto.slice(desde, desde + 260))
  const domicilio = tramo.match(/domicilio en ([^,]+)(?:, ([a-z]+))?/)
  const pais = PAISES_POR_NOMBRE[domicilio?.[2] ?? ""]
  if (pais) return pais
  const ciudad = (domicilio?.[1] ?? "").replace(/\bd\.?c\.?$/, "").trim()
  return PAISES_POR_CIUDAD[ciudad] ?? PAISES_POR_NOMBRE[ciudad] ?? null
}

const CODIGOS_MONEDA: Record<string, Moneda> = { cop: "COP", usd: "USD", "us$": "USD", pen: "PEN", pab: "PAB", hnl: "HNL" }
const MONEDA_EN_LETRAS: [RegExp, Moneda | "PESOS"][] = [
  [/dolar/, "USD"],
  [/\bsoles?\b/, "PEN"],
  [/balboa/, "PAB"],
  [/lempira/, "HNL"],
  [/\bpesos?\b/, "PESOS"],
]
const MONEDA_DEL_PAIS: Record<Pais, Moneda> = { CO: "COP", EC: "USD", PE: "PEN", PA: "PAB", HN: "HNL" }

// ─── Extracción de cada campo ────────────────────────────────────────────────

function vacio<T>(nota?: string): Campo<T> {
  return { valor: null, confianza: 0, evidencia: null, ...(nota ? { nota } : {}) }
}

function campo<T>(valor: T, confianza: number, evidencia: string | null, nota?: string): Campo<T> {
  return { valor, confianza: redondear(confianza), evidencia: evidencia ? recortar(evidencia) : null, ...(nota ? { nota } : {}) }
}

function extraerId(texto: string, tipo: TipoDocumento, correo: Correo): Campo<string> {
  const titulo = texto.split("\n").find((linea) => linea.trim()) ?? ""
  const numeros = [...titulo.matchAll(/(?:No\.?|N[°º]\.?|Nro\.?|N[uú]mero)\s*([A-Z0-9](?:[A-Z0-9-]| (?=\d))*[A-Z0-9])/gi)].map((coincidencia) =>
    (coincidencia[1] ?? "").toUpperCase().replace(/ /g, "-"),
  )
  // En un otrosí el primer número es el del otrosí y el segundo el del contrato que modifica.
  const id = tipo === "otrosi" ? (numeros.find((numero) => /[A-Z]/.test(numero)) ?? null) : (numeros[0] ?? null)
  if (!id) return vacio("el documento no trae número de contrato; al registrarlo se asigna AUTO-<año>-<secuencia>")
  const enAsunto = correo.asunto.toUpperCase().includes(id)
  return campo(id, enAsunto ? 0.99 : 0.95, titulo)
}

type Contraparte = { cliente: Campo<string>; nit: Campo<string>; pais: Campo<Pais> }

function extraerContraparte(texto: string): Contraparte {
  const parte = partesDe(texto).find((candidata) => !esPeriferia(candidata))
  if (!parte) {
    const nota = "no se encontró la contraparte (razón social con NIT, RUC o RTN) en el encabezado"
    return { cliente: vacio(nota), nit: vacio(nota), pais: vacio(nota) }
  }
  const evidencia = `${parte.nombre}, ${parte.tipo} ${parte.numero}`
  const rol = normalizar(texto.slice(parte.indice, parte.indice + 400)).match(/el (contratante|contratista)/)?.[1]
  const enFirmas = nombreEnFirmas(texto, parte.nombre)
  let cliente = campo(enFirmas ?? tipoTitulo(parte.nombre), rol === "contratante" ? (enFirmas ? 0.97 : 0.9) : 0.82, evidencia)
  let nit = campo(limpiarIdentificador(parte.tipo, parte.numero), 0.97, evidencia)
  if (rol === "contratista") {
    const nota = "Periferia figura como CONTRATANTE: la contraparte es un proveedor, no un cliente; confirmar si este contrato va en el maestro"
    cliente = campo(cliente.valor ?? "", 0.3, evidencia, nota)
  }
  // Un consorcio o una unión temporal es el cliente; si no trae NIT propio, se propone el de su primera integrante.
  const consorcio = texto.slice(0, parte.indice).match(/(CONSORCIO|UNI[ÓO]N TEMPORAL)\s+([^,]+),\s+(?:integrad|conformad)[oa]s?\s+por/i)
  if (consorcio) {
    const nombre = `${consorcio[1]} ${consorcio[2]}`.trim()
    cliente = campo(nombreEnFirmas(texto, nombre) ?? tipoTitulo(nombre), 0.75, consorcio[0], "consorcio o unión temporal: se registra el consorcio como cliente; confirmar")
    nit = campo(nit.valor ?? "", 0.5, evidencia, "el consorcio no trae NIT propio; se propone el de su primera integrante, confirmar")
  }
  const porIdentificador = paisPorIdentificador(parte.tipo, parte.numero)
  const porDomicilio = paisPorDomicilio(texto, parte.indice)
  let pais: Campo<Pais>
  if (porIdentificador && porDomicilio && porIdentificador !== porDomicilio) {
    pais = campo(porIdentificador, 0.5, evidencia, `el ${parte.tipo} apunta a ${porIdentificador} y el domicilio a ${porDomicilio}`)
  } else if (porIdentificador) {
    pais = campo(porIdentificador, porDomicilio ? 0.98 : 0.9, evidencia)
  } else if (porDomicilio) {
    pais = campo(porDomicilio, 0.75, evidencia, "inferido solo del domicilio")
  } else {
    pais = vacio(`no se pudo inferir el país del ${parte.tipo} ni del domicilio`)
  }
  return { cliente, nit, pais }
}

/** Quita la fórmula «EL CONTRATISTA se obliga a…» para que el objeto quede como en el maestro. */
function limpiarObjeto(texto: string): string {
  const sinFormula = texto
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^el contratista\s+(?:se obliga a|se compromete a|prestar[áa])\s+/i, "")
  return sinFormula.charAt(0).toUpperCase() + sinFormula.slice(1)
}

function extraerObjeto(lista: Clausula[]): Campo<string> {
  const objeto = clausula(lista, /^objeto$/)
  if (!objeto) return vacio("no hay cláusula de objeto")
  const texto = limpiarObjeto(objeto.texto)
  if (texto.length <= MAX_OBJETO) return campo(texto, 0.92, texto)
  const corte = texto.slice(0, MAX_OBJETO - 1).replace(/\s+\S*$/, "")
  return campo(`${corte}…`, 0.88, texto, `recortado a ${MAX_OBJETO} caracteres`)
}

type Valor = { valor: Campo<number>; indeterminado: Campo<boolean>; moneda: Campo<Moneda> }

/** La cifra entre paréntesis («(COP $265.000.000)») o, si no hay, la primera con código o signo de pesos («$ 1.250.000.000»). */
function monedaEnCifra(texto: string): { moneda: Moneda | null; cifra: number | null; evidencia: string; signo: boolean } | null {
  const entreParentesis = texto.match(/\(\s*(COP|USD|US\$|PEN|PAB|HNL)?\s*(\$)?\s*(\d[\d.,]*)\s*\)/i)
  const suelta = texto.match(/(COP|USD|US\$|PEN|PAB|HNL)?\s*(\$)?\s*(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?)/i)
  const coincidencia = entreParentesis ?? (suelta && (suelta[1] || suelta[2]) ? suelta : null)
  if (!coincidencia) return null
  const moneda = CODIGOS_MONEDA[(coincidencia[1] ?? "").toLowerCase()] ?? null
  return { moneda, cifra: leerCifra(coincidencia[3] ?? ""), evidencia: coincidencia[0], signo: !coincidencia[1] && Boolean(coincidencia[2]) }
}

/** Un valor por mes no es el valor total del contrato. */
const VALOR_PERIODICO = /valor mensual|mensualmente la suma|por mes\b|cada mes|mensualidades?/
const NOTA_PERIODICO = "es un valor mensual, no el total"

/** Un valor que es un tope o se liquida por consumo no es el valor fijo del contrato. */
const VALOR_VARIABLE = /hasta (?:un|por un)?\s*(?:tope|monto|valor)|tope (?:maximo )?de|bolsa de horas|se liquidara|segun (?:las )?(?:horas|tarifas|consumo)|por consumo/

function monedaEnLetras(texto: string, pais: Pais | null): Moneda | null {
  const normal = normalizar(texto)
  for (const [patron, moneda] of MONEDA_EN_LETRAS) {
    if (patron.test(normal)) return moneda === "PESOS" ? (pais === "CO" || pais === null ? "COP" : null) : moneda
  }
  return null
}

/** Moneda que aparece en cualquier otra parte del documento (por ejemplo, en la cláusula de garantías). */
function monedaEnDocumento(texto: string): { moneda: Moneda; evidencia: string } | null {
  const coincidencia = texto.match(/\b(COP|USD|PEN|PAB|HNL)\s*\$?\s*[\d]/)
  const moneda = coincidencia ? CODIGOS_MONEDA[(coincidencia[1] ?? "").toLowerCase()] : undefined
  return coincidencia && moneda ? { moneda, evidencia: coincidencia[0] } : null
}

function extraerValor(textoValor: string | null, documento: string, pais: Pais | null): Valor {
  if (!textoValor) {
    const nota = "no hay cláusula de valor"
    return { valor: vacio(nota), indeterminado: vacio(nota), moneda: vacio(nota) }
  }
  const texto = textoValor.replace(/\s+/g, " ").trim()
  if (/no tiene (?:un )?valor determinado|valor indeterminado|por demanda|sin valor determinado/i.test(normalizar(texto))) {
    const otra = monedaEnDocumento(documento)
    const moneda = otra
      ? campo(otra.moneda, pais && MONEDA_DEL_PAIS[pais] === otra.moneda ? 0.85 : 0.7, otra.evidencia, "la cláusula de valor no la dice; sale de otra cláusula")
      : pais
        ? campo(MONEDA_DEL_PAIS[pais], 0.6, null, "la cláusula de valor no la dice; se asume la del país del cliente")
        : vacio<Moneda>("la cláusula de valor no dice la moneda")
    return {
      valor: campo(0, 0.6, texto, "contrato por demanda o marco: el maestro registra 0 (valor_indeterminado = true); confirmar"),
      indeterminado: campo(true, 0.9, texto),
      moneda,
    }
  }
  const cifra = monedaEnCifra(texto)
  const letras = valorEnLetras(texto.split("(")[0] ?? texto)
  const monedaLetras = monedaEnLetras(texto.split("(")[0] ?? texto, pais)
  let valor: Campo<number>
  if (cifra?.cifra !== null && cifra?.cifra !== undefined && letras !== null) {
    if (cifra.cifra === letras) valor = campo(cifra.cifra, 0.98, texto)
    else if (Math.trunc(cifra.cifra) === letras) valor = campo(cifra.cifra, 0.9, texto, "los centavos solo están en la cifra")
    else valor = campo(cifra.cifra, 0.4, texto, `la cifra (${cifra.cifra}) no coincide con el valor en letras (${letras})`)
  } else if (cifra?.cifra !== null && cifra?.cifra !== undefined) {
    valor = campo(cifra.cifra, 0.85, texto, "solo en cifras, sin el valor en letras para comprobarlo")
  } else if (letras !== null) {
    valor = campo(letras, 0.8, texto, "solo en letras")
  } else {
    valor = vacio("la cláusula de valor no trae un monto legible")
  }
  if (valor.valor !== null && VALOR_PERIODICO.test(normalizar(texto))) {
    valor = campo(valor.valor, 0.5, texto, NOTA_PERIODICO)
  } else if (valor.valor !== null && VALOR_VARIABLE.test(normalizar(texto))) {
    valor = campo(valor.valor, Math.min(valor.confianza, 0.6), texto, "es un tope o un valor por consumo, no un valor fijo; confirmar si se registra el tope o 0 (indeterminado)")
  }
  let moneda: Campo<Moneda>
  const soloSigno = Boolean(cifra?.signo) && !cifra?.moneda && !monedaLetras && (pais === "CO" || pais === null)
  const codigo = cifra?.moneda ?? (soloSigno ? "COP" : null)
  if (codigo && monedaLetras && codigo !== monedaLetras) moneda = campo(codigo, 0.4, texto, `el código dice ${codigo} y las letras ${monedaLetras}`)
  else if (codigo && soloSigno) moneda = campo(codigo, 0.8, texto, "solo el signo $, sin código; en Colombia son pesos")
  else if (codigo) moneda = campo(codigo, monedaLetras ? 0.98 : 0.9, texto)
  else if (monedaLetras) moneda = campo(monedaLetras, 0.8, texto, "solo por el nombre de la moneda en letras")
  else moneda = vacio("no se encontró la moneda")
  return { valor, indeterminado: campo(false, valor.valor === null ? 0 : 0.95, texto), moneda }
}

type Plazo = { inicio: Campo<string>; fin: Campo<string> }

/** Fecha de firma: «a los treinta (30) días del mes de julio de 2026» o, sin día, «en el mes de agosto de 2026». */
function fechaDeFirma(texto: string): { fecha: string; exacta: boolean; evidencia: string } | null {
  const tramo = texto.slice(Math.max(0, normalizar(texto).search(/se firma/)))
  const exacta = fechasEn(tramo)[0]
  if (exacta && /se firma/i.test(normalizar(tramo))) return { fecha: exacta.fecha, exacta: true, evidencia: exacta.texto }
  const soloMes = tramo.match(new RegExp(`mes de (${PATRON_MES}) de (\\d{4})`, "i"))
  const mes = soloMes ? MESES[normalizar(soloMes[1] ?? "")] : undefined
  if (!soloMes || !mes) return null
  return { fecha: iso(Number(soloMes[2]), mes, 1), exacta: false, evidencia: soloMes[0] }
}

/** Una fecha de inicio que no es anterior a la final indica que se leyó mal alguna de las dos. */
function coherente(plazo: Plazo): Plazo {
  const { inicio, fin } = plazo
  if (!inicio.valor || !fin.valor || inicio.valor < fin.valor) return plazo
  const nota = `la fecha de inicio (${inicio.valor}) no es anterior a la final (${fin.valor}); revisar el plazo`
  return { inicio: { ...inicio, confianza: 0.3, nota }, fin: { ...fin, confianza: 0.3, nota } }
}

function extraerPlazo(textoPlazo: string | null, documento: string): Plazo {
  return coherente(leerPlazo(textoPlazo, documento))
}

function leerPlazo(textoPlazo: string | null, documento: string): Plazo {
  if (!textoPlazo) return { inicio: vacio("no hay cláusula de plazo"), fin: vacio("no hay cláusula de plazo") }
  const texto = textoPlazo.replace(/\s+/g, " ").trim()
  const desde = fechaDespuesDe(texto, /\bdesde\b|a partir del?\b|contad[oa]s? del?\b/i)
  const hasta = fechaDespuesDe(texto, /\bhasta\b/i)
  const meses = Number(texto.match(/\((\d{1,3})\)\s+meses|\b(\d{1,3})\s+meses/i)?.slice(1).find(Boolean) ?? Number.NaN)
  const prorroga = /prorrogab/i.test(texto) ? "; se prorroga automáticamente" : ""

  if (desde && hasta) {
    if (Number.isFinite(meses)) {
      const cuadra = finDePlazo(desde.fecha, meses) === hasta.fecha
      const nota = cuadra ? undefined : `las fechas no cuadran con el plazo de ${meses} meses`
      return { inicio: campo(desde.fecha, cuadra ? 0.98 : 0.7, texto, nota), fin: campo(hasta.fecha, cuadra ? 0.98 : 0.7, texto, nota) }
    }
    return { inicio: campo(desde.fecha, 0.93, texto), fin: campo(hasta.fecha, 0.93, texto) }
  }
  if (hasta && !desde) return { inicio: vacio("el texto solo trae la fecha final"), fin: campo(hasta.fecha, 0.95, texto) }
  if (Number.isFinite(meses) && /firma/i.test(texto)) {
    const firma = fechaDeFirma(documento)
    if (!firma) return { inicio: vacio("el plazo corre desde la firma y la fecha de firma no aparece"), fin: vacio("depende de la fecha de firma, que no aparece") }
    const fin = finDePlazo(firma.fecha, meses)
    if (firma.exacta) {
      return { inicio: campo(firma.fecha, 0.85, firma.evidencia, "es la fecha de firma"), fin: campo(fin, 0.85, texto, `${meses} meses desde la firma${prorroga}`) }
    }
    const nota = "la firma solo dice el mes, sin el día; se propone el primer día del mes (el vencimiento más temprano posible)"
    return {
      inicio: campo(firma.fecha, 0.4, firma.evidencia, nota),
      fin: campo(fin, 0.4, texto, `${meses} meses desde una firma sin día${prorroga}; confirmar`),
    }
  }
  if (desde && Number.isFinite(meses)) {
    return { inicio: campo(desde.fecha, 0.9, texto), fin: campo(finDePlazo(desde.fecha, meses), 0.85, texto, `${meses} meses desde el inicio${prorroga}`) }
  }
  if (desde) return { inicio: campo(desde.fecha, 0.9, texto), fin: vacio("no se encontró la fecha final") }
  return { inicio: vacio("no se encontraron fechas en la cláusula de plazo"), fin: vacio("no se encontraron fechas en la cláusula de plazo") }
}

const TIPOS_POLIZA: [RegExp, string][] = [
  [/cumplimiento/, "cumplimiento"],
  [/calidad/, "calidad"],
  [/responsabilidad civil/, "responsabilidad_civil"],
  [/salarios|prestaciones sociales/, "salarios_prestaciones"],
  [/anticipo/, "anticipo"],
  [/estabilidad/, "estabilidad"],
]

type Poliza = { requiere: Campo<boolean>; tipos: Campo<string> }

function tiposDePoliza(texto: string): string[] {
  const normal = normalizar(texto)
  return TIPOS_POLIZA.filter(([patron]) => patron.test(normal)).map(([, tipo]) => tipo)
}

/** Lo que dice el comercial en el correo: «requiere póliza» o «no pide póliza». */
function polizaSegunCorreo(cuerpo: string): boolean | null {
  const normal = normalizar(cuerpo)
  if (/no (pide|requiere|lleva|necesita) poliza|sin poliza/.test(normal)) return false
  if (/(requiere|pide|lleva|necesita) poliza/.test(normal)) return true
  return null
}

function extraerPoliza(lista: Clausula[], documento: string, correo: Correo): Poliza {
  const garantias = clausula(lista, /garant|poliza|seguro/)
  const texto = garantias?.texto ?? (normalizar(documento).includes("poliza") ? documento : null)
  const segunCorreo = polizaSegunCorreo(correo.cuerpo)
  if (!texto) {
    if (segunCorreo === true) return { requiere: campo(true, 0.5, correo.cuerpo, "el correo dice que requiere póliza pero el contrato no la menciona"), tipos: vacio() }
    return { requiere: campo(false, segunCorreo === false ? 0.95 : 0.85, null, "el contrato no menciona pólizas ni garantías"), tipos: campo("", 0.9, null) }
  }
  const negada = /\bno (?:se )?(?:exigir|requerir|requiere|exige|debera constituir|habra lugar)|\bsin (?:garantias|polizas?)\b|\bexento de (?:garantias|polizas?)/
  if (negada.test(normalizar(texto))) {
    return { requiere: campo(false, segunCorreo === true ? 0.5 : 0.9, texto, "el contrato dice expresamente que no exige pólizas"), tipos: campo("", 0.9, texto) }
  }
  const tipos = tiposDePoliza(texto)
  const condicional = /para cada orden|cuyo valor supere|en caso de que|si el valor/i.test(texto)
  if (condicional) {
    return {
      requiere: campo(true, 0.6, texto, "la póliza es condicional: solo se exige en las órdenes que cumplan la condición; confirmar si se registra"),
      tipos: campo(tipos.join(";"), 0.85, texto),
    }
  }
  const confianza = segunCorreo === false ? 0.5 : segunCorreo === true ? 0.99 : 0.95
  const nota = segunCorreo === false ? "el correo dice que no pide póliza pero el contrato sí la exige" : undefined
  return { requiere: campo(true, confianza, texto, nota), tipos: campo(tipos.join(";"), tipos.length > 0 ? 0.95 : 0.5, texto) }
}

function resolverRemitente(correo: Correo, comerciales: Comercial[]): Remitente {
  const conocido = comerciales.find((comercial) => normalizar(comercial.email) === normalizar(correo.de))
  return { email: correo.de, nombre: conocido?.nombre ?? null, registrado: conocido !== undefined }
}

/** Meses completos entre el inicio y el día siguiente al fin (1 de agosto a 31 de julio son 12). */
function mesesDelPlazo(inicio: string, fin: string): number | null {
  for (let meses = 1; meses <= 120; meses++) if (finDePlazo(inicio, meses) === fin) return meses
  return null
}

/** Con un valor mensual y el plazo, se propone el total (mensual × meses); sigue en revisión. */
function totalDeValorMensual(valor: Valor, plazo: Plazo): Partial<Campos> {
  if (valor.valor.nota !== NOTA_PERIODICO || valor.valor.valor === null || !plazo.inicio.valor || !plazo.fin.valor) return {}
  const meses = mesesDelPlazo(plazo.inicio.valor, plazo.fin.valor)
  if (meses === null) return {}
  const mensual = valor.valor.valor
  const nota = `${NOTA_PERIODICO}: se propone ${mensual} × ${meses} meses del plazo = ${mensual * meses}; confirmar`
  return { valor: campo(mensual * meses, 0.6, valor.valor.evidencia, nota) }
}

/** Extracción de un contrato o contrato marco completo. */
function extraerContrato(texto: string, tipo: TipoDocumento, correo: Correo): Campos {
  const lista = clausulas(texto)
  const contraparte = extraerContraparte(texto)
  const valor = extraerValor(clausula(lista, /^valor/)?.texto ?? null, texto, contraparte.pais.valor)
  const plazo = extraerPlazo(clausula(lista, /^plazo|duracion|vigencia/)?.texto ?? null, texto)
  const poliza = extraerPoliza(lista, texto, correo)
  return {
    id_contrato: extraerId(texto, tipo, correo),
    cliente: contraparte.cliente,
    nit_cliente: contraparte.nit,
    pais: contraparte.pais,
    objeto: extraerObjeto(lista),
    valor: valor.valor,
    valor_indeterminado: valor.indeterminado,
    moneda: valor.moneda,
    fecha_inicio: plazo.inicio,
    fecha_fin: plazo.fin,
    requiere_poliza: poliza.requiere,
    tipo_poliza: poliza.tipos,
    ...totalDeValorMensual(valor, plazo),
  }
}

const NO_MODIFICA = "el otrosí no modifica este campo; se conserva el del maestro"

/** Un otrosí solo trae la identificación y lo que cambia; el resto se conserva del maestro. */
function extraerOtrosi(texto: string, correo: Correo): { campos: Campos; otrosi: NonNullable<Extraccion["otrosi"]> } {
  const lista = clausulas(texto)
  const contraparte = extraerContraparte(texto)
  const nuevoValor = modificacionDe(lista, /valor/)
  const nuevoPlazo = modificacionDe(lista, /plazo/)
  const valor = nuevoValor ? extraerValor(nuevoValor, texto, contraparte.pais.valor) : null
  const plazo = nuevoPlazo ? extraerPlazo(nuevoPlazo, texto) : null
  const modifica: NombreCampo[] = []
  if (valor?.valor.valor !== null && valor) modifica.push("valor", "moneda")
  if (plazo?.inicio.valor) modifica.push("fecha_inicio")
  if (plazo?.fin.valor) modifica.push("fecha_fin")
  const normal = normalizar(texto)
  const ampliaPolizas = /(garantias|polizas?)[^.]*ampliar/.test(normal) && modifica.length > 0
  const adiciona = /adicion(?:ar|a)?\s+(?:el valor|en|la suma)/.test(normal)
  const tipos = tiposDePoliza(texto.match(/garant[ií]as[^.]*\./i)?.[0] ?? "")
  const numero = texto.split("\n")[0]?.match(/(?:OTROS[IÍ]|MODIFICACI[ÓO]N|ADICI[ÓO]N|PR[ÓO]RROGA|ENMIENDA)\s+(?:No\.?|N[°º]\.?|Nro\.?)\s*(\d+)/i)?.[1] ?? null
  return {
    otrosi: { numero, modifica, amplia_polizas: ampliaPolizas, adiciona_valor: adiciona },
    campos: {
      id_contrato: extraerId(texto, "otrosi", correo),
      cliente: contraparte.cliente,
      nit_cliente: contraparte.nit,
      pais: contraparte.pais,
      objeto: vacio(NO_MODIFICA),
      valor: valor?.valor ?? vacio(NO_MODIFICA),
      valor_indeterminado: valor?.indeterminado ?? vacio(NO_MODIFICA),
      moneda: valor?.moneda ?? vacio(NO_MODIFICA),
      fecha_inicio: plazo?.inicio.valor ? plazo.inicio : vacio(NO_MODIFICA),
      fecha_fin: plazo?.fin.valor ? plazo.fin : vacio(NO_MODIFICA),
      requiere_poliza: ampliaPolizas ? campo(true, 0.95, texto.match(/[^.]*garant[ií]as[^.]*\./i)?.[0] ?? null) : vacio(NO_MODIFICA),
      tipo_poliza: tipos.length > 0 ? campo(tipos.join(";"), 0.9, null) : vacio(NO_MODIFICA),
    },
  }
}

function valoresDe(campos: Campos): Valores {
  return {
    id_contrato: campos.id_contrato.valor,
    cliente: campos.cliente.valor,
    nit_cliente: campos.nit_cliente.valor,
    pais: campos.pais.valor,
    objeto: campos.objeto.valor,
    valor: campos.valor.valor,
    valor_indeterminado: campos.valor_indeterminado.valor,
    moneda: campos.moneda.valor,
    fecha_inicio: campos.fecha_inicio.valor,
    fecha_fin: campos.fecha_fin.valor,
    requiere_poliza: campos.requiere_poliza.valor,
    tipo_poliza: campos.tipo_poliza.valor,
  }
}

/** Campos que cuentan para la revisión: en un otrosí, solo la identificación y lo que modifica. */
function camposRelevantes(extraccion: Extraccion): NombreCampo[] {
  const todos = Object.keys(extraccion.campos) as NombreCampo[]
  if (!extraccion.otrosi) return todos.filter((nombre) => nombre !== "id_contrato" || extraccion.campos.id_contrato.valor !== null)
  const base: NombreCampo[] = ["id_contrato", "cliente", "nit_cliente", "pais"]
  const poliza: NombreCampo[] = extraccion.otrosi.amplia_polizas ? ["requiere_poliza"] : []
  return [...base, ...extraccion.otrosi.modifica, ...poliza]
}

function bajaConfianza(extraccion: Extraccion): NombreCampo[] {
  return camposRelevantes(extraccion).filter((nombre) => extraccion.campos[nombre].confianza < UMBRAL_CONFIANZA)
}

// ─── Archivos ────────────────────────────────────────────────────────────────

function rutaFixtures(ctx: Contexto, ...partes: string[]): string {
  return path.join(ctx.directory, "fixtures", "reto-02", ...partes)
}

function rutaSalida(ctx: Contexto, ...partes: string[]): string {
  return path.join(ctx.directory, "out", ...partes)
}

function relativa(ctx: Contexto, ruta: string): string {
  return path.relative(ctx.directory, ruta).split(path.sep).join("/")
}

async function leerJson<T>(ruta: string, esquema: z.ZodType<T>, nombre: string): Promise<Resultado<T>> {
  let texto: string
  try {
    texto = await readFile(ruta, "utf8")
  } catch {
    return fallo(`No se encontró ${nombre}.`)
  }
  let json: unknown
  try {
    json = JSON.parse(texto)
  } catch {
    return fallo(`${nombre} no es un JSON válido.`)
  }
  const leido = esquema.safeParse(json, ERRORES_EN_ESPANOL)
  return leido.success ? exito(leido.data) : fallo(`${nombre} no tiene la forma esperada: ${describirProblema(leido.error)}`)
}

async function listarMensajes(ctx: Contexto): Promise<string[]> {
  try {
    const entradas = await readdir(rutaFixtures(ctx, "buzon"), { withFileTypes: true })
    return entradas.filter((entrada) => entrada.isDirectory() && ID_MENSAJE.test(entrada.name)).map((entrada) => entrada.name).sort()
  } catch {
    return []
  }
}

async function cargarCorreo(ctx: Contexto, mensaje: string): Promise<Resultado<Correo>> {
  if (!ID_MENSAJE.test(mensaje) || !(await listarMensajes(ctx)).includes(mensaje)) {
    const validos = await listarMensajes(ctx)
    return fallo(`El mensaje «${mensaje}» no existe en el buzón. Mensajes: ${validos.join(", ") || "ninguno"}.`)
  }
  return leerJson(rutaFixtures(ctx, "buzon", mensaje, "correo.json"), CorreoSchema, `el correo de ${mensaje}`)
}

function cargarComerciales(ctx: Contexto): Promise<Resultado<Comercial[]>> {
  return leerJson(rutaFixtures(ctx, "comerciales.json"), ComercialesSchema, "comerciales.json")
}

type Adjunto = { nombre: string; texto: string | null; tipo: TipoDocumento | null }

/** Los adjuntos del correo con su texto; un nombre con rutas o que no existe queda sin texto. */
async function leerAdjuntos(ctx: Contexto, correo: Correo, mensaje: string): Promise<Adjunto[]> {
  return Promise.all(
    correo.adjuntos.map(async (nombre) => {
      if (path.basename(nombre) !== nombre) return { nombre, texto: null, tipo: null }
      const texto = await readFile(rutaFixtures(ctx, "buzon", mensaje, nombre), "utf8").catch(() => null)
      return { nombre, texto, tipo: texto ? tipoDeDocumento(texto) : null }
    }),
  )
}

function adjuntoDeContrato(adjuntos: Adjunto[]): Adjunto | null {
  return adjuntos.find((adjunto) => adjunto.tipo !== null) ?? null
}

/** RN4: por qué un mensaje no trae un contrato registrable. */
function motivoDeRechazo(adjuntos: Adjunto[]): string {
  if (adjuntos.length === 0) return "el correo no trae adjuntos"
  const descripcion = adjuntos
    .map((adjunto) => {
      const titulo = adjunto.texto?.split("\n").find((linea) => linea.trim())?.trim()
      return titulo ? `${adjunto.nombre} («${recortar(titulo, 60)}»)` : `${adjunto.nombre} (no se pudo leer)`
    })
    .join(", ")
  return `ningún adjunto es un contrato ni un otrosí: ${descripcion}`
}

// ─── CSV del maestro ─────────────────────────────────────────────────────────

function leerCsv(texto: string): string[][] {
  const filas: string[][] = []
  let fila: string[] = []
  let celda = ""
  let comillas = false
  for (let i = 0; i < texto.length; i++) {
    const caracter = texto[i]
    if (comillas) {
      if (caracter === '"' && texto[i + 1] === '"') {
        celda += '"'
        i++
      } else if (caracter === '"') comillas = false
      else celda += caracter
    } else if (caracter === '"') comillas = true
    else if (caracter === ",") {
      fila.push(celda)
      celda = ""
    } else if (caracter === "\n" || caracter === "\r") {
      if (caracter === "\r" && texto[i + 1] === "\n") i++
      fila.push(celda)
      filas.push(fila)
      fila = []
      celda = ""
    } else celda += caracter
  }
  if (celda !== "" || fila.length > 0) {
    fila.push(celda)
    filas.push(fila)
  }
  return filas.filter((partes) => partes.some((parte) => parte !== ""))
}

function celdaCsv(valor: string): string {
  return /[",\n\r]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor
}

function escribirCsv(filas: Fila[]): string {
  const lineas = [COLUMNAS.join(","), ...filas.map((fila) => COLUMNAS.map((columna) => celdaCsv(fila[columna])).join(","))]
  return `${lineas.join("\n")}\n`
}

function rutaMaestro(ctx: Contexto): string {
  return rutaSalida(ctx, "sharepoint", "maestro-contratos.csv")
}

/** RN6: el fixture es de solo lectura; la primera vez se copia a out/sharepoint/ y desde ahí se trabaja. */
async function cargarMaestro(ctx: Contexto): Promise<Resultado<Fila[]>> {
  const destino = rutaMaestro(ctx)
  let texto = await readFile(destino, "utf8").catch(() => null)
  if (texto === null) {
    try {
      await mkdir(path.dirname(destino), { recursive: true })
      await copyFile(rutaFixtures(ctx, "maestro-contratos.csv"), destino)
      texto = await readFile(destino, "utf8")
    } catch {
      return fallo("No se encontró el maestro de contratos (fixtures/reto-02/maestro-contratos.csv).")
    }
  }
  const [cabecera, ...filas] = leerCsv(texto)
  if (!cabecera || COLUMNAS.some((columna, indice) => cabecera[indice] !== columna)) {
    return fallo(`El maestro no tiene las columnas esperadas: ${COLUMNAS.join(", ")}.`)
  }
  return exito(filas.map((partes) => Object.fromEntries(COLUMNAS.map((columna, indice) => [columna, partes[indice] ?? ""])) as Fila))
}

// ─── Comparación con el maestro ──────────────────────────────────────────────

const PALABRAS_VACIAS = new Set(["a", "al", "de", "del", "el", "en", "la", "las", "los", "para", "por", "y", "con", "su", "sus"])

function trigramas(texto: string): Set<string> {
  const palabras = normalizar(texto)
    .replace(/[^a-z0-9 ]/g, " ")
    .split(" ")
    .filter((palabra) => palabra && !PALABRAS_VACIAS.has(palabra))
  const conjunto = new Set<string>()
  for (const palabra of palabras) {
    const relleno = `  ${palabra} `
    for (let i = 0; i < relleno.length - 2; i++) conjunto.add(relleno.slice(i, i + 3))
  }
  return conjunto
}

/** Coeficiente de Dice sobre trigramas de caracteres: 1 es el mismo texto, 0 no comparten nada. */
function similitud(a: string, b: string): number {
  const ta = trigramas(a)
  const tb = trigramas(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let comunes = 0
  for (const trigrama of ta) if (tb.has(trigrama)) comunes++
  return redondear((2 * comunes) / (ta.size + tb.size))
}

function slug(nombre: string): string {
  return normalizar(nombre.trim().replace(/[.,]+$/, "").replace(SUFIJOS_SOCIEDAD, "").replace(/[.,]+$/, ""))
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function textoValor(valor: number): string {
  return Number.isInteger(valor) ? String(valor) : valor.toFixed(2)
}

function estadoPolizaNuevo(requiere: boolean | null): EstadoPoliza {
  return requiere ? "pendiente" : "no_aplica"
}

type Coincidencia = { fila: Fila; por: "id" | "objeto"; similitud: number | null }

/** «CT 2026 012», «ct-2026-012» y «CT-2026-012» son el mismo número. */
function mismoId(a: string, b: string): boolean {
  const limpio = (texto: string) => texto.toUpperCase().replace(/[^A-Z0-9]/g, "")
  return limpio(a) === limpio(b)
}

function buscarEnMaestro(maestro: Fila[], valores: Valores): Coincidencia | null {
  if (valores.id_contrato) {
    const id = valores.id_contrato
    const fila = maestro.find((candidata) => mismoId(candidata.id_contrato, id))
    if (fila) return { fila, por: "id", similitud: null }
  }
  if (!valores.nit_cliente || !valores.objeto) return null
  let mejor: Coincidencia | null = null
  for (const fila of maestro.filter((candidata) => candidata.nit_cliente === valores.nit_cliente)) {
    const parecido = similitud(fila.objeto, valores.objeto)
    if (parecido >= UMBRAL_SIMILITUD && (!mejor || parecido > (mejor.similitud ?? 0))) mejor = { fila, por: "objeto", similitud: parecido }
  }
  return mejor
}

/** La fila que se escribiría con estos valores; `base` es la fila existente cuando es una actualización. */
function filaCon(valores: Valores, base: Fila | null, extra: { comercial: string; ruta: string; fecha: string; estadoPoliza: EstadoPoliza | null }): Fila {
  const anterior: Fila = base ?? (Object.fromEntries(COLUMNAS.map((columna) => [columna, ""])) as Fila)
  const elegir = (columna: Columna, nuevo: string | null) => (nuevo === null ? anterior[columna] : nuevo)
  const requiere = valores.requiere_poliza
  return {
    id_contrato: base ? anterior.id_contrato : elegir("id_contrato", valores.id_contrato),
    cliente: elegir("cliente", valores.cliente),
    nit_cliente: elegir("nit_cliente", valores.nit_cliente),
    pais: elegir("pais", valores.pais),
    objeto: elegir("objeto", valores.objeto),
    valor: elegir("valor", valores.valor === null ? null : textoValor(valores.valor)),
    moneda: elegir("moneda", valores.moneda),
    fecha_inicio: elegir("fecha_inicio", valores.fecha_inicio),
    fecha_fin: elegir("fecha_fin", valores.fecha_fin),
    requiere_poliza: elegir("requiere_poliza", requiere === null ? null : String(requiere)),
    tipo_poliza: elegir("tipo_poliza", requiere === false ? "" : valores.tipo_poliza),
    estado_poliza: extra.estadoPoliza ?? (base ? anterior.estado_poliza : estadoPolizaNuevo(requiere)),
    comercial: base ? anterior.comercial || extra.comercial : extra.comercial,
    ruta_sharepoint: base?.ruta_sharepoint || extra.ruta,
    fecha_registro: base ? anterior.fecha_registro : extra.fecha,
    fuente: base ? anterior.fuente : "buzon",
  }
}

function diferenciasEntre(antes: Fila, despues: Fila, columnas: readonly Columna[]): Diferencia[] {
  return columnas
    .filter((columna) => (columna === "valor" ? Number(antes.valor) !== Number(despues.valor) : antes[columna] !== despues[columna]))
    .map((columna) => ({ campo: columna, maestro: antes[columna], documento: despues[columna] }))
}

// ─── Extracción y validación completas ───────────────────────────────────────

type Documento = { correo: Correo; adjuntos: Adjunto[]; contrato: Adjunto | null; extraccion: Extraccion | null }

async function leerDocumento(ctx: Contexto, mensaje: string): Promise<Resultado<Documento>> {
  const correo = await cargarCorreo(ctx, mensaje)
  if (!correo.ok) return correo
  const comerciales = await cargarComerciales(ctx)
  if (!comerciales.ok) return comerciales
  const adjuntos = await leerAdjuntos(ctx, correo.data, mensaje)
  const contrato = adjuntoDeContrato(adjuntos)
  if (!contrato?.texto || !contrato.tipo) return exito({ correo: correo.data, adjuntos, contrato: null, extraccion: null })
  if (!contrato.texto.trim()) return fallo(`El adjunto ${contrato.nombre} de ${mensaje} está vacío.`)
  const remitente = resolverRemitente(correo.data, comerciales.data)
  const archivo = relativa(ctx, rutaFixtures(ctx, "buzon", mensaje, contrato.nombre))
  const extraccion: Extraccion =
    contrato.tipo === "otrosi"
      ? { mensaje_id: mensaje, archivo, tipo_documento: "otrosi", remitente, ...extraerOtrosi(contrato.texto, correo.data) }
      : { mensaje_id: mensaje, archivo, tipo_documento: contrato.tipo, remitente, otrosi: null, campos: extraerContrato(contrato.texto, contrato.tipo, correo.data) }
  return exito({ correo: correo.data, adjuntos, contrato, extraccion })
}

type Corregidos = { valores: Valores; corregidos: NombreCampo[] }

/** Aplica los valores que manda el modelo: los distintos de la extracción cuentan como corrección de la analista. */
function aplicarCorrecciones(extraccion: Extraccion, enviados: z.infer<typeof ValoresSchema> | undefined): Corregidos {
  const valores = valoresDe(extraccion.campos)
  const corregidos: NombreCampo[] = []
  if (!enviados) return { valores, corregidos }
  for (const nombre of Object.keys(valores) as NombreCampo[]) {
    if (!(nombre in enviados)) continue
    const nuevo = enviados[nombre]
    if (nuevo === undefined || nuevo === valores[nombre]) continue
    // En un otrosí, mandar null en un campo que no modifica es lo mismo que no tocarlo.
    if (nuevo === null && extraccion.otrosi && !camposRelevantes(extraccion).includes(nombre)) continue
    Object.assign(valores, { [nombre]: nuevo })
    corregidos.push(nombre)
  }
  if (corregidos.includes("valor") && valores.valor !== null && valores.valor > 0 && !corregidos.includes("valor_indeterminado")) {
    valores.valor_indeterminado = false
  }
  return { valores, corregidos }
}

const OBLIGATORIOS_NUEVO: NombreCampo[] = ["cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza"]

function revisionDeCampos(extraccion: Extraccion, corregidos: Corregidos, nuevo: boolean): Revision[] {
  const revision: Revision[] = []
  const relevantes = camposRelevantes(extraccion)
  for (const nombre of relevantes) {
    const extraido = extraccion.campos[nombre]
    if (corregidos.corregidos.includes(nombre)) continue
    if (extraido.confianza < UMBRAL_CONFIANZA && extraido.valor !== null) {
      revision.push({ campo: nombre, motivo: `confianza ${extraido.confianza}${extraido.nota ? `: ${extraido.nota}` : ""}` })
    }
  }
  for (const nombre of corregidos.corregidos) {
    revision.push({ campo: nombre, motivo: `corregido en el chat (documento: ${JSON.stringify(extraccion.campos[nombre].valor)}, nuevo: ${JSON.stringify(corregidos.valores[nombre])})` })
  }
  if (nuevo) {
    for (const nombre of OBLIGATORIOS_NUEVO) {
      if (corregidos.valores[nombre] === null) revision.push({ campo: nombre, motivo: extraccion.campos[nombre].nota ?? "no se encontró en el documento" })
    }
  }
  return revision
}

function sinRepetir(revision: Revision[]): Revision[] {
  const vistos = new Map<string, Revision>()
  for (const item of revision) {
    const previo = vistos.get(item.campo)
    vistos.set(item.campo, previo ? { campo: item.campo, motivo: `${previo.motivo}; ${item.motivo}` } : item)
  }
  return [...vistos.values()]
}

function rechazo(motivo: string, remitente: Remitente | null): Validacion {
  return {
    clasificacion: "rechazado",
    motivo,
    id_contrato_existente: null,
    requiere_revision: [],
    detalle_revision: [],
    diferencias: [],
    registro: null,
    valores: null,
    comercial: remitente,
    avisos: [],
  }
}

function avisosDe(extraccion: Extraccion): string[] {
  const avisos: string[] = []
  const { remitente } = extraccion
  if (!remitente.registrado) avisos.push(`El remitente ${remitente.email} no está en comerciales.json: se registra sin comercial y hay que identificarlo (no bloquea).`)
  for (const nombre of Object.keys(extraccion.campos) as NombreCampo[]) {
    const { nota, confianza } = extraccion.campos[nombre]
    if (nota && confianza >= UMBRAL_CONFIANZA && nota !== NO_MODIFICA) avisos.push(`${nombre}: ${nota}.`)
  }
  return avisos
}

/** RN1–RN4: clasifica el documento contra el maestro y arma la fila que se escribiría. */
function clasificar(documento: Documento, maestro: Fila[], enviados: z.infer<typeof ValoresSchema> | undefined, hoy: string): Validacion {
  const { extraccion } = documento
  if (!extraccion) return rechazo(motivoDeRechazo(documento.adjuntos), null)
  const { cliente, objeto } = extraccion.campos
  if (!extraccion.otrosi && (cliente.valor === null || objeto.valor === null)) {
    return rechazo("el texto no permite identificar las partes ni el objeto del contrato", extraccion.remitente)
  }
  const corregidos = aplicarCorrecciones(extraccion, enviados)
  const { valores } = corregidos
  const coincidencia = buscarEnMaestro(maestro, valores)
  const avisos = avisosDe(extraccion)
  const comercial = extraccion.remitente.nombre ?? ""
  const extra = { comercial, ruta: "", fecha: hoy, estadoPoliza: null }

  if (!coincidencia) {
    if (extraccion.otrosi) {
      return rechazo(`es un otrosí del contrato ${valores.id_contrato ?? "(sin número)"}, que no está en el maestro; primero hay que registrar el contrato original`, extraccion.remitente)
    }
    const detalle = sinRepetir(revisionDeCampos(extraccion, corregidos, true))
    return {
      clasificacion: "nuevo",
      motivo: null,
      id_contrato_existente: null,
      requiere_revision: detalle.map((item) => item.campo),
      detalle_revision: detalle,
      diferencias: [],
      registro: filaCon(valores, null, extra),
      valores,
      comercial: extraccion.remitente,
      avisos,
    }
  }

  const { fila } = coincidencia
  const estadoPoliza = extraccion.otrosi?.amplia_polizas && fila.requiere_poliza === "true" ? "pendiente" : null
  const registro = filaCon(valores, fila, { ...extra, estadoPoliza })
  const iguales = ["valor", "fecha_inicio", "fecha_fin"].every((columna) =>
    columna === "valor" ? Number(fila.valor) === Number(registro.valor) : fila[columna as Columna] === registro[columna as Columna],
  )
  if (coincidencia.por === "id" && iguales && !extraccion.otrosi) {
    return {
      clasificacion: "duplicado",
      motivo: `el contrato ${fila.id_contrato} ya está en el maestro con el mismo valor y las mismas fechas`,
      id_contrato_existente: fila.id_contrato,
      requiere_revision: [],
      detalle_revision: [],
      diferencias: [],
      registro: null,
      valores,
      comercial: extraccion.remitente,
      avisos,
    }
  }
  const columnas: readonly Columna[] = extraccion.otrosi
    ? [...new Set([...extraccion.otrosi.modifica, "estado_poliza"] as Columna[])].filter((columna) => COLUMNAS.includes(columna))
    : (["id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza"] as const)
  const diferencias = diferenciasEntre(fila, registro, columnas)
  const revision = revisionDeCampos(extraccion, corregidos, false)
  // Sin otrosí, cada diferencia con el maestro es un conflicto que decide la analista.
  if (!extraccion.otrosi) {
    for (const diferencia of diferencias) {
      revision.push({ campo: diferencia.campo, motivo: `conflicto con el maestro: maestro «${diferencia.maestro}», documento «${diferencia.documento}»` })
    }
  }
  if (coincidencia.por === "objeto") {
    revision.push({ campo: "id_contrato", motivo: `coincide por NIT y objeto (similitud ${coincidencia.similitud}) con ${fila.id_contrato}, pero el número es otro` })
  }
  if (extraccion.otrosi && extraccion.otrosi.modifica.length === 0) {
    revision.push({ campo: "otrosi", motivo: "no se reconoció qué cláusula modifica el otrosí; revisar el documento y dar los valores nuevos" })
  }
  if (extraccion.otrosi?.adiciona_valor) {
    revision.push({ campo: "valor", motivo: `el otrosí adiciona un monto: el valor nuevo debe ser el anterior (${fila.valor} ${fila.moneda}) más la adición; confirmar el total` })
  }
  if (extraccion.otrosi && valores.moneda && valores.moneda !== fila.moneda) {
    revision.push({ campo: "moneda", motivo: `el otrosí está en ${valores.moneda} y el contrato en ${fila.moneda}` })
  }
  const detalle = sinRepetir(revision)
  if (estadoPoliza) avisos.push("El otrosí obliga a ampliar las pólizas a la nueva vigencia: la póliza queda en estado pendiente hasta que llegue la ampliación.")
  return {
    clasificacion: "actualizacion",
    motivo: extraccion.otrosi ? `otrosí No. ${extraccion.otrosi.numero ?? "?"} del contrato ${fila.id_contrato}` : `el contrato ${fila.id_contrato} ya está en el maestro con datos distintos`,
    id_contrato_existente: fila.id_contrato,
    requiere_revision: detalle.map((item) => item.campo),
    detalle_revision: detalle,
    diferencias,
    registro,
    valores,
    comercial: extraccion.remitente,
    avisos,
  }
}

// ─── Estado de out/ ──────────────────────────────────────────────────────────

async function leerProcesados(ctx: Contexto): Promise<Procesados> {
  const leido = await leerJson(rutaSalida(ctx, "procesados.json"), ProcesadosSchema, "procesados.json")
  return leido.ok ? leido.data : {}
}

async function marcarProcesado(ctx: Contexto, mensaje: string, accion: string, idContrato: string | null, motivo: string | null): Promise<void> {
  const procesados = await leerProcesados(ctx)
  procesados[mensaje] = { ts: new Date().toISOString(), accion, id_contrato: idContrato, motivo }
  await mkdir(rutaSalida(ctx), { recursive: true })
  await writeFile(rutaSalida(ctx, "procesados.json"), `${JSON.stringify(procesados, null, 2)}\n`, "utf8")
}

async function agregarHistorial(ctx: Contexto, entrada: Record<string, unknown>): Promise<void> {
  await mkdir(rutaSalida(ctx, "sharepoint"), { recursive: true })
  await appendFile(rutaSalida(ctx, "sharepoint", "historial.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), ...entrada })}\n`, "utf8")
}

/** RN7: cada ejecución deja una línea en out/log.jsonl. */
async function registrarLog(ctx: Contexto, herramienta: string, mensaje: string | null, resultado: Resultado<{ resumen: string }>): Promise<void> {
  const linea = {
    ts: new Date().toISOString(),
    herramienta: `contratos_${herramienta}`,
    mensaje_id: mensaje,
    ok: resultado.ok,
    resumen: resultado.ok ? resultado.data.resumen : resultado.error,
    sesion: ctx.sessionId ?? ctx.sessionID ?? null,
  }
  try {
    await mkdir(rutaSalida(ctx), { recursive: true })
    await appendFile(rutaSalida(ctx, "log.jsonl"), `${JSON.stringify(linea)}\n`, "utf8")
  } catch {
    // Un fallo del registro no interrumpe la herramienta.
  }
}

/** Envuelve cada herramienta: valida los argumentos, nunca lanza y deja el registro. */
async function ejecutar<T extends { resumen: string }>(
  ctx: Contexto,
  herramienta: string,
  esquema: z.ZodType,
  args: unknown,
  mensaje: (validos: Record<string, unknown>) => string | null,
  trabajo: (validos: Record<string, unknown>) => Promise<Resultado<T>>,
): Promise<string> {
  const validos = esquema.safeParse(args, ERRORES_EN_ESPANOL)
  if (!validos.success) return JSON.stringify(fallo(`Argumentos inválidos: ${describirProblema(validos.error)}`))
  const datos = validos.data as Record<string, unknown>
  let resultado: Resultado<T>
  try {
    resultado = await trabajo(datos)
  } catch (error) {
    resultado = fallo(`Error inesperado en contratos_${herramienta}: ${error instanceof Error ? error.message : String(error)}`)
  }
  await registrarLog(ctx, herramienta, mensaje(datos), resultado)
  return JSON.stringify(resultado)
}

// ─── Herramienta: leer el buzón ──────────────────────────────────────────────

type MensajeBuzon = {
  id: string
  de: string
  asunto: string
  fecha: string
  adjuntos: string[]
  tiene_contrato: boolean
  tipo_documento: TipoDocumento | null
  clasificacion_preliminar: "rechazado" | null
  motivo: string | null
}

async function resumirMensaje(ctx: Contexto, mensaje: string): Promise<MensajeBuzon> {
  const correo = await cargarCorreo(ctx, mensaje)
  if (!correo.ok) {
    return { id: mensaje, de: "", asunto: "", fecha: "", adjuntos: [], tiene_contrato: false, tipo_documento: null, clasificacion_preliminar: "rechazado", motivo: correo.error }
  }
  const adjuntos = await leerAdjuntos(ctx, correo.data, mensaje)
  const contrato = adjuntoDeContrato(adjuntos)
  return {
    id: mensaje,
    de: correo.data.de,
    asunto: correo.data.asunto,
    fecha: correo.data.fecha,
    adjuntos: correo.data.adjuntos,
    tiene_contrato: contrato !== null,
    tipo_documento: contrato?.tipo ?? null,
    clasificacion_preliminar: contrato ? null : "rechazado",
    motivo: contrato ? null : motivoDeRechazo(adjuntos),
  }
}

async function leerBuzon(ctx: Contexto) {
  const procesados = await leerProcesados(ctx)
  const todos = await listarMensajes(ctx)
  if (todos.length === 0) return fallo("El buzón (fixtures/reto-02/buzon/) está vacío o no existe.")
  const pendientes = todos.filter((mensaje) => !(mensaje in procesados))
  const mensajes = await Promise.all(pendientes.map((mensaje) => resumirMensaje(ctx, mensaje)))
  const conContrato = mensajes.filter((mensaje) => mensaje.tiene_contrato).length
  return exito({
    mensajes,
    ya_procesados: todos.filter((mensaje) => mensaje in procesados),
    resumen: `${mensajes.length} por procesar (${conContrato} con contrato u otrosí, ${mensajes.length - conContrato} sin contrato); ${todos.length - pendientes.length} ya procesados`,
  })
}

export const leer_buzon = {
  description: "Lista los mensajes del buzón de contratos que aún no se han procesado, con sus adjuntos y si traen contrato u otrosí.",
  args: {},
  async execute(args: Record<string, never>, ctx: Contexto) {
    return ejecutar(ctx, "leer_buzon", z.object({}), args ?? {}, () => null, () => leerBuzon(ctx))
  },
}

// ─── Herramienta: extraer ────────────────────────────────────────────────────

function resumirExtraccion(extraccion: Extraccion, dudosos: NombreCampo[]): string {
  const { id_contrato, cliente } = extraccion.campos
  const tipo = extraccion.otrosi ? `otrosí No. ${extraccion.otrosi.numero ?? "?"} de` : extraccion.tipo_documento === "contrato_marco" ? "contrato marco" : "contrato"
  const dudas = dudosos.length > 0 ? `; confianza baja en ${dudosos.join(", ")}` : "; todos los campos con confianza ≥ 0,8"
  return `${tipo} ${id_contrato.valor ?? "sin número"} · ${cliente.valor ?? "cliente no identificado"}${dudas}`
}

async function extraerMensaje(ctx: Contexto, mensaje: string) {
  const documento = await leerDocumento(ctx, mensaje)
  if (!documento.ok) return documento
  const { extraccion } = documento.data
  if (!extraccion) return fallo(`${mensaje} no trae contrato: ${motivoDeRechazo(documento.data.adjuntos)}. Se clasifica como rechazado con contratos_validar.`)
  const dudosos = bajaConfianza(extraccion)
  return exito({
    ...extraccion,
    /** Los valores tal cual, para pasarlos como `contrato` a contratos_validar y contratos_registrar. */
    valores: valoresDe(extraccion.campos),
    campos_baja_confianza: dudosos,
    resumen: resumirExtraccion(extraccion, dudosos),
  })
}

const ArgsMensaje = { mensaje_id: z.string().describe("Identificador del mensaje del buzón, por ejemplo msg-001") }

export const extraer = {
  description: "Extrae del contrato u otrosí adjunto los datos del maestro (cliente, NIT, país, objeto, valor, moneda, fechas y póliza) con su confianza de 0 a 1 por campo.",
  args: ArgsMensaje,
  async execute(args: { mensaje_id: string }, ctx: Contexto) {
    const esquema = z.object(ArgsMensaje)
    return ejecutar(ctx, "extraer", esquema, args, (validos) => String(validos.mensaje_id), (validos) => extraerMensaje(ctx, String(validos.mensaje_id)))
  },
}

// ─── Herramienta: validar ────────────────────────────────────────────────────

const ArgsValidar = {
  mensaje_id: ArgsMensaje.mensaje_id,
  contrato: ValoresSchema.optional().describe(
    "Los `valores` que devolvió contratos_extraer (campo → valor). Cambia solo los campos que la analista corrigió en el chat; si no hay correcciones, se puede omitir.",
  ),
}
type ArgsValidar = { mensaje_id: string; contrato?: z.infer<typeof ValoresSchema> }

function resumirValidacion(mensaje: string, validacion: Validacion): string {
  const revision = validacion.requiere_revision.length > 0 ? `; requiere revisión: ${validacion.requiere_revision.join(", ")}` : ""
  const motivo = validacion.motivo ? ` (${validacion.motivo})` : ""
  return `${mensaje}: ${validacion.clasificacion}${motivo}${revision}`
}

async function validarMensaje(ctx: Contexto, args: ArgsValidar, hoy: string): Promise<Resultado<Validacion & { documento: Documento }>> {
  const documento = await leerDocumento(ctx, args.mensaje_id)
  if (!documento.ok) return documento
  const maestro = await cargarMaestro(ctx)
  if (!maestro.ok) return maestro
  return exito({ ...clasificar(documento.data, maestro.data, args.contrato, hoy), documento: documento.data })
}

async function validarParaAgente(ctx: Contexto, args: ArgsValidar) {
  const resultado = await validarMensaje(ctx, args, hoyEnBogota())
  if (!resultado.ok) return resultado
  const { documento: _documento, ...validacion } = resultado.data
  const procesado = (await leerProcesados(ctx))[args.mensaje_id]
  const pendiente = validacion.requiere_revision.length > 0 && !procesado
  return exito({
    ...validacion,
    ...(procesado ? { ya_procesado: procesado } : {}),
    // El backend usa esta marca para saber que el siguiente «confirmo» de la persona aplica a este mensaje.
    ...(pendiente ? { confirmacion_pendiente: { mensaje_id: args.mensaje_id, campos: validacion.requiere_revision, valores: validacion.valores } } : {}),
    resumen: resumirValidacion(args.mensaje_id, validacion),
  })
}

export const validar = {
  description: "Clasifica el mensaje contra el maestro (nuevo, actualización, duplicado o rechazado) y lista los campos que requieren revisión humana antes de registrar.",
  args: ArgsValidar,
  async execute(args: ArgsValidar, ctx: Contexto) {
    const esquema = z.object(ArgsValidar)
    return ejecutar(ctx, "validar", esquema, args, (validos) => String(validos.mensaje_id), (validos) => validarParaAgente(ctx, validos as ArgsValidar))
  },
}

// ─── Herramienta: registrar ──────────────────────────────────────────────────

const ArgsRegistrar = {
  ...ArgsValidar,
  confirmado: z
    .boolean()
    .optional()
    .describe("true solo si la analista confirmó en su último mensaje los campos en revisión; el sistema lo verifica."),
  hoy: FechaSchema.optional().describe("Fecha de registro AAAA-MM-DD; por defecto, hoy en Bogotá"),
  valores_confirmados: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Lo fija el sistema con los valores que aprobó la analista; no lo escribas."),
}
type ArgsRegistrar = ArgsValidar & { confirmado?: boolean; hoy?: string; valores_confirmados?: Record<string, unknown> }

/** Campos en los que los valores a registrar no son los que aprobó la analista. */
function distintosDeLoAprobado(valores: Valores | null, aprobados: Record<string, unknown>): string[] {
  if (!valores) return []
  return (Object.keys(valores) as NombreCampo[]).filter((campo) => JSON.stringify(valores[campo]) !== JSON.stringify(aprobados[campo] ?? null))
}

function asignarId(maestro: Fila[], fila: Fila): string {
  const anio = (fila.fecha_inicio || fila.fecha_registro).slice(0, 4)
  const prefijo = `AUTO-${anio}-`
  const usados = maestro.map((otra) => otra.id_contrato).filter((id) => id.startsWith(prefijo)).map((id) => Number(id.slice(prefijo.length)) || 0)
  return `${prefijo}${String(Math.max(0, ...usados) + 1).padStart(3, "0")}`
}

/** HU-4: copia el documento a out/sharepoint/Contratos/<año_inicio>/<cliente-slug>/<id_contrato>.<ext>. */
async function archivar(ctx: Contexto, documento: Documento, fila: Fila, sufijo: string): Promise<string> {
  const adjunto = documento.contrato
  if (!adjunto) throw new Error("no hay documento que archivar")
  const anio = (fila.fecha_inicio || fila.fecha_registro).slice(0, 4)
  const extension = path.extname(adjunto.nombre) || ".txt"
  const relativaSharepoint = `Contratos/${anio}/${slug(fila.cliente)}/${fila.id_contrato}${sufijo}${extension}`
  const destino = rutaSalida(ctx, "sharepoint", ...relativaSharepoint.split("/"))
  await mkdir(path.dirname(destino), { recursive: true })
  await copyFile(rutaFixtures(ctx, "buzon", documento.extraccion?.mensaje_id ?? "", adjunto.nombre), destino)
  return relativaSharepoint
}

function faltantes(fila: Fila): string[] {
  const exigidas: Columna[] = ["cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza"]
  return exigidas.filter((columna) => fila[columna] === "")
}

type Registro = { id_contrato: string | null; accion: string; ruta_archivo: string | null; clasificacion: Clasificacion; resumen: string; fila?: Fila }

async function registrarMensaje(ctx: Contexto, args: ArgsRegistrar): Promise<Resultado<Registro>> {
  const previo = (await leerProcesados(ctx))[args.mensaje_id]
  if (previo) return fallo(`${args.mensaje_id} ya se procesó (${previo.accion}${previo.id_contrato ? ` ${previo.id_contrato}` : ""}, ${previo.ts}); no se vuelve a escribir.`)
  const hoy = args.hoy ?? hoyEnBogota()
  const validado = await validarMensaje(ctx, args, hoy)
  if (!validado.ok) return validado
  const { documento, ...validacion } = validado.data
  const { clasificacion } = validacion

  if (clasificacion === "rechazado") {
    await marcarProcesado(ctx, args.mensaje_id, "rechazado", null, validacion.motivo)
    return exito({ id_contrato: null, accion: "rechazado", ruta_archivo: null, clasificacion, resumen: `${args.mensaje_id} rechazado: ${validacion.motivo}` })
  }
  if (clasificacion === "duplicado") {
    await marcarProcesado(ctx, args.mensaje_id, "duplicado", validacion.id_contrato_existente, validacion.motivo)
    const maestro = await cargarMaestro(ctx)
    const ruta = maestro.ok ? maestro.data.find((fila) => fila.id_contrato === validacion.id_contrato_existente)?.ruta_sharepoint : undefined
    return exito({
      id_contrato: validacion.id_contrato_existente,
      accion: "sin_cambios",
      ruta_archivo: ruta ? `out/sharepoint/${ruta}` : null,
      clasificacion,
      resumen: `${args.mensaje_id} duplicado de ${validacion.id_contrato_existente}: no se escribió nada en el maestro`,
    })
  }
  if (validacion.requiere_revision.length > 0 && args.confirmado !== true) {
    return fallo(`${ERROR_REVISION}: ${validacion.detalle_revision.map((item) => `${item.campo} (${item.motivo})`).join("; ")}`)
  }
  // Con valores aprobados (los fija el backend), la confirmación solo vale para esos valores exactos.
  const noAprobados = args.valores_confirmados ? distintosDeLoAprobado(validacion.valores, args.valores_confirmados) : []
  if (validacion.requiere_revision.length > 0 && noAprobados.length > 0) {
    return fallo(`${ERROR_REVISION}: ${noAprobados.join(", ")} no tiene el valor que confirmó la analista; muéstrale los valores con contratos_validar y vuelve a preguntar`)
  }
  const registro = validacion.registro
  if (!registro) return fallo("No se pudo armar la fila del maestro.")
  const sinDato = faltantes(registro)
  if (sinDato.length > 0) return fallo(`Faltan datos para registrar: ${sinDato.join(", ")}. Pídeselos a la analista y vuelve a validar con esos valores.`)

  const maestro = await cargarMaestro(ctx)
  if (!maestro.ok) return maestro
  const confirmados = validacion.requiere_revision
  const corregidos = documento.extraccion ? aplicarCorrecciones(documento.extraccion, args.contrato).corregidos : []

  if (clasificacion === "nuevo") {
    const fila: Fila = { ...registro, fecha_registro: hoy }
    if (!fila.id_contrato) fila.id_contrato = asignarId(maestro.data, fila)
    if (maestro.data.some((otra) => mismoId(otra.id_contrato, fila.id_contrato))) return fallo(`Ya existe el contrato ${fila.id_contrato} en el maestro.`)
    fila.ruta_sharepoint = await archivar(ctx, documento, fila, "")
    await writeFile(rutaMaestro(ctx), escribirCsv([...maestro.data, fila]), "utf8")
    await agregarHistorial(ctx, { id_contrato: fila.id_contrato, accion: "alta", cambios: fila, mensaje_id: args.mensaje_id, campos_confirmados: confirmados, campos_corregidos: corregidos })
    await marcarProcesado(ctx, args.mensaje_id, "insertado", fila.id_contrato, null)
    return exito({ id_contrato: fila.id_contrato, accion: "insertado", ruta_archivo: `out/sharepoint/${fila.ruta_sharepoint}`, clasificacion, fila, resumen: `${fila.id_contrato} insertado en el maestro` })
  }

  const existente = validacion.id_contrato_existente
  const indice = maestro.data.findIndex((fila) => fila.id_contrato === existente)
  const anterior = maestro.data[indice]
  if (indice < 0 || !anterior) return fallo(`El contrato ${existente} ya no está en el maestro.`)
  const otrosi = documento.extraccion?.otrosi
  const archivo = await archivar(ctx, documento, registro, otrosi ? `-otrosi-${otrosi.numero ?? "sin-numero"}` : "-actualizacion")
  const filas = [...maestro.data]
  filas[indice] = registro
  await writeFile(rutaMaestro(ctx), escribirCsv(filas), "utf8")
  const cambios = Object.fromEntries(validacion.diferencias.map((diferencia) => [diferencia.campo, { antes: diferencia.maestro, despues: diferencia.documento }]))
  await agregarHistorial(ctx, { id_contrato: registro.id_contrato, accion: "actualizacion", cambios, mensaje_id: args.mensaje_id, documento: archivo, campos_confirmados: confirmados, campos_corregidos: corregidos })
  await marcarProcesado(ctx, args.mensaje_id, "actualizado", registro.id_contrato, validacion.motivo)
  const lista = Object.keys(cambios).join(", ") || "sin cambios de datos"
  return exito({ id_contrato: registro.id_contrato, accion: "actualizado", ruta_archivo: `out/sharepoint/${archivo}`, clasificacion, fila: registro, resumen: `${registro.id_contrato} actualizado (${lista}); historial en out/sharepoint/historial.jsonl` })
}

export const registrar = {
  description: "Registra el resultado del mensaje: inserta o actualiza la fila del maestro y archiva el documento, o deja constancia del duplicado o del rechazo.",
  args: ArgsRegistrar,
  async execute(args: ArgsRegistrar, ctx: Contexto) {
    const esquema = z.object(ArgsRegistrar)
    return ejecutar(ctx, "registrar", esquema, args, (validos) => String(validos.mensaje_id), (validos) => registrarMensaje(ctx, validos as ArgsRegistrar))
  },
}

// ─── Herramienta: alertas ────────────────────────────────────────────────────

type ContratoAlerta = { id_contrato: string; cliente: string; fecha_fin: string; dias: number }
type PolizaAlerta = { id_contrato: string; cliente: string; tipo_poliza: string; estado_poliza: string; fecha_fin: string }
type RegistroAlerta = { id_contrato: string; cliente: string; fecha_registro: string; fuente: string }

function tablaMd(cabecera: string[], filas: string[][]): string {
  if (filas.length === 0) return "_Ninguno._\n"
  const escapar = (texto: string) => texto.replace(/\|/g, "\\|")
  return [`| ${cabecera.join(" | ")} |`, `|${cabecera.map(() => "---").join("|")}|`, ...filas.map((fila) => `| ${fila.map(escapar).join(" | ")} |`)].join("\n") + "\n"
}

function alertasMd(hoy: string, vencen: ContratoAlerta[], vencidos: ContratoAlerta[], polizas: PolizaAlerta[], registrados: RegistroAlerta[]): string {
  const vencidosTexto =
    vencidos.length > 0
      ? `\nAdemás, ${vencidos.length} ${vencidos.length === 1 ? "contrato del maestro ya venció" : "contratos del maestro ya vencieron"} sin otrosí de prórroga registrado: ${vencidos.map((c) => `${c.id_contrato} (${c.cliente}, ${c.fecha_fin})`).join("; ")}.\n`
      : ""
  return `# Alertas de contratos

Fecha de referencia: ${hoy} · maestro: out/sharepoint/maestro-contratos.csv

## 1. Contratos que vencen en ${DIAS_ALERTA} días o menos

${tablaMd(["Contrato", "Cliente", "Fecha fin", "Días"], vencen.map((c) => [c.id_contrato, c.cliente, c.fecha_fin, String(c.dias)]))}${vencidosTexto}
## 2. Pólizas pendientes (requiere póliza y no está vigente)

${tablaMd(["Contrato", "Cliente", "Pólizas", "Estado", "Fin del contrato"], polizas.map((p) => [p.id_contrato, p.cliente, p.tipo_poliza.split(";").join(", ") || "—", p.estado_poliza, p.fecha_fin]))}
## 3. Contratos registrados desde el corte del ${FECHA_CORTE} (hueco cubierto)

${tablaMd(["Contrato", "Cliente", "Fecha de registro", "Fuente"], registrados.map((r) => [r.id_contrato, r.cliente, r.fecha_registro, r.fuente]))}`
}

async function calcularAlertas(ctx: Contexto, hoy: string) {
  const maestro = await cargarMaestro(ctx)
  if (!maestro.ok) return maestro
  const conDias = maestro.data
    .filter((fila) => fechaValida(fila.fecha_fin))
    .map((fila) => ({ id_contrato: fila.id_contrato, cliente: fila.cliente, fecha_fin: fila.fecha_fin, dias: diasEntre(hoy, fila.fecha_fin) }))
  const vencen = conDias.filter((fila) => fila.dias >= 0 && fila.dias <= DIAS_ALERTA).sort((a, b) => a.dias - b.dias)
  const vencidos = conDias.filter((fila) => fila.dias < 0).sort((a, b) => a.dias - b.dias)
  const polizas = maestro.data
    .filter((fila) => fila.requiere_poliza === "true" && fila.estado_poliza !== "vigente")
    .map(({ id_contrato, cliente, tipo_poliza, estado_poliza, fecha_fin }) => ({ id_contrato, cliente, tipo_poliza, estado_poliza, fecha_fin }))
  const registrados = maestro.data
    .filter((fila) => fila.fecha_registro >= FECHA_CORTE)
    .map(({ id_contrato, cliente, fecha_registro, fuente }) => ({ id_contrato, cliente, fecha_registro, fuente }))
  const destino = rutaSalida(ctx, "alertas.md")
  await writeFile(destino, alertasMd(hoy, vencen, vencidos, polizas, registrados), "utf8")
  return exito({
    ruta: relativa(ctx, destino),
    hoy,
    vencen,
    vencidos,
    polizas_pendientes: polizas,
    registrados_desde_corte: registrados,
    resumen: `${vencen.length} vencen en ≤ ${DIAS_ALERTA} días, ${polizas.length} pólizas pendientes, ${registrados.length} registrados desde el corte`,
  })
}

const ArgsAlertas = { hoy: FechaSchema.describe("Fecha de referencia AAAA-MM-DD (la de hoy, si la analista no da otra)") }

export const alertas = {
  description: "Genera out/alertas.md con los contratos que vencen en 60 días o menos, las pólizas pendientes y lo registrado desde el corte del maestro.",
  args: ArgsAlertas,
  async execute(args: { hoy: string }, ctx: Contexto) {
    const esquema = z.object(ArgsAlertas)
    return ejecutar(ctx, "alertas", esquema, args, () => null, (validos) => calcularAlertas(ctx, String(validos.hoy)))
  },
}
