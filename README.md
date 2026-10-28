# Reto 02 · Agente «Registro de Contratos Vigentes»

Agente conversacional que actúa como punto único de recepción de contratos de Periferia IT Group. Lee los correos del buzón, extrae los datos del contrato adjunto con su nivel de confianza y detecta si es nuevo, una actualización (otrosí) o un duplicado. Lo registra en el maestro y archiva el documento. Lo dudoso no se registra hasta que la analista lo confirma. Al final genera el reporte de alertas de vencimientos y pólizas.

La interfaz tiene tres partes:

- **Chat con el agente**, con cada paso que da (herramienta, argumentos y resultado) y la confirmación resaltada cuando algo queda en revisión.
- **Registro**, con cuatro pestañas:
  - **Buzón:** el estado de cada mensaje y lo que quedó en revisión, campo por campo.
  - **Maestro:** las filas nuevas y las actualizadas, con el campo que cambió.
  - **Alertas:** el reporte de vencimientos y pólizas.
  - **Historial:** cada alta y actualización con su documento archivado.

  «Reiniciar buzón» deja todo como al principio para repetir la demo.
- **Consola de consumo**, en fondo negro, con el modelo que respondió y, por cada interacción, los tokens y los dólares de entrada y de salida.

- **Link de prueba:** https://reto-02-periferia.onrender.com
- **Clave de acceso al link y `.env` para correrlo en local:** se entregan aparte, por correo.
- **Planteamiento de la solución:** [SOLUCION.md](SOLUCION.md).

## Levantar en local

Requiere [Bun](https://bun.sh) 1.4 o superior.

```bash
bun install
cp .env.example .env    # y escribe OPENROUTER_API_KEY
bun run dev             # front y backend en http://localhost:3000
```

## Verificación sin modelo

```bash
bun install && bun run demo.ts
```

Procesa los 6 mensajes de `fixtures/reto-02/buzon/` en orden, llamando directamente a las herramientas, e imprime por mensaje la clasificación, los campos en revisión y la acción tomada. `msg-006` queda sin registrar en la primera pasada. Después la demo muestra la segunda llamada con `confirmado: true`, con la corrección de la fecha final, y un tercer intento que no duplica nada. Termina con las alertas al 2026-09-03 y deja todo en `out/`. No necesita ninguna clave y da lo mismo en cada ejecución (salvo las horas de los registros).

## Variables de entorno

| Variable | Obligatoria | Uso |
|---|---|---|
| `OPENROUTER_API_KEY` | Para el chat | Clave de OpenRouter. Solo vive en el backend. |
| `LLM_MODELO` | No | Modelo en OpenRouter. Por defecto, `anthropic/claude-sonnet-5.5`. |
| `LLM_ESFUERZO` | No | Esfuerzo de razonamiento: `low`, `medium` o `high`. Vacío deja el del proveedor. |
| `CLAVE_ACCESO` | No | Si se define, el chat pide esta clave antes de hablar con el agente. |
| `MAX_ITERACIONES` | No | Tope de vueltas modelo → herramientas por turno (25). |
| `MAX_TOKENS_SESION` | No | Tope de tokens por sesión (400.000). |
| `LLM_MAX_TOKENS` | No | Tope de tokens por respuesta del modelo (8.000). |
| `LLM_TIMEOUT_MS` | No | Espera máxima por respuesta del proveedor (90.000 ms). |
| `PORT` | No | Puerto del servidor (3000). |

## Herramientas

| Herramienta | Entrada | Qué hace |
|---|---|---|
| `contratos_leer_buzon` | `{}` | Mensajes no procesados, con sus adjuntos y si traen contrato u otrosí |
| `contratos_extraer` | `{ mensaje_id }` | Datos del contrato con confianza, evidencia y nota por campo, y los `valores` para las siguientes herramientas |
| `contratos_validar` | `{ mensaje_id, contrato? }` | Nuevo, actualización, duplicado o rechazado; campos en revisión con su motivo; diferencias con el maestro y la fila que se escribiría |
| `contratos_registrar` | `{ mensaje_id, contrato?, confirmado?, hoy? }` | Inserta o actualiza la fila, archiva el documento, escribe el historial y marca el mensaje como procesado; sin confirmación responde «requiere revisión: …» |
| `contratos_alertas` | `{ hoy }` | `out/alertas.md` con vencimientos a 60 días, pólizas pendientes y lo registrado desde el corte |

## API

| Método | Ruta | Cuerpo y respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message, confirmar? }` → `{ reply, toolCalls[], needsConfirmation, consumo }` |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión |
| `GET` | `/api/health` | `{ ok: true, provider, model, acceso }`, sin claves |
| `GET` | `/api/buzon` | Mensajes del buzón con su estado (pendiente o lo que hizo el registro) |
| `GET` | `/api/buzon/:mensaje/adjuntos/:nombre` | Texto de un adjunto que el correo lista |
| `GET` | `/api/maestro` | El maestro de `out/sharepoint/` (o el congelado) con las filas que tocó el agente |
| `GET` | `/api/historial` | Las entradas de `out/sharepoint/historial.jsonl` |
| `GET` | `/api/alertas` | El contenido de `out/alertas.md` |
| `GET` | `/api/archivo?ruta=out/…` | Un archivo de `out/` (nunca de otra carpeta) |
| `POST` | `/api/reiniciar` | `{ sessionId? }` → borra `out/` y deja el buzón como al principio |

Si `CLAVE_ACCESO` está definida, todas las rutas de `/api/` menos `/api/health` exigen la cabecera `x-clave-acceso`. `confirmar: true` es lo que envía el botón «Confirmar registro» del chat. `consumo` trae, por turno, el modelo y el proveedor que respondieron, las llamadas, la duración y los tokens y dólares de entrada y de salida que informa OpenRouter.

## Comandos

| Comando | Qué hace |
|---|---|
| `bun run dev` | Levanta front y backend con recarga automática |
| `bun run start` | Levanta front y backend |
| `bun run demo.ts` | Verificación sin modelo |
| `bun test` | Pruebas de herramientas, ciclo del agente, rutas HTTP y módulo |
| `bun run typecheck` | Revisión de tipos (TypeScript estricto, sin `any`) |
| `bun run modulo` | Regenera `modulo/` desde las fuentes de la aplicación |
| `bun run modulo --verificar` | Falla si `modulo/` no coincide con las fuentes |

## Estructura

```
agent/prompt.md                      comportamiento: el prompt de sistema
src/knowledge/registro-contratos.md  conocimiento del proceso
src/tools/contratos.ts               ejecución: las cinco herramientas (zod), con la extracción determinista
src/agente/                          ciclo del agente, confirmación por mensaje, sesiones y registro de herramientas
src/llm/adapter.ts                   interfaz propia con el proveedor del modelo
src/llm/openrouter.ts                implementación para OpenRouter
src/http/app.ts                      rutas HTTP (API del chat y de la interfaz)
src/buzon.ts                         lectura de buzón, maestro, historial y alertas para la interfaz
src/server.ts                        arranque del servidor
web/                                 front sin dependencias: chat, registro, visor y consola
modulo/                              bonus: el agente empaquetado para otras plataformas
fixtures/                            datos entregados por Periferia (solo lectura)
demo.ts                              verificación sin modelo
tests/                               pruebas con bun test
```

## Despliegue

El repositorio incluye `Dockerfile` y `render.yaml`. En Render: New → Blueprint → este repositorio, y completar `OPENROUTER_API_KEY` y `CLAVE_ACCESO` cuando los pida. El plan gratis se duerme cuando nadie lo usa y tarda cerca de un minuto en despertar, así que conviene abrir el link un rato antes de la defensa. Su disco no es persistente: al reiniciarse el servicio, `out/` vuelve a quedar vacío, igual que con «Reiniciar buzón».

## Módulo reutilizable

`modulo/` sigue el formato de agentes de OpenCode:

- `agent.md`: frontmatter con `mode: primary` y los permisos `edit` y `bash` en `deny`; el cuerpo es el prompt.
- `tools/contratos.ts`: las mismas herramientas; en OpenCode quedan como `contratos_<export>`.
- `skill/registro-contratos/SKILL.md`: el conocimiento del proceso.

Se genera con `bun run modulo` y una prueba falla si se aparta de las fuentes de la aplicación. Las herramientas solo necesitan `zod` instalado en el proyecto que las cargue.
