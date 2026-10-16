// Provider taxonomy (matches ACECQA PA06 + council-run split for planners).
export type ProviderType =
  | 'for-profit'
  | 'nfp-community'   // community-managed, no profit distribution
  | 'nfp-other'       // other not-for-profit (incl. Ltd by guarantee, faith-based)
  | 'govt-local'      // council-run: city/shire/municipal
  | 'govt-state'      // state/territory managed: departments, directorates
  | 'unknown';

const KNOWN_NFP = /goodstart|ku |thrive|communities@work|uniting|ymca|ywca|lady gowrie|creche and kindergarten|\bsdn\b|benevolent|mission australia|save the children|anglicare|baptcare|wesley/;

export function classifyProvider(legalName: string): { t: ProviderType; conf: number } {
  const n = (legalName || '').toLowerCase();
  if (!n) return { t: 'unknown', conf: 0 };
  // Government first — explicit strings only, never collide with company names.
  if (/city council|shire council|shire of|municipal|city of |district council|borough council|council of |local government/.test(n))
    return { t: 'govt-local', conf: 0.9 };
  if (/department for education|department of education|education directorate|director-general|state of |northern territory/.test(n))
    return { t: 'govt-state', conf: 0.9 };
  // For-profit second: Pty Ltd / Trust catches "Guardian Community ... Pty Ltd"
  // which a community-keyword-first order mislabels as NFP.
  if (/pty ltd|pty\.|pty limited|\btrust\b|enterprises|holdings|investments|childcare.*pty|early learning.*pty/.test(n))
    return { t: 'for-profit', conf: 0.8 };
  if (KNOWN_NFP.test(n))
    return { t: 'nfp-other', conf: 0.8 };
  if (/\binc\b|incorporated|association|community|co-operative|cooperative|committee|playgroup|parents/.test(n))
    return { t: 'nfp-community', conf: 0.78 };
  if (/church|catholic|uniting|ymca|ywca|lutheran|anglican|baptist|presbyterian|thrive group|mission|salvation|st vincent|benevolent|charity|foundation|society|brotherhood|diocese|archdiocese/.test(n))
    return { t: 'nfp-other', conf: 0.75 };
  // Bare Ltd/Limited (e.g. G8 Education Limited, ASX-listed) defaults for-profit;
  // genuine NFP companies limited by guarantee are caught by the keyword sets above.
  if (/\bltd\b|\blimited\b/.test(n)) return { t: 'for-profit', conf: 0.55 };
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
