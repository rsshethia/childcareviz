const UA = 'Mozilla/5.0 (childcareviz research; contact: admin) AppleWebKit/537.36';

export async function fetchText(url: string, timeoutMs = 30000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

export async function fetchSitemapUrls(): Promise<string[]> {
  const xml = await fetchText('https://startingblocks.gov.au/sitemap.xml');
  const urls: string[] = [];
  const re = /<loc>([^<]*)<\/loc>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const loc = m[1].replace('http://localhost:3000', 'https://startingblocks.gov.au');
    if (loc.includes('/find-child-care/') && loc.split('/').length > 5) urls.push(loc);
  }
  return [...new Set(urls)];
}

export function ulidFromUrl(url: string): string {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  return parts[1] ?? '';
}
