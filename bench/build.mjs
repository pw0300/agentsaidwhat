import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
export async function load(name) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  await mkdir(new URL('../node_modules/.tmp/', import.meta.url), { recursive: true })
  const outfile = fileURLToPath(new URL(`../node_modules/.tmp/faultbench-${name}.mjs`, import.meta.url))
  await build({ absWorkingDir: root, entryPoints: [`bench/${name}.ts`], bundle: true, platform: 'node', format: 'esm', outfile })
  return import(new URL(`../node_modules/.tmp/faultbench-${name}.mjs`, import.meta.url))
}
