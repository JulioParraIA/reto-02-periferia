/**
 * Redacciones de contratos distintas a las de los fixtures, para probar la extracción contra lo que
 * un humano leería. La primera tanda cubre los formatos que pidió el reto (valor en letras, fechas
 * 15/08/2026, dos contratantes, anexo de tarifas); la segunda, los puntos débiles que salieron de
 * leer el código. Cada caso documenta el error que tenía antes de corregirse.
 */
export type Caso = { id: string; prueba: string; correo: string; texto: string; esperado: Record<string, unknown> }

const PERIFERIA = "PERIFERIA IT GROUP S.A.S., identificada con NIT 900.123.456-7, quien en adelante se denominará EL CONTRATISTA"

const PRIMERA_TANDA: Caso[] = [
  {
    id: "msg-101",
    prueba: "Valor solo en letras, sin cifra",
    correo: "Adjunto contrato firmado. Laura.",
    texto: `CONTRATO DE PRESTACIÓN DE SERVICIOS No. CT-2026-101

Entre los suscritos, ALIMENTOS DEL SUR S.A.S., identificada con NIT 901.456.789-3, con domicilio en Cali, quien en adelante se denominará EL CONTRATANTE, y ${PERIFERIA}, se ha celebrado el presente contrato:

PRIMERA. OBJETO. EL CONTRATISTA prestará servicios de soporte a la plataforma de comercio electrónico del CONTRATANTE.

SEGUNDA. VALOR. El valor total del presente contrato es de CUATROCIENTOS OCHENTA Y SEIS MILLONES QUINIENTOS MIL PESOS M/CTE, IVA incluido.

TERCERA. PLAZO. El plazo de ejecución será desde el primero (1) de octubre de 2026 hasta el treinta (30) de septiembre de 2027.

Para constancia se firma en Cali, a los quince (15) días del mes de septiembre de 2026.

Andrea Mejía                              Roberto Andrade Salazar
Alimentos del Sur S.A.S.                  Periferia IT Group S.A.S.`,
    esperado: { id_contrato: "CT-2026-101", nit_cliente: "901456789", pais: "CO", valor: 486_500_000, moneda: "COP", fecha_inicio: "2026-10-01", fecha_fin: "2027-09-30", requiere_poliza: false },
  },
  {
    id: "msg-102",
    prueba: "Fechas en formato 15/08/2026",
    correo: "Va el contrato. Laura.",
    texto: `CONTRATO DE PRESTACIÓN DE SERVICIOS No. CT-2026-102

Entre los suscritos, TRANSPORTES ANDINOS S.A., identificada con NIT 860.111.222-1, con domicilio en Bogotá D.C., quien en adelante se denominará EL CONTRATANTE, y ${PERIFERIA}, se ha celebrado el presente contrato:

PRIMERA. OBJETO. EL CONTRATISTA desarrollará la aplicación móvil de rastreo de flota del CONTRATANTE.

SEGUNDA. VALOR. El valor total del presente contrato es de CIENTO CINCUENTA MILLONES DE PESOS M/CTE (COP $150.000.000), más IVA.

TERCERA. PLAZO. El plazo de ejecución será desde el 15/08/2026 hasta el 14/08/2027.

Para constancia se firma en Bogotá D.C., el 10/08/2026.

Transportes Andinos S.A.                  Periferia IT Group S.A.S.`,
    esperado: { id_contrato: "CT-2026-102", nit_cliente: "860111222", valor: 150_000_000, moneda: "COP", fecha_inicio: "2026-08-15", fecha_fin: "2027-08-14" },
  },
  {
    id: "msg-103",
    prueba: "Dos contratantes (consorcio de dos empresas)",
    correo: "Contrato con el consorcio, son dos empresas. Laura.",
    texto: `CONTRATO DE PRESTACIÓN DE SERVICIOS No. CT-2026-103

Entre los suscritos, CONSORCIO VIAL DEL NORTE, integrado por CONSTRUCTORA ANDES S.A.S., identificada con NIT 900.777.111-2, y PAVIMENTOS DEL CARIBE S.A., identificada con NIT 890.222.444-5, con domicilio en Barranquilla, quienes en adelante se denominarán EL CONTRATANTE, y ${PERIFERIA}, se ha celebrado el presente contrato:

PRIMERA. OBJETO. EL CONTRATISTA implementará el sistema de control de obra del CONTRATANTE.

SEGUNDA. VALOR. El valor total del presente contrato es de TRESCIENTOS MILLONES DE PESOS M/CTE (COP $300.000.000), IVA incluido.

TERCERA. PLAZO. El plazo de ejecución será desde el primero (1) de septiembre de 2026 hasta el treinta y uno (31) de agosto de 2027.

CUARTA. GARANTÍAS. EL CONTRATISTA constituirá una póliza de cumplimiento por el diez por ciento (10%) del valor del contrato.

Para constancia se firma en Barranquilla, a los veinte (20) días del mes de agosto de 2026.

Consorcio Vial del Norte                  Periferia IT Group S.A.S.`,
    esperado: { cliente: "Consorcio Vial del Norte", valor: 300_000_000, fecha_inicio: "2026-09-01", fecha_fin: "2027-08-31", requiere_poliza: true },
  },
  {
    id: "msg-104",
    prueba: "Valor por bolsa de horas con tope y anexo de tarifas",
    correo: "Contrato por tarifas, anexo incluido. Laura.",
    texto: `CONTRATO DE PRESTACIÓN DE SERVICIOS No. CT-2026-104

Entre los suscritos, BANCO DEL PACÍFICO S.A., identificada con NIT 890.300.555-6, con domicilio en Cali, quien en adelante se denominará EL CONTRATANTE, y ${PERIFERIA}, se ha celebrado el presente contrato:

PRIMERA. OBJETO. EL CONTRATISTA prestará servicios de desarrollo de software bajo la modalidad de bolsa de horas.

SEGUNDA. VALOR. El valor del contrato se liquidará mensualmente según las horas consumidas y las tarifas del Anexo 1, hasta un tope de OCHOCIENTOS MILLONES DE PESOS M/CTE (COP $800.000.000).

TERCERA. PLAZO. El plazo de ejecución será desde el primero (1) de octubre de 2026 hasta el treinta (30) de septiembre de 2027.

ANEXO 1. TARIFAS
Desarrollador senior: COP $185.000 por hora
Arquitecto de software: COP $240.000 por hora

Para constancia se firma en Cali, a los veinticinco (25) días del mes de septiembre de 2026.

Banco del Pacífico S.A.                   Periferia IT Group S.A.S.`,
    esperado: { valor: "800000000 como tope (o 0 indeterminado), con revisión", moneda: "COP", fecha_fin: "2027-09-30" },
  },
  {
    id: "msg-105",
    prueba: "Cláusulas con otro formato («CLÁUSULA PRIMERA - OBJETO:»)",
    correo: "Contrato firmado, con otro formato. Laura.",
    texto: `CONTRATO DE PRESTACIÓN DE SERVICIOS No. CT-2026-105

Entre los suscritos, RETAIL ANDINO S.A.S., identificada con NIT 901.888.222-0, con domicilio en Medellín, quien en adelante se denominará EL CONTRATANTE, y ${PERIFERIA}, acuerdan:

CLÁUSULA PRIMERA - OBJETO: Implementación del sistema de gestión de inventarios en las tiendas del CONTRATANTE.

CLÁUSULA SEGUNDA - VALOR: Noventa millones de pesos (COP $90.000.000), IVA incluido.

CLÁUSULA TERCERA - PLAZO: Desde el primero (1) de noviembre de 2026 hasta el treinta (30) de abril de 2027.

Para constancia se firma en Medellín, a los cinco (5) días del mes de octubre de 2026.

Retail Andino S.A.S.                      Periferia IT Group S.A.S.`,
    esperado: { objeto: "Implementación del sistema de gestión de inventarios…", valor: 90_000_000, fecha_inicio: "2026-11-01", fecha_fin: "2027-04-30" },
  },
  {
    id: "msg-106",
    prueba: "Cifra sin paréntesis ni letras; plazo desde el acta de inicio",
    correo: "Contrato firmado. Laura.",
    texto: `CONTRATO DE PRESTACIÓN DE SERVICIOS No. CT-2026-106

Entre los suscritos, CLÍNICA DEL MAR S.A., identificada con NIT 800.999.111-4, con domicilio en Cartagena, quien en adelante se denominará EL CONTRATANTE, y ${PERIFERIA}, se ha celebrado el presente contrato:

PRIMERA. OBJETO. EL CONTRATISTA prestará el servicio de mesa de ayuda para la historia clínica electrónica.

SEGUNDA. VALOR. El valor total del presente contrato es de $ 1.250.000.000 incluido IVA.

TERCERA. PLAZO. El presente contrato tendrá un plazo de seis (6) meses contados a partir de la suscripción del acta de inicio.

Para constancia se firma en Cartagena, a los dos (2) días del mes de septiembre de 2026.

Clínica del Mar S.A.                      Periferia IT Group S.A.S.`,
    esperado: { valor: 1_250_000_000, moneda: "COP", fecha_inicio: "desconocida (acta de inicio): revisión", fecha_fin: "desconocida: revisión" },
  },
  {
    id: "msg-107",
    prueba: "RTN de Honduras, US$ con punto de miles y fecha «1°»",
    correo: "Contrato con Honduras, en dólares. Carlos.",
    texto: `CONTRATO DE PRESTACIÓN DE SERVICIOS No. CT-2026-107

Entre los suscritos, EXPORTADORA SULA S. DE R.L., identificada con RTN 05019998765432, con domicilio en San Pedro Sula, Honduras, quien en adelante se denominará EL CONTRATANTE, y ${PERIFERIA}, se ha celebrado el presente contrato:

PRIMERA. OBJETO. EL CONTRATISTA prestará servicios de analítica de datos para la cadena de exportación.

SEGUNDA. VALOR. El valor total del presente contrato es de OCHENTA Y CINCO MIL QUINIENTOS DÓLARES (US$ 85.500), más impuestos.

TERCERA. PLAZO. El plazo de ejecución será desde el 1° de septiembre de 2026 hasta el 31 de agosto de 2027.

Para constancia se firma en San Pedro Sula, a los treinta (30) días del mes de agosto de 2026.

Exportadora Sula S. de R.L.               Periferia IT Group S.A.S.`,
    esperado: { nit_cliente: "05019998765432", pais: "HN", valor: 85_500, moneda: "USD", fecha_inicio: "2026-09-01", fecha_fin: "2027-08-31" },
  },
  {
    id: "msg-108",
    prueba: "Otrosí titulado «MODIFICACIÓN No. 2»",
    correo: "Va la modificación No. 2 del contrato de Minera. Carlos.",
    texto: `MODIFICACIÓN No. 2 AL CONTRATO DE PRESTACIÓN DE SERVICIOS No. CT-2026-011

Entre MINERA LOS ANDES S.A.C., identificada con RUC 20512345678, con domicilio en Lima, Perú (EL CONTRATANTE), y PERIFERIA IT GROUP S.A.S., NIT 900.123.456-7 (EL CONTRATISTA), se acuerda modificar el contrato No. CT-2026-011 en los siguientes términos:

PRIMERA. Modificar la cláusula TERCERA (PLAZO), la cual quedará así: "El plazo de ejecución se extiende hasta el treinta y uno (31) de diciembre de 2027."

Se firma en Lima, a los diez (10) días del mes de septiembre de 2026.`,
    esperado: { clasificacion: "actualizacion de CT-2026-011", fecha_fin: "2027-12-31" },
  },
  {
    id: "msg-109",
    prueba: "Periferia es la contratante (contrato con un proveedor)",
    correo: "Este es un contrato donde Periferia contrata a un proveedor. Laura.",
    texto: `CONTRATO DE PRESTACIÓN DE SERVICIOS No. CT-2026-109

Entre los suscritos, PERIFERIA IT GROUP S.A.S., identificada con NIT 900.123.456-7, con domicilio en Medellín, quien en adelante se denominará EL CONTRATANTE, y NUBE SEGURA S.A.S., identificada con NIT 901.333.444-8, con domicilio en Bogotá D.C., quien en adelante se denominará EL CONTRATISTA, se ha celebrado el presente contrato:

PRIMERA. OBJETO. EL CONTRATISTA prestará servicios de hospedaje en la nube para los ambientes de pruebas del CONTRATANTE.

SEGUNDA. VALOR. El valor total del presente contrato es de SESENTA MILLONES DE PESOS M/CTE (COP $60.000.000), IVA incluido.

TERCERA. PLAZO. El plazo de ejecución será desde el primero (1) de septiembre de 2026 hasta el treinta y uno (31) de agosto de 2027.

Para constancia se firma en Medellín, a los veinte (20) días del mes de agosto de 2026.

Periferia IT Group S.A.S.                 Nube Segura S.A.S.`,
    esperado: { cliente: "Nube Segura S.A.S. es PROVEEDOR, no cliente: debería ir a revisión o rechazarse" },
  },
  {
    id: "msg-110",
    prueba: "RUC de Panamá con guiones y decimales con coma (210.000,50)",
    correo: "Contrato fase 2 con Panamá. Carlos.",
    texto: `CONTRATO DE PRESTACIÓN DE SERVICIOS No. CT-2026-110

Entre los suscritos, LOGÍSTICA DEL ISTMO S.A., identificada con RUC 155612345-2-2021, con domicilio en Ciudad de Panamá, Panamá, quien en adelante se denominará EL CONTRATANTE, y ${PERIFERIA}, se ha celebrado el presente contrato:

PRIMERA. OBJETO. EL CONTRATISTA implementará la fase 2 del sistema de gestión de bodegas (WMS), con integración a aduanas.

SEGUNDA. VALOR. El valor total del presente contrato es de DOSCIENTOS DIEZ MIL BALBOAS (PAB 210.000,50), más impuestos.

TERCERA. PLAZO. El plazo de ejecución será de nueve (9) meses, desde el primero (1) de noviembre de 2026 hasta el treinta y uno (31) de julio de 2027.

CUARTA. GARANTÍAS. EL CONTRATISTA constituirá una póliza de cumplimiento y otra de calidad del servicio.

Para constancia se firma en Ciudad de Panamá, a los quince (15) días del mes de octubre de 2026.

Logística del Istmo S.A.                  Periferia IT Group S.A.S.`,
    esperado: { nit_cliente: "155612345", pais: "PA", valor: 210_000.5, moneda: "PAB", fecha_fin: "2027-07-31", tipo_poliza: "cumplimiento;calidad" },
  },
]

const ENCABEZADO = (cliente: string, numero = "CT-2026-2XX") => `CONTRATO DE PRESTACIÓN DE SERVICIOS No. ${numero}

Entre los suscritos, ${cliente}, con domicilio en Bogotá D.C., quien en adelante se denominará EL CONTRATANTE, y ${PERIFERIA}, se ha celebrado el presente contrato:

PRIMERA. OBJETO. EL CONTRATISTA prestará servicios de desarrollo de software para el CONTRATANTE.`
const FIRMA = "\n\nPara constancia se firma en Bogotá D.C., a los dos (2) días del mes de septiembre de 2026."
const VALOR = "\n\nSEGUNDA. VALOR. El valor total del presente contrato es de CIEN MILLONES DE PESOS M/CTE (COP $100.000.000), IVA incluido."
const PLAZO = "\n\nTERCERA. PLAZO. El plazo de ejecución será desde el primero (1) de septiembre de 2026 hasta el treinta y uno (31) de agosto de 2027."

const SEGUNDA_TANDA: Caso[] = [
  {
    id: "msg-201",
    prueba: "Póliza negada expresamente",
    correo: "Contrato firmado. Laura.",
    texto: `${ENCABEZADO("SEGUROS ALFA S.A., identificada con NIT 860.000.111-5", "CT-2026-201")}${VALOR}${PLAZO}

CUARTA. GARANTÍAS. Las partes acuerdan que EL CONTRATISTA no deberá constituir pólizas ni garantías de ningún tipo.${FIRMA}`,
    esperado: { requiere_poliza: false },
  },
  {
    id: "msg-202",
    prueba: "«sociedad identificada con NIT.» y razón social en minúsculas",
    correo: "Contrato firmado. Laura.",
    texto: `${ENCABEZADO("Industrias Norte S.A.S., sociedad identificada con NIT. 900.555.666-1", "CT-2026-202")}${VALOR}${PLAZO}${FIRMA}`,
    esperado: { cliente: "Industrias Norte S.A.S.", nit_cliente: "900555666" },
  },
  {
    id: "msg-203",
    prueba: "Plazo «doce meses a partir del 1 de agosto», sin fecha final",
    correo: "Contrato firmado. Laura.",
    texto: `${ENCABEZADO("COMERCIAL BETA S.A.S., identificada con NIT 901.111.222-3", "CT-2026-203")}${VALOR}

TERCERA. PLAZO. El contrato tendrá un término de doce (12) meses a partir del primero (1) de agosto de 2026.${FIRMA}`,
    esperado: { fecha_inicio: "2026-08-01", fecha_fin: "2027-07-31" },
  },
  {
    id: "msg-204",
    prueba: "Otrosí que adiciona un monto (no da el total)",
    correo: "Otrosí de adición de Minera. Carlos.",
    texto: `OTROSÍ No. 3 AL CONTRATO DE PRESTACIÓN DE SERVICIOS No. CT-2026-011

Entre MINERA LOS ANDES S.A.C., identificada con RUC 20512345678, con domicilio en Lima, Perú (EL CONTRATANTE), y PERIFERIA IT GROUP S.A.S., NIT 900.123.456-7 (EL CONTRATISTA), se acuerda:

PRIMERA. Adicionar el valor del contrato en CIEN MIL SOLES (PEN 100,000.00), para cubrir nuevas funcionalidades.

Se firma en Lima, a los diez (10) días del mes de septiembre de 2026.`,
    esperado: { clasificacion: "actualizacion con revisión del valor (350.000 + 100.000)" },
  },
  {
    id: "msg-205",
    prueba: "Reenvío de un contrato del maestro con el número escrito «CT 2026 012»",
    correo: "Reenvío el de la Clínica. Laura.",
    texto: `CONTRATO DE PRESTACIÓN DE SERVICIOS No. CT 2026 012

Entre los suscritos, CLÍNICA SAN RAFAEL S.A., identificada con NIT 890.903.456-1, con domicilio en Medellín, quien en adelante se denominará EL CONTRATANTE, y ${PERIFERIA}, se ha celebrado el presente contrato:

PRIMERA. OBJETO. EL CONTRATISTA prestará el servicio de mesa de servicio de tecnología en niveles 1 y 2.

SEGUNDA. VALOR. El valor total del presente contrato es de DOSCIENTOS DIEZ MILLONES DE PESOS M/CTE (COP $210.000.000), IVA incluido.

TERCERA. PLAZO. El plazo de ejecución será de seis (6) meses, desde el quince (15) de mayo de 2026 hasta el catorce (14) de noviembre de 2026.

Para constancia se firma en Medellín, a los catorce (14) días del mes de mayo de 2026.`,
    esperado: { clasificacion: "duplicado de CT-2026-012" },
  },
  {
    id: "msg-206",
    prueba: "Número con «N°»",
    correo: "Contrato firmado. Laura.",
    texto: `${ENCABEZADO("GAMMA LOGÍSTICA S.A.S., identificada con NIT 901.222.333-4", "").replace("No. ", "N° CT-2026-206")}${VALOR}${PLAZO}${FIRMA}`,
    esperado: { id_contrato: "CT-2026-206" },
  },
  {
    id: "msg-207",
    prueba: "Valor con anticipo: dos montos en la cláusula",
    correo: "Contrato firmado. Laura.",
    texto: `${ENCABEZADO("DELTA ENERGÍA S.A. E.S.P., identificada con NIT 830.333.444-5", "CT-2026-207")}

SEGUNDA. VALOR. El valor total del presente contrato es de SEISCIENTOS MILLONES DE PESOS M/CTE ($600.000.000), de los cuales COP $100.000.000 se pagarán como anticipo.${PLAZO}${FIRMA}`,
    esperado: { valor: 600_000_000, moneda: "COP" },
  },
  {
    id: "msg-208",
    prueba: "Fechas con el mes primero («agosto 1 de 2026»)",
    correo: "Contrato firmado. Laura.",
    texto: `${ENCABEZADO("EPSILON DATOS S.A.S., identificada con NIT 901.444.555-6", "CT-2026-208")}${VALOR}

TERCERA. PLAZO. El plazo de ejecución será desde agosto 1 de 2026 hasta julio 31 de 2027.${FIRMA}`,
    esperado: { fecha_inicio: "2026-08-01", fecha_fin: "2027-07-31" },
  },
  {
    id: "msg-209",
    prueba: "USD con punto de miles («USD 120.000»)",
    correo: "Contrato en dólares. Carlos.",
    texto: `${ENCABEZADO("ZETA CORP S.A., identificada con RUC 1790098765001", "CT-2026-209")}

SEGUNDA. VALOR. El valor total del presente contrato es de CIENTO VEINTE MIL DÓLARES (USD 120.000), más impuestos.${PLAZO}${FIRMA}`,
    esperado: { valor: 120_000, moneda: "USD", pais: "EC" },
  },
  {
    id: "msg-210",
    prueba: "Unión temporal con NIT propio",
    correo: "Contrato con la unión temporal. Laura.",
    texto: `${ENCABEZADO("UNIÓN TEMPORAL SALUD DIGITAL 2026, identificada con NIT 901.000.111-2, integrada por HOSPITAL NORTE S.A. y CLÍNICA SUR S.A.S.", "CT-2026-210")}${VALOR}${PLAZO}${FIRMA}`,
    esperado: { cliente: "Unión Temporal Salud Digital 2026", nit_cliente: "901000111" },
  },
  {
    id: "msg-211",
    prueba: "Valor grande en letras («MIL DOSCIENTOS CINCUENTA MILLONES»)",
    correo: "Contrato firmado. Laura.",
    texto: `${ENCABEZADO("ETA INFRAESTRUCTURA S.A.S., identificada con NIT 901.555.666-7", "CT-2026-211")}

SEGUNDA. VALOR. El valor total del presente contrato es de MIL DOSCIENTOS CINCUENTA MILLONES DE PESOS M/CTE (COP $1.250.000.000).${PLAZO}${FIRMA}`,
    esperado: { valor: 1_250_000_000 },
  },
  {
    id: "msg-212",
    prueba: "Solo el valor mensual, sin el total",
    correo: "Contrato firmado. Laura.",
    texto: `${ENCABEZADO("THETA RETAIL S.A.S., identificada con NIT 901.666.777-8", "CT-2026-212")}

SEGUNDA. VALOR. EL CONTRATANTE pagará un valor mensual de VEINTE MILLONES DE PESOS M/CTE (COP $20.000.000) durante la vigencia del contrato.${PLAZO}${FIRMA}`,
    esperado: { valor: "240000000 (20 M × 12 meses) o el mensual con revisión" },
  },
]

export const CASOS: Caso[] = [...PRIMERA_TANDA, ...SEGUNDA_TANDA]
