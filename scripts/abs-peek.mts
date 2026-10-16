// Peek at ABS Excel drops: sheet names, dims, first rows. Usage: npx tsx scripts/abs-peek.mts [dir]
import XLSX from 'xlsx';
import { readdirSync } from 'node:fs';
const dir = process.argv[2] || 'data/abs';
for (const f of readdirSync(dir).filter((x) => /\.xlsx?$/i.test(x))) {
  const wb = XLSX.readFile(`${dir}/${f}`, { sheetRows: 15 });
  console.log('===', f);
  for (const sn of wb.SheetNames) {
    const sh = wb.Sheets[sn];
    const rows: unknown[][] = XLSX.utils.sheet_to_json(sh, { header: 1, defval: '' });
    console.log('  sheet:', JSON.stringify(sn), 'dims:', sh['!ref']);
    rows.slice(0, 8).forEach((r) => console.log('   |', JSON.stringify((r as unknown[]).slice(0, 8))));
  }
}
