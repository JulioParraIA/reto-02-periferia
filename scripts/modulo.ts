/**
 * Empaqueta el agente como módulo reutilizable (bonus, sección 9.4 del PRD) desde las mismas
 * fuentes que usa la aplicación, para que nunca haya copias divergentes:
 *   agent/prompt.md               → modulo/agent.md (con frontmatter)
 *   src/tools/contratos.ts        → modulo/tools/contratos.ts (copia exacta)
 *   src/knowledge/*.md            → modulo/skill/registro-contratos/SKILL.md (con frontmatter)
 *
 *   bun run modulo              regenera modulo/
 *   bun run modulo --verificar  falla si modulo/ no coincide con las fuentes
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const RAIZ = path.resolve(import.meta.dir, "..")

const FRONTMATTER_AGENTE = `---
description: Punto único de recepción de contratos de Periferia IT Group; lee el buzón, extrae los datos con su confianza, detecta nuevos, actualizaciones y duplicados, alimenta el maestro y genera las alertas, sin registrar nada dudoso sin confirmación.
mode: primary
permission:
  edit: deny
  bash: deny
---

`

const FRONTMATTER_SKILL = `---
name: registro-contratos
description: Reglas del registro de contratos vigentes de Periferia (clasificación nuevo, actualización, duplicado o rechazado; confianza y revisión humana; otrosíes; pólizas; alertas). Úsala al procesar el buzón de contratos.
---

`

/** Git en Windows puede cambiar los finales de línea; se comparan siempre como \n. */
function normalizar(texto: string): string {
  return texto.replace(/\r\n/g, "\n")
}

export async function construirModulo(raiz = RAIZ): Promise<Map<string, string>> {
  const leer = async (...partes: string[]) => normalizar(await readFile(path.join(raiz, ...partes), "utf8"))
  return new Map([
    ["modulo/agent.md", FRONTMATTER_AGENTE + (await leer("agent", "prompt.md"))],
    ["modulo/tools/contratos.ts", await leer("src", "tools", "contratos.ts")],
    ["modulo/skill/registro-contratos/SKILL.md", FRONTMATTER_SKILL + (await leer("src", "knowledge", "registro-contratos.md"))],
  ])
}

/** Archivos de modulo/ que no coinciden con lo que saldría de las fuentes. */
export async function diferencias(raiz = RAIZ): Promise<string[]> {
  const distintos: string[] = []
  for (const [ruta, esperado] of await construirModulo(raiz)) {
    const actual = await readFile(path.join(raiz, ruta), "utf8").catch(() => null)
    if (actual === null || normalizar(actual) !== esperado) distintos.push(ruta)
  }
  return distintos
}

async function main(): Promise<void> {
  if (process.argv.includes("--verificar")) {
    const distintos = await diferencias()
    if (distintos.length > 0) {
      console.error(`modulo/ no coincide con las fuentes: ${distintos.join(", ")}. Corre «bun run modulo».`)
      process.exit(1)
    }
    console.log("modulo/ coincide con agent/prompt.md, src/tools/contratos.ts y src/knowledge/.")
    return
  }
  for (const [ruta, contenido] of await construirModulo()) {
    await mkdir(path.dirname(path.join(RAIZ, ruta)), { recursive: true })
    await writeFile(path.join(RAIZ, ruta), contenido, "utf8")
    console.log(`escrito ${ruta}`)
  }
}

if (import.meta.main) await main()
