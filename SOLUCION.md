# Planteamiento de la solución · Reto 02 «Registro de Contratos Vigentes»

Versión 1.0 · 2026-10-27.

## 1. El problema en una frase

Desde el 30 de mayo de 2026 nadie alimenta el maestro de contratos vigentes y solo llegan a administración los contratos que piden póliza; le duele a la analista administrativa, que no puede responder qué contratos están vigentes ni qué pólizas faltan, y a la gerencia, que no ve qué vence este trimestre ni sabe qué garantías exigidas por contrato no se han constituido.

## 2. Arquitectura

```
 Navegador (web/)                        Backend en Bun (src/)
┌──────────────────┐   POST /api/chat    ┌────────────────────────────────────┐
│ chat             │ ──────────────────▶ │ http/app.ts  rutas y clave         │
│ · pasos          │                     │ ciclo.ts     ciclo del agente      │
│ · confirmación   │ ◀────────────────── │ prompt       agent/prompt.md       │
│ registro         │  reply · toolCalls  │              + src/knowledge/      │
│ · buzón          │  needsConfirmation  │ openrouter   adaptador del modelo ─┼──▶ OpenRouter · Claude Sonnet 5.5
│ · maestro        │  consumo            │ herramientas validación zod        │
│ · alertas        │ ── GET buzón, ────▶ │ buzon.ts     lectura para la       │
│ · historial      │    maestro…         │              interfaz (sin agente) │
│ consola          │                     └─────────────────┬──────────────────┘
└──────────────────┘                                       ▼
                         src/tools/contratos.ts: lee fixtures/reto-02/ (solo lectura) y escribe out/
 demo.ts ── llama las mismas herramientas, sin modelo ──▶ src/tools/contratos.ts

 out/sharepoint/maestro-contratos.csv   copia de trabajo del maestro (RN6)
 out/sharepoint/Contratos/<año>/<cliente>/<contrato>.txt
 out/sharepoint/historial.jsonl         altas y actualizaciones con el antes y el después
 out/procesados.json · out/alertas.md · out/log.jsonl
```

La separación que pide el PRD está en tres lugares distintos, y ninguno vive dentro del servidor:

| Pieza | Dónde vive | Qué contiene |
|---|---|---|
| Comportamiento | `agent/prompt.md` | Orden de las herramientas por mensaje, reglas que no se rompen, confirmación y formato de la respuesta |
| Conocimiento | `src/knowledge/registro-contratos.md` | Clasificación, confianza y revisión, otrosíes, pólizas, identificador y país, alertas y qué queda en `out/` |
| Ejecución | `src/tools/contratos.ts` | Las cinco herramientas con argumentos zod; son la única fuente de valores |

Cambiar una regla de negocio toca las herramientas o el conocimiento, no `server.ts` ni el ciclo. El adaptador del modelo es una interfaz propia (`enviar(mensajes, herramientas) → respuesta`): pasar a otro proveedor es escribir otra implementación de `AdaptadorLLM`, sin tocar el ciclo.

La interfaz tiene, junto al chat, un panel de registro que lee `out/` directamente (no pasa por el agente ni deja registro): el buzón con el estado de cada mensaje y lo que quedó en revisión, el maestro con las filas nuevas y las actualizadas resaltadas (y el campo que cambió), el reporte de alertas y el historial con el documento archivado de cada movimiento. El botón «Reiniciar buzón» borra `out/` para repetir la demo.

## 3. Ciclo del agente

Cada mensaje del usuario abre un turno. El backend manda la conversación al modelo junto con las herramientas; si el modelo pide herramientas, cada llamada se valida con el esquema zod de la herramienta, se ejecuta, queda en el chat y en `out/log.jsonl`, y su resultado vuelve al modelo. El turno termina cuando el modelo responde sin pedir herramientas. Para procesar el buzón el prompt fija el orden por mensaje: extraer → validar → registrar, o dejarlo en revisión, y al final las alertas.

**Topes.** Un turno tiene como máximo 25 vueltas (`MAX_ITERACIONES`). Al llegar al tope, el backend hace una última llamada sin herramientas y le pide al modelo que responda con lo que tiene y lo que falta. También hay tope de tokens por sesión (400.000), por respuesta (8.000) y una espera máxima de 90 segundos por respuesta del proveedor.

**Confirmación humana.** El modelo no decide si la analista confirmó. `contratos_registrar` tiene el argumento `confirmado`, y ese valor lo fija el backend:

1. Un mensaje queda pendiente cuando `contratos_validar` devuelve campos en revisión (la herramienta lo anuncia con `confirmacion_pendiente`) o cuando `contratos_registrar` responde «requiere revisión». El turno sale con `needsConfirmation: true` y el front lo resalta con los botones «Confirmar registro» y «No registrar todavía»; en el panel, ese mensaje aparece como «En revisión» con cada campo y su motivo.
2. El siguiente mensaje confirma solo si la persona pulsa «Confirmar registro» o escribe una aprobación sin negaciones ni signo de pregunta («confirmo el valor 0 y la fecha fin 2027-08-31», «sí, adelante»). La lista de palabras es estricta a propósito: «registra lo que esté limpio» o «no registres nada dudoso» no confirman nada.
3. La confirmación vale solo para los mensajes que quedaron pendientes, se gasta en cuanto cada uno se registra y se pierde si el turno siguiente no la usa.

Si el modelo intenta registrar sin confirmación, aunque mande `confirmado: true`, la herramienta recibe `false` y responde «requiere revisión: …». Las pruebas de `tests/ciclo.test.ts` cubren estos casos con un modelo de guion.

**Las correcciones también se confirman.** `contratos_validar` y `contratos_registrar` vuelven a extraer el documento en cada llamada; los valores que manda el modelo en `contrato` se comparan con esa extracción, y todo campo distinto cuenta como corrección de la analista y va a revisión. Así el modelo no puede cambiar un valor en silencio: si lo cambia, el registro exige confirmación, y el historial guarda `campos_corregidos` y `campos_confirmados`.

**Errores.** Las herramientas nunca lanzan: devuelven `{ ok: false, error }` con un mensaje claro (mensaje inexistente, contrato vacío, moneda desconocida, fecha imposible), y el lote sigue con el siguiente mensaje. Un error del proveedor del modelo (espera agotada, clave rechazada, sin crédito, límite de solicitudes) se muestra en el chat en lenguaje claro y la sesión sigue viva.

**Consumo.** En cada respuesta, OpenRouter informa los tokens de entrada (y cuántos salieron de la caché), los de salida (y cuántos fueron de razonamiento), el modelo y el proveedor que respondieron, y lo que costó la entrada y la salida por separado. El ciclo suma las llamadas de cada turno y la API lo devuelve en `consumo`; la consola de la interfaz lo muestra por interacción y en total.

## 4. Elección del modelo

| | |
|---|---|
| Proveedor | OpenRouter (API de chat con herramientas) |
| Modelo | `anthropic/claude-sonnet-5.5` |
| Precio | USD 2 por millón de tokens de entrada y USD 10 por millón de salida; lo leído de la caché cuesta el 10 % |

Se eligió Claude Sonnet 5.5 porque aquí el modelo orquesta: decide el orden de las herramientas, presenta los resultados y conversa la revisión. La extracción, la confianza, la clasificación y las fechas las resuelven las herramientas, así que no hace falta el modelo más caro. Cuesta la mitad que Claude Opus 5.5 en OpenRouter (USD 4 y 20). OpenRouter permite cambiar de modelo con la variable `LLM_MODELO`, sin tocar código, y cada petición activa la caché automática, así que cada vuelta del turno vuelve a leer lo ya enviado al 10 % del precio.

**Costo por caso:** pendiente de medir con el modelo real (el prompt de ejemplo de la sección 11 del PRD y la confirmación de `msg-006`), con las cifras que informa OpenRouter en cada respuesta.

## 5. Estrategia de extracción

La extracción es determinista: expresiones regulares y reglas sobre el texto de `contrato.txt`. El mismo documento da siempre los mismos valores y la misma confianza, funciona en `demo.ts` sin modelo y cada número se puede explicar. El modelo no extrae: lee el resultado, lo presenta y conversa la revisión.

**Cómo se encuentra cada dato:**

| Dato | Cómo se encuentra |
|---|---|
| Tipo de documento | Primera línea: «CONTRATO», «CONTRATO MARCO» u «OTROSÍ». Un adjunto que no empieza así (la cotización de `msg-005`) no es contrato |
| Número | «No. CT-2026-015» en el título; en un otrosí, el número del contrato que modifica |
| Partes | En el encabezado, cada razón social seguida de su NIT, RUC o RTN; el cliente es la parte que no es Periferia (NIT 900123456). El nombre con mayúsculas y minúsculas sale del bloque de firmas |
| Identificador y país | NIT sin puntos ni dígito de verificación. El país sale de la forma del identificador (NIT → CO, RUC de 13 dígitos terminado en 001 → EC, RUC de 11 → PE, RTN → HN) y se contrasta con el domicilio (país o ciudad) |
| Objeto | Cláusula «OBJETO», sin la fórmula «EL CONTRATISTA se obliga a…», recortada a 200 caracteres |
| Valor y moneda | Cláusula «VALOR»: la cifra entre paréntesis (acepta «265.000.000» y «120,000.00») y el valor en letras («DOSCIENTOS SESENTA Y CINCO MILLONES»), que se convierte a número para comprobar la cifra. La moneda, por el código y por el nombre en letras |
| Plazo | Cláusula «PLAZO»: fechas escritas como «quince (15) de agosto de 2026» después de «desde» y de «hasta», y el plazo en meses para comprobarlas. Si el plazo corre «desde la firma», se toma la fecha de firma del cierre del documento |
| Póliza | Cláusula de garantías: si exige póliza, de qué tipos (cumplimiento, calidad, responsabilidad civil…) y si es condicional. El correo del comercial («requiere póliza», «no pide póliza») se usa para contrastar |
| Otrosí | Solo la identificación y el texto nuevo de cada «Modificar la cláusula … (PLAZO)»; lo demás se conserva del maestro. Si dice que las garantías deben ampliarse, la póliza pasa a pendiente |

**Cómo se calcula la confianza.** Cada campo trae una confianza de 0 a 1 según cómo se obtuvo:

| Situación | Confianza |
|---|---|
| Explícito y comprobado por otra parte del documento (cifra = letras, fechas = plazo, país del identificador = domicilio, póliza = correo) | 0,97–0,99 |
| Explícito, sin otra fuente que lo compruebe | 0,85–0,95 |
| Deducido (moneda de otra cláusula, país solo por el domicilio) | 0,70–0,85 |
| Valor por demanda (se registra 0), póliza condicional | 0,60 |
| Plazo desde una firma que no dice el día; fuentes que se contradicen | 0,40 |
| No aparece en el texto | 0 (valor `null`, nunca inventado) |

Todo campo por debajo de 0,8 va a revisión (RN5). Una prueba cambia la cifra de `msg-001` para que no cuadre con las letras y comprueba que la confianza baja a 0,4 y el campo pasa a revisión.

**Dónde entra el modelo y dónde no.** El modelo decide qué herramienta llamar, resume, arma la tabla por mensaje y conversa la revisión. No calcula fechas, no convierte montos y no clasifica. Si la analista corrige un dato en el chat, el modelo lo pasa a `contratos_validar`, la herramienta lo valida (formato, moneda, fecha real) y lo marca como corrección, y solo se registra con la confirmación que controla el backend.

**Resultado con los seis mensajes (tabla 7.4 del PRD):**

| Mensaje | Esperado | Resultado |
|---|---|---|
| `msg-001` | nuevo, registrado, póliza pendiente | Nuevo, CT-2026-015 insertado con póliza de cumplimiento pendiente |
| `msg-002` | nuevo, registrado, no aplica | Nuevo, CT-2026-016 insertado (USD 120.000, Ecuador), póliza no_aplica |
| `msg-003` | actualización, fila modificada, historial | Actualización de CT-2026-011: fecha fin 2027-05-01 → 2027-11-01, valor 350.000 → 520.000 PEN y póliza vigente → pendiente |
| `msg-004` | duplicado, sin escritura | Duplicado de CT-2026-012: no se escribe nada |
| `msg-005` | rechazado | Rechazado: el adjunto es una cotización |
| `msg-006` | nuevo con revisión (valor, fecha_fin); no se registra hasta confirmar | Nuevo con revisión de valor, fecha_inicio, fecha_fin y requiere_poliza; se registra como CM-2026-03 tras la confirmación |

## 6. Regla de gobierno

**Propósito.** Que todo contrato que firme Periferia, con o sin póliza, quede en el maestro y archivado en los tres días hábiles siguientes a su firma, aunque cambien las personas.

1. **Canal único.** Todo documento contractual se envía a `contratos@periferia-ficticia.com`. Lo administra la analista administrativa, dueña del maestro, con el jefe administrativo como suplente en vacaciones o ausencias. El agente procesa el buzón; la analista confirma lo que queda en revisión. Ninguna otra dirección ni persona cuenta como entrega.
2. **Obligación del comercial.** El comercial dueño de la cuenta envía el PDF firmado por las dos partes de todo contrato (con o sin póliza), los otrosíes, las actas de inicio, de terminación y de liquidación, y las pólizas constituidas, a más tardar **tres días hábiles después de la firma**. Asunto: `[CONTRATO|OTROSI|ACTA|POLIZA] <número> - <cliente> - <NIT>`. Un contrato que no esté en el maestro no se factura: facturación lo verifica antes de emitir la primera factura de cada contrato.
3. **Acuse automático.** Al procesar cada mensaje, el agente responde al remitente con la clasificación (nuevo, actualización, duplicado o rechazado), los datos que quedaron en el maestro y lo que falta. Si algo quedó en revisión, el acuse lo dice y la analista lo resuelve en un día hábil. Meta: acuse en menos de una hora hábil desde que llega el correo.
4. **Excepciones y escalamiento.**
   - Contrato sin firmar o sin la firma de una parte: no se registra; el acuse lo devuelve al comercial.
   - Contrato sin valor (marco o por demanda): se registra con valor 0 e indeterminado, previa confirmación de la analista; cada orden de servicio que lo concrete se envía como documento contractual.
   - Remitente que no está en el catálogo de comerciales: se registra igual y el acuse pide identificar al comercial responsable; la analista lo actualiza en el catálogo.
   - Póliza exigida y no recibida a los 15 días de la firma: la analista escala al director comercial de la región; a los 30 días, al gerente administrativo.
   - Dudas sobre cláusulas (no hay área legal interna): la analista las remite al abogado externo con el contrato archivado; el registro no espera esa revisión.
5. **Cierre del hueco de junio a agosto de 2026, en una sola campaña de dos semanas.**
   - Semana 1: facturación extrae los clientes y contratos facturados entre junio y agosto; se cruzan con el maestro y sale una lista de faltantes por comercial.
   - Cada comercial reenvía sus contratos al buzón con el asunto marcado `[CIERRE]`; el agente los procesa por lotes y los duplicados no ensucian el maestro.
   - Semana 2: la analista resuelve lo que quedó en revisión y escala lo que no llegó. La campaña cierra cuando todo contrato facturado en el periodo está en el maestro.
6. **Indicador mensual.** Porcentaje de contratos facturados en el mes que existen en el maestro. Meta: 98 % o más. Lo acompañan dos lecturas: la mediana de días entre la firma y el registro (meta: tres días hábiles o menos) y el número de pólizas pendientes con más de 15 días.

## 7. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Extracción determinista con reglas sobre el texto | Que el modelo extraiga los campos y diga su confianza | Da lo mismo en cada ejecución, corre en `demo.ts` sin clave y cada confianza tiene una razón escrita. Una confianza que reporta el propio modelo no se puede auditar. El costo: un formato de contrato muy distinto exige agregar reglas |
| Validar y registrar vuelven a extraer el documento; lo que manda el modelo es una corrección | Confiar en el `contrato` que devuelve el modelo | El modelo no puede cambiar un valor en silencio: cualquier diferencia va a revisión y exige confirmación (el riesgo que señala el PRD en la sección 10) |
| El backend fija `confirmado`, por mensaje | Confiar en que el prompt le prohíba al modelo registrar lo dudoso | Un prompt no es una garantía; así, registrar sin confirmación es imposible por diseño |
| En `msg-006` también van a revisión la fecha de inicio y la póliza, no solo el valor y la fecha final | Marcar solo los dos campos de la tabla 7.4 | El inicio sale de la misma firma sin día que la fecha final, y la póliza solo se exige a órdenes de más de COP 100 millones: registrarla como «sí» o «no» sin preguntar sería afirmar algo que el texto no dice |
| Para un plazo desde una firma sin día se propone el primer día del mes | El último día del mes o la fecha del correo | Da el vencimiento más temprano posible, así que la alerta llega antes y no después; la confianza baja (0,4) obliga a confirmarlo |
| El otrosí que pide ampliar las garantías deja la póliza en pendiente | Conservar «vigente» | La póliza vigente cubre el plazo anterior; mientras no llegue la ampliación, el contrato queda descubierto en el tramo nuevo, que es justo el riesgo que el reporte debe mostrar |
| Similitud de objeto con trigramas de caracteres (coeficiente de Dice) | Similitud por palabras o con el modelo | Tolera tildes, plurales y conjugaciones («implementación» e «implementar» comparten trigramas) y es determinista. Con los fixtures, el mismo NIT con otro objeto (Industrias Delta, Corporación Andina, Distribuidora Caribe) queda por debajo de 0,9 y se registra como nuevo, no como actualización |
| `contratos_registrar` también deja constancia de duplicados y rechazos en `out/procesados.json` | Que solo escriba los registrables | Así el mensaje sale del buzón y no se vuelve a procesar; el maestro y el historial solo cambian con altas y actualizaciones |
| Un solo archivo de herramientas autocontenido | Partirlo en varios módulos | El módulo reutilizable copia ese archivo tal cual; con varios archivos habría que copiar una carpeta y la plataforma podría registrar los auxiliares como herramientas |
| Front en HTML, CSS y JavaScript sin dependencias, sobre la base del reto 01 | React u otro marco | Un solo comando levanta todo, no hay paso de compilación y hay menos piezas que explicar. El Markdown del chat se escapa antes de pintarse |

## 8. Supuestos

- La «fecha de hoy» del chat es la de Bogotá y va en el prompt de cada sesión; `demo.ts` usa la fija 2026-09-03, la del prompt de ejemplo del PRD, para ser determinista. `contratos_registrar` acepta `hoy` para fijar la fecha de registro.
- Los fixtures traen el contrato ya extraído en `.txt`, así que se archiva como `.txt`; con un PDF real se archivaría el PDF.
- «Registrados desde el 2026-05-30» incluye ese día (`fecha_registro ≥ 2026-05-30`).
- Un contrato que exige póliza entra con la póliza en **pendiente**, porque el PRD lo pide así para todo registro nuevo, aunque el comercial ya la esté gestionando.
- El remitente que no está en `comerciales.json` (`msg-006`) se registra con el comercial vacío, se informa y no bloquea, como pide HU-3.
- En `msg-006`, la analista confirma el valor 0 y corrige la fecha final a 2027-08-31, como en el ejemplo de la sección 11 del PRD; la fecha de inicio propuesta (2026-08-01) y la póliza condicional se registran tal como se propusieron, porque la confirmación cubre todos los campos que quedaron en revisión.
- Los contratos del maestro que ya vencieron (CT-2025-018 y CT-2026-002) se listan aparte dentro de la sección de vencimientos: no vencen «en 60 días o menos», pero la gerencia necesita saber que siguen en el maestro sin otrosí de prórroga.
- La ruta de archivo de un contrato actualizado por otrosí se conserva; el otrosí queda archivado al lado como `<contrato>-otrosi-<n>.txt` y su ruta va en el historial.
- Un otrosí de un contrato que no está en el maestro se rechaza, porque no hay fila que actualizar.
- Las sesiones viven en memoria: si el servidor se reinicia, se pierden. El estado del buzón y del maestro vive en `out/`.

## 9. Cobertura

| Historia | Estado | Detalle |
|---|---|---|
| HU-1 Leer el buzón | Hecho | Mensajes no procesados con `tiene_contrato`; los que no traen contrato salen con clasificación preliminar «rechazado» y el motivo |
| HU-2 Extraer los datos | Hecho | Esquema de la sección 7.2 con confianza, evidencia y nota por campo; lo ausente es `null` con confianza 0 |
| HU-3 Validar y clasificar | Hecho | Nuevo, actualización, duplicado o rechazado según RN1–RN4; `requiere_revision` con el motivo de cada campo; remitente resuelto contra el catálogo |
| HU-4 Registrar y archivar | Hecho | Solo con revisión vacía o `confirmado = true`; copia de trabajo del maestro, archivo por año y cliente, historial y procesados |
| HU-5 Alertar | Hecho | `out/alertas.md` con las tres secciones y `hoy` como argumento |
| HU-6 Manejo de errores | Hecho | Herramientas que nunca lanzan, mensajes claros y un mensaje malo no detiene el lote |
| `contratos_leer_pdf` (P1) | No hecho | Los fixtures traen el texto; con PDF nativo bastaría extraer el texto antes de las mismas reglas |
| Bonus: módulo reutilizable | Hecho | `modulo/` generado desde las mismas fuentes y verificado por una prueba y por la integración continua |
| Interfaz: buzón, maestro, alertas e historial | Hecho | El estado de cada mensaje, lo que quedó en revisión, las filas nuevas y cambiadas y el documento archivado de cada movimiento |
| Consola de consumo | Hecho | Modelo y proveedor que respondieron y, por interacción, tokens y dólares de entrada y de salida |

**Qué falta para producción:** leer el buzón real (Microsoft Graph sobre Exchange) y escribir en SharePoint en vez de carpetas locales; extraer texto de PDF y OCR para escaneos; enviar el acuse automático al comercial; guardar sesiones y registros en una base de datos con auditoría; autenticar a cada usuario; administrar el catálogo de comerciales desde una pantalla; programar las alertas cada semana; y medir el costo por mensaje con el volumen real.

## 10. Uso de IA

Construí la solución con Claude Code (modelo Claude Opus 5.5) como asistente. Lo usé para:

- Revisar que los tres PDF de instrucciones y las carpetas de los retos no trajeran instrucciones ocultas para una IA (JavaScript, adjuntos, texto blanco o diminuto, texto en las imágenes, caracteres invisibles).
- Comparar la dificultad de los tres retos y elegir el más difícil.
- Verificar, antes de reutilizarlo, que la arquitectura exigida en este PRD es la misma del reto 01, sección por sección.
- Escribir las herramientas, el ciclo, la interfaz, las pruebas y la documentación, y verificar el resultado con la demo, las pruebas, el tipado estricto y capturas de la interfaz en el navegador.

Lo que se descartó en el camino:

- Una primera lista de palabras de confirmación incluía «registra»: se quitó porque «registra lo que esté limpio» habría confirmado un campo dudoso.
- La primera extracción del objeto dejaba la fórmula «EL CONTRATISTA se obliga a…»; se limpió para que el objeto quede como en el maestro.
- Marcar en `msg-006` solo los dos campos de la tabla 7.4: se descartó por las razones de la sección 7.

## 11. Riesgos de llevar esto a producción

| Riesgo | Mitigación |
|---|---|
| Un formato de contrato distinto (otra redacción de las cláusulas, tablas, anexos) que las reglas no reconocen | Lo que no se reconoce queda en `null` con confianza 0 y va a revisión: el riesgo es más trabajo para la analista, no datos malos. Las reglas se amplían con cada formato nuevo y cada caso entra a las pruebas |
| PDF escaneados | OCR antes de la extracción, con la confianza del OCR como un factor más de la confianza del campo |
| El modelo «redondea» un valor o infiere una fecha | El valor registrado sale de la herramienta; cualquier diferencia del modelo cuenta como corrección y exige confirmación |
| Un correo trae instrucciones para el agente (inyección de prompt) | El prompt trata correos y contratos como datos; las herramientas no ejecutan órdenes y nada dudoso se registra sin la confirmación que controla el backend |
| Falsos duplicados por variaciones en el nombre del cliente | La comparación es por número de contrato y por NIT, nunca por nombre |
| Los comerciales no envían los contratos | Es un problema de proceso: lo resuelve la regla de gobierno, con el control en facturación y el indicador mensual |
| Datos de clientes en lugares indebidos | Los registros guardan resúmenes, la clave del modelo solo vive en el backend y el link tiene clave de acceso |
| Costo sin control | Topes de vueltas por turno, de tokens por sesión y por respuesta, caché de prompt, clave de acceso al link y límite de crédito en la clave de OpenRouter |
| Caída o cambio del proveedor del modelo | El adaptador permite cambiar de proveedor o de modelo sin tocar el ciclo, y la demo y el registro funcionan sin modelo |
