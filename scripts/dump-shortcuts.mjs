// Dump every registerShortcut() registration as a markdown table (README source of truth).
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'

const files = execFileSync('git', ['ls-files', 'src/renderer'])
  .toString()
  .trim()
  .split('\n')
  .filter((file) => file.endsWith('.tsx') || file.endsWith('.ts'))
const rows = []
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const re = /registerShortcut\('([^']+)',\s*\{\s*combo: '([^']+)',\s*description: '([^']+)'/g
  let match
  while ((match = re.exec(text)) !== null) {
    rows.push({ combo: match[2], desc: match[3] })
  }
}
// the same binding may register from mutually-exclusive components (e.g.
// shift+f in both viewer modes) — one table row
const unique = new Map(rows.map((row) => [`${row.combo}|${row.desc}`, row]))
rows.length = 0
rows.push(...unique.values())
rows.sort((a, b) => a.combo.localeCompare(b.combo))
console.log(`count: ${rows.length}`)
for (const row of rows) console.log(`| \`${row.combo}\` | ${row.desc} |`)
