import { readFileSync, writeFileSync } from 'node:fs'

const [tag, output] = process.argv.slice(2)
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
if (tag !== `v${pkg.version}`) throw new Error('Tag must match package.json version.')
if (pkg.repository.url.includes('TODO')) throw new Error('Set the repository URL before publishing.')
const sections = readFileSync('CHANGELOG.md', 'utf8').split(/^## /m)
const section = sections.find(s => s.startsWith(`[${pkg.version}]`))
if (!section) throw new Error(`No CHANGELOG section for ${pkg.version}.`)
const notes = section.slice(section.indexOf('\n') + 1).trim()
if (!notes) throw new Error('Release notes are empty.')
writeFileSync(output, notes + '\n')
