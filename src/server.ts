// ChildCareViz web service: serves dashboard/ static + live Neon-backed JSON API.
// Render: build `npm ci && npm run build`, start `npm start` (PORT provided).
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { pool } from './db/pool.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
app.use(express.json());
app.use(express.static('dashboard'));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Public client config. Only ever exposes the *public* Mapbox token
// (restrict it to your Render domain in Mapbox Studio). Secret keys stay out.
app.get('/api/config', (_req, res) => {
  const t = process.env.MAPBOX_TOKEN || process.env.MAPBOX || null;
  res.json({ mapboxToken: t ? String(t).replace(/^['"]|['"]$/g, '') : null });
});

// National counters + quarantine split (powers Overview cards).
app.get('/api/stats', async (_req, res) => {
  try {
    const r = await pool.query(`select (select count(*) from services) as services,
      (select count(*) from providers) as providers,
      (select count(*) from service_fees_history) as fee_rows,
      (select count(distinct service_approval_no) from service_fees_history where fee is not null) as services_with_fee,
      (select count(*) from services where lat is not null) as geocoded`);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Median clean FULLDY by state x provider type (powers Pricing tab live).
app.get('/api/pricing', async (_req, res) => {
  try {
    const r = await pool.query(`select s.state, s.provider_type,
        count(*) as fee_rows,
        percentile_cont(0.5) within group (order by f.fee) as median,
        round(avg(f.fee)::numeric, 2) as mean
      from (select distinct on (service_approval_no, age_group) service_approval_no, age_group, fee
        from service_fees_history where session_type='FULLDY' and quarantine is null
        order by service_approval_no, age_group, fetched_at desc) f
      join services s on s.service_approval_no = f.service_approval_no
      group by 1, 2 order by 1, 2`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Service search (parents): text + state/type filters, clean fee + rating attached.
app.get('/api/services', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const state = String(req.query.state || '').trim();
    const type = String(req.query.type || '').trim();
    const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 200);
    const conds: string[] = [];
    const vals: unknown[] = [];
    if (q) { vals.push(`%${q}%`); conds.push(`(s.service_name ilike $${vals.length} or s.suburb ilike $${vals.length} or s.postcode ilike $${vals.length})`); }
    if (state) { vals.push(state); conds.push(`s.state = $${vals.length}`); }
    if (type) { vals.push(type); conds.push(`s.provider_type = $${vals.length}`); }
    vals.push(limit);
    const r = await pool.query(`select s.service_approval_no as se, s.service_name as name, s.provider_type as type,
        s.suburb, s.state, s.postcode, s.overall_rating as rating, s.approved_places as places,
        s.lat, s.lon,
        (select round(avg(fee)::numeric,2) from service_fees_history f
          where f.service_approval_no = s.service_approval_no and f.session_type='FULLDY' and f.quarantine is null) as fulldy_mean
      from services s ${conds.length ? 'where ' + conds.join(' and ') : ''}
      order by s.service_name limit $${vals.length}`, vals);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Map points (capped for payload size; dashboard pages with ?limit=).
app.get('/api/geo', async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit || '18000'), 10) || 18000, 20000);
    const r = await pool.query(`select s.service_approval_no as se, s.service_name as n, s.provider_type as t,
        s.suburb as s, s.state as st, s.overall_rating as r, s.lat as la, s.lon as lo,
        (select round(avg(fee)::numeric,2) from service_fees_history f
          where f.service_approval_no = s.service_approval_no and f.session_type='FULLDY' and f.quarantine is null) as f
      from services s where s.lat is not null limit $1`, [limit]);
    res.json({ generated: new Date().toISOString().slice(0, 10), count: r.rows.length, points: r.rows });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

app.listen(PORT, () => console.log(`childcareviz listening on ${PORT}`));
