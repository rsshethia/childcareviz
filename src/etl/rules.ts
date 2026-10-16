// Pure rules shared by ETL + DB loader (no side effects on import).
export type ProviderType = 'for-profit' | 'nfp' | 'govt' | 'unknown';

export function classifyProvider(legalName: string): { t: ProviderType; conf: number } {
  const n = (legalName || '').toLowerCase();
  if (!n) return { t: 'unknown', conf: 0 };
  if (/city council|shire council|shire of|municipal|city of |district council|borough council|council of |department for education|department of education|education directorate|director-general/.test(n))
    return { t: 'govt', conf: 0.9 };
  if (/\binc\b|incorporated|association|community|church|catholic|uniting|ymca|ywca|lutheran|anglican|baptist|presbyterian|goodstart|ku children|thrive group|communities@work|crest|mission|salvation|st vincent|benevolent|charity/.test(n))
    return { t: 'nfp', conf: 0.75 };
  if (/pty ltd|pty\.|pty limited|\btrust\b|enterprises|holdings|investments|childcare.*pty|early learning.*pty/.test(n))
    return { t: 'for-profit', conf: 0.8 };
  if (/\bltd\b(?!.*pty)/.test(n)) return { t: 'nfp', conf: 0.55 };
  return { t: 'unknown', conf: 0 };
}

export function quarantineFee(session: string, fee: number | null): string | null {
  if (fee == null) return 'no-fee-reported';
  if (session === 'FULLDY' && (fee < 50 || fee > 300)) return 'fulldy-out-of-range';
  if (session === 'HOURLY' && fee > 30) return 'hourly-suspect-daily-rate';
  if ((session === 'BEFSCH' || session === 'AFTSCH') && fee > 100) return 'oshc-out-of-range';
  if (session === 'HALFDY' && (fee < 20 || fee > 200)) return 'halfdy-out-of-range';
  return null;
}

export const STALE_CUTOFF = new Date('2024-10-16T00:00:00Z');
export function isStale(lastUpdated: string | null): boolean | null {
  if (!lastUpdated) return null;
  return new Date(lastUpdated) < STALE_CUTOFF;
}
