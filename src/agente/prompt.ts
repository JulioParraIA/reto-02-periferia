/**
 * Arma el prompt de sistema: comportamiento (agent/prompt.md) + conocimiento del proceso
 * (src/knowledge/registro-contratos.md). Ninguno de los dos vive dentro del código.
 */
import { readFile } from "node:fs/promises"
import path from "node:path"

export async function cargarPromptSistema(raiz: string): Promise<string> {
  const comportamiento = await readFile(path.join(raiz, "agent", "prompt.md"), "utf8")
  const conocimiento = await readFile(path.join(raiz, "src", "knowledge", "registro-contratos.md"), "utf8")
  return `${comportamiento.trim()}\n\n---\n\n${conocimiento.trim()}\n`
}
