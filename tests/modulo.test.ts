import { expect, test } from "bun:test"
import { diferencias } from "../scripts/modulo.ts"

test("modulo/ usa exactamente el mismo prompt, herramientas y conocimiento que la aplicación", async () => {
  expect(await diferencias()).toEqual([])
})
