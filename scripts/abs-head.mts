import XLSX from 'xlsx';
const wb = XLSX.readFile('data/abs/32350DS0001_2025.xlsx', { sheetRows: 20 });
for (const sn of ['Table 1', 'Table 3']) {
  const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' });
  console.log('===', sn);
  rows.forEach((r, i) => console.log(String(i).padStart(2), JSON.stringify(r)));
}
