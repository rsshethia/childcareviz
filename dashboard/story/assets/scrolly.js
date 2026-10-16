// Shared scrollytelling engine for ChildCareViz stories.
// One engine, many stories: each story page defines STEPS = [{ render(fig, data) }]
// and calls initStory(STEPS). Reduced-motion renders the final step statically.
export const TYPE_COLOR = {
  'for-profit': '#2563eb', 'nfp-community': '#9333ea', 'nfp-other': '#a855f7',
  'govt-local': '#16a34a', 'govt-state': '#64748b', 'unknown': '#94a3b8',
};
export const TYPE_LABEL = {
  'for-profit': 'For-profit', 'nfp-community': 'NFP · community', 'nfp-other': 'NFP · other',
  'govt-local': 'Council-run', 'govt-state': 'State govt', 'unknown': 'Unknown',
};
export const fmt$ = (v) => (v == null || v === '' ? '—' : '$' + Number(v).toLocaleString());

export function svg(el, W, H, pad = { t: 16, r: 16, b: 34, l: 46 }) {
  el.innerHTML = '';
  const s = d3.select(el).append('svg')
    .attr('viewBox', `0 0 ${W} ${H}`)
    .attr('width', '100%')
    .attr('role', 'img');
  return { s, iw: W - pad.l - pad.r, ih: H - pad.t - pad.b, g: s.append('g').attr('transform', `translate(${pad.l},${pad.t})`) };
}

export function axes(g, x, y, iw, ih, { xticks = 6, yfmt = (d) => d } = {}) {
  g.append('g').attr('transform', `translate(0,${ih})`).call(d3.axisBottom(x).ticks(xticks)).selectAll('text').style('font-size', '11px');
  g.append('g').call(d3.axisLeft(y).ticks(5).tickFormat(yfmt)).selectAll('text').style('font-size', '11px');
  g.selectAll('.domain,.tick line').attr('stroke', '#e2e8f0');
}

// Overall median from distribution bins (bin = floor to $10).
export function overallMedian(dist) {
  const all = [];
  for (const rows of Object.values(dist)) for (const { bin, n } of rows) all.push([bin, n]);
  const total = all.reduce((a, [, n]) => a + n, 0);
  let acc = 0;
  for (const [bin, n] of all.sort((a, b) => a[0] - b[0])) {
    acc += n;
    if (acc >= total / 2) return bin + 5;
  }
  return null;
}

export function initStory(steps) {
  const figs = document.getElementById('fig');
  const rail = document.getElementById('rail');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  rail.innerHTML = steps.map((s, i) => `<a href="#step-${i}" data-i="${i}" aria-label="${s.label}"></a>`).join('');
  const dots = [...rail.querySelectorAll('a')];
  let current = -1;
  function go(i) {
    if (i === current) return;
    current = i;
    document.querySelectorAll('.step').forEach((el, j) => el.classList.toggle('active', j === i));
    dots.forEach((d, j) => d.classList.toggle('active', j === i));
    steps[i].render(figs);
  }
  if (reduce) { go(steps.length - 1); return { go }; }
  const io = new IntersectionObserver((es) => {
    es.forEach((e) => {
      if (e.isIntersecting) go(Number(e.target.dataset.i));
    });
  }, { rootMargin: '-45% 0px -45% 0px' });
  document.querySelectorAll('.step').forEach((el, i) => { el.id = 'step-' + i; el.dataset.i = i; io.observe(el); });
  dots.forEach((d) => d.addEventListener('click', (e) => { e.preventDefault(); document.getElementById('step-' + d.dataset.i).scrollIntoView({ behavior: 'smooth', block: 'center' }); }));
  go(0);
  return { go };
}
