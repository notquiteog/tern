// RFC 4180 CSV parser with delimiter sniffing. Handles quoted fields with
// embedded delimiters, quotes and newlines, CRLF and a UTF-8 BOM, which is
// exactly the set of things every exported "customer list" gets wrong.
export interface ParsedCsv { headers: string[]; rows: string[][]; delimiter: string }

export function sniffDelimiter(sample: string): string {
  const candidates = [',', ';', '\t', '|'];
  const firstLines = sample.split(/\r?\n/).slice(0, 5).filter(Boolean);
  let best = ',', bestScore = -1;
  for (const d of candidates) {
    const counts = firstLines.map((l) => l.split(d).length - 1);
    const min = Math.min(...counts), max = Math.max(...counts);
    const score = min > 0 && min === max ? min * 10 : min;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

export function parseCsv(text: string, delimiter?: string, maxRows = Infinity): ParsedCsv {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const d = delimiter ?? sniffDelimiter(text.slice(0, 5000));
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === d) { row.push(field); field = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      if (rows.length > maxRows) break;
      continue;
    }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((c) => c.trim() !== '')) rows.push(row); }
  const headers = (rows.shift() ?? []).map((h) => h.trim());
  return { headers, rows, delimiter: d };
}

export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n') + '\r\n';
}

// Guess which header holds which contact field.
export function guessMapping(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
  const rules: [string, RegExp][] = [
    ['email', /^(e?mail|emailaddress|email_address|primaryemail|workemail)$/],
    ['first_name', /^(firstname|first|givenname|fname|forename)$/],
    ['last_name', /^(lastname|last|surname|familyname|lname)$/],
    ['full_name', /^(name|fullname|contact|contactname)$/],
    ['company', /^(company|companyname|organization|organisation|org|employer|account)$/],
    ['title', /^(title|jobtitle|position|role)$/],
    ['phone', /^(phone|phonenumber|mobile|tel|telephone|cell)$/],
    ['website', /^(website|url|site|domain|web)$/],
    ['tags', /^(tags?|labels?|segment|list)$/],
    ['notes', /^(notes?|comments?|remarks?)$/],
  ];
  for (const h of headers) {
    const n = norm(h);
    for (const [field, re] of rules) {
      if (re.test(n) && !Object.values(map).includes(h)) { map[field] = h; break; }
    }
  }
  return map;
}
