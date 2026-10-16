export type AgeGroup = '0012MN' | '1324MN' | '2535MN' | '36MNPR' | 'OVPRAG' | 'DAYVAC' | string;
export type SessionType = 'FULLDY' | 'HALFDY' | 'HOURLY' | 'BEFSCH' | 'AFTSCH';

export interface FeeRow {
  service_approval_no: string; // short SE-000XXXXX
  startingblocks_ulid: string;
  service_name: string;
  provider_approval_no: string;
  provider_name: string;
  age_group: AgeGroup;
  session_type: SessionType;
  fee: number | null;
  inclusions: string[];
  fee_last_updated: string | null;
  has_vacancy: boolean;
  source_url: string;
  fetched_at: string;
}

export const AGE_LABEL: Record<string, string> = {
  '0012MN': '0-12 months',
  '1324MN': '13-24 months',
  '2535MN': '25-35 months',
  '36MNPR': '36 months+ to preschool',
  OVPRAG: 'Outside school hours',
  DAYVAC: 'Vacation care',
};

export const SESSION_LABEL: Record<string, string> = {
  FULLDY: 'Full day session',
  HALFDY: 'Half day session',
  HOURLY: 'Hourly',
  BEFSCH: 'Before school',
  AFTSCH: 'After school',
};
