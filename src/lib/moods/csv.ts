// Small CSV reader and writer (RFC 4180) for the gold-set sheet and the pipeline's Billboard list:
// a quoted field may hold commas, doubled quotes and line breaks; rows end in LF or CRLF. A
// spreadsheet's byte-order mark is ignored, and so are blank lines.

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.startsWith('﻿') ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (s[i + 1] === '"') field += s[++i];
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f !== ''));
}

const needsQuotes = /[",\r\n]/;

export function toCsv(rows: (string | number)[][]): string {
  const cell = (v: string | number) => {
    const t = String(v);
    return needsQuotes.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\n') + '\n';
}
