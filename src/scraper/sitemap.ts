const UA = 'Mozilla/5.0 (childcareviz research; contact: admin) AppleWebKit/537.36';

export async function fetchText(url: string, timeoutMs = 30000, hops = 0): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (hops > 3) throw new Error(`Too many redirects ${url}`);
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`HTTP ${res.status} (no location) ${url}`);
      const next = new URL(loc, url).toString();
      clearTimeout(t);
      return fetchText(next, timeoutMs, hops + 1);
    }
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
