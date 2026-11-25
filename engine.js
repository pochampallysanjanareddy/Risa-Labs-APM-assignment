/* Sponsor Growth Center — calculation engine.
   Pure functions over the source dataset + saved edits ("overlay").
   Works in the browser (window.Engine) and in Node (for tests). */
(function (root) {
  'use strict';
  const DAY = 86400000;
  const OPEN = new Set(['prospecting', 'contacted', 'proposal_sent', 'negotiating']);
  const CLOSED = new Set(['partner_confirmed', 'lost', 'withdrawn']);
  const STAGE_RANK = { prospecting: 1, contacted: 2, proposal_sent: 3, negotiating: 4, partner_confirmed: 5, lost: 0, withdrawn: 0 };
  const STAGES = ['prospecting', 'contacted', 'proposal_sent', 'negotiating', 'partner_confirmed', 'lost', 'withdrawn'];
  const QUAL = ['unreviewed', 'engaged', 'qualified', 'unqualified', 'dormant'];
  const ROOT_EVENTS = new Set(['outreach_sent', 'introduction_received', 'web_inbound']);
  const WARM_CHANNELS = new Set(['introduction', 'web_inbound', 'referral', 'renewal']);

  const BETS = [
    { id: 'B1', name: 'Renew and recover', campaigns: ['SC02'], signal: 'Meeting rate (brands with a meeting ÷ brands touched)',
      rule: '▲ ≥50% add pitch days · ◆ 30–50% open with last year\'s results · ■ <30% after 15 brands: move owner to Referrals' },
    { id: 'B2', name: 'Referrals', campaigns: ['SC05'], signal: 'Fit rate (qualified ÷ brands referred)',
      rule: '▲ ≥60% recruit 10 more referrers · ◆ 40–60% narrow to 3 industries · ■ <40% after 20 referrals: stop' },
    { id: 'B3', name: 'Inbound magnet', campaigns: ['SC04'], signal: 'Form fills in the last 7 days',
      rule: '▲ ≥5/week more LinkedIn spend · ◆ 2–4/week switch to T-Hub events · ■ <2/week from week 5: stop, return budget' },
    { id: 'B4', name: 'Title sponsor', campaigns: [], signal: 'Decision-maker meetings by week 4',
      rule: '▲ proposal by week 5 · ◆ only 1 meeting: two ₹6L co-sponsor slots · ■ 0 meetings by week 4: lead joins B1' },
    { id: 'B5', name: 'Cold, capped', campaigns: ['SC01', 'SC03', 'SC06'], signal: 'Deals reaching negotiation / signed',
      rule: '▲ 1+ signed by week 5: grow list to 200 · ◆ negotiating, none signed: ₹50K offer · ■ none negotiating after 40 brands, or opt-outs >3%: stop' }
  ];
  const DEFAULT_ASSUMPTIONS = { cash_share_note: 'In-kind deals are excluded from cash', retention: 0.96, safety_margin: 0.90, stale_days: 14, proposal_sla_hours: 48 };

  // ---------- time ----------
  function T(v) {
    if (v == null || v === '') return NaN;
    if (typeof v === 'number') return v;
    if (v instanceof Date) return v.getTime();
    let s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00';
    s = s.replace(' ', 'T');
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += '+05:30';
    return Date.parse(s);
  }
  function cutoff(asOf) { return Date.parse(asOf + 'T23:59:59.999+05:30'); }
  function istDate(ms) { return new Date(ms + 5.5 * 3600000).toISOString().slice(0, 10); }
  function istStamp(ms) { return new Date(ms + 5.5 * 3600000).toISOString().slice(0, 19) + '+05:30'; }
  const num = v => (v == null || v === '' || isNaN(+v)) ? 0 : +v;
  const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const r1 = x => x == null ? null : Math.round(x * 10) / 10;
  const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : null;

  // ---------- build model ----------
  function dedupe(arr, key) {
    const seen = new Set(), out = []; let dups = 0;
    for (const r of arr || []) { const k = r[key]; if (k != null && seen.has(k)) { dups++; continue; } if (k != null) seen.add(k); out.push(r); }
    return { rows: out, dups };
  }
  function build(src, overlay) {
    overlay = overlay || {};
    const dq = {};
    const take = (name, key, extra) => {
      const base = dedupe(src[name], key); dq[name] = { source_rows: (src[name] || []).length, duplicates_removed: base.dups };
      const add = (extra || []).filter(Boolean);
      dq[name].added_in_app = add.length;
      // app rows may override a source row with the same id
      const ids = new Set(add.map(r => r[key]));
      return base.rows.filter(r => !ids.has(r[key])).concat(add);
    };
    const M = {
      event: (src.event || [])[0] || {},
      campaigns: take('campaigns', 'sponsor_campaign_id', overlay.campaigns),
      brands: take('brands', 'brand_id', overlay.brands),
      contacts: take('contacts', 'contact_id', overlay.contacts),
      interactions: take('interactions', 'interaction_id', overlay.interactions),
      qualification: take('qualification', 'history_id', overlay.qualification),
      opportunities: take('opportunities', 'opportunity_id', overlay.opportunities),
      opportunity_history: take('opportunity_history', 'history_id', overlay.opp_history),
      targets: take('targets', 'target_version', overlay.targets),
      activations: take('activations', 'activation_id'),
      plans: overlay.plans || {},
      tasks: (overlay.tasks || []).slice(),
      assumptions: Object.assign({}, DEFAULT_ASSUMPTIONS, overlay.assumptions || {}),
      dq
    };
    for (const k of ['interactions', 'qualification', 'opportunity_history', 'targets']) {
      const f = k === 'interactions' ? 'occurred_at' : 'effective_at';
      M[k].forEach(r => { r._t = T(r[f]); });
      M[k].sort((a, b) => a._t - b._t || String(a.history_id || a.interaction_id || '').localeCompare(String(b.history_id || b.interaction_id || '')));
    }
    for (const k of ['brands', 'contacts', 'opportunities', 'campaigns']) M[k].forEach(r => { r._t = T(r.created_at); });
    M.campById = Object.fromEntries(M.campaigns.map(c => [c.sponsor_campaign_id, c]));
    M.brandById = Object.fromEntries(M.brands.map(b => [b.brand_id, b]));
    M.oppById = Object.fromEntries(M.opportunities.map(o => [o.opportunity_id, o]));
    M.histByOpp = {};
    for (const h of M.opportunity_history) (M.histByOpp[h.opportunity_id] = M.histByOpp[h.opportunity_id] || []).push(h);
    M.qualByBrand = {};
    for (const q of M.qualification) (M.qualByBrand[q.brand_id] = M.qualByBrand[q.brand_id] || []).push(q);
    M.start = T(M.event.history_start) || Math.min(...M.interactions.map(i => i._t));
    M.end = T(M.event.history_end) || Math.max(...M.interactions.map(i => i._t));
    M.eventStart = T(M.event.event_starts_at);
    M.calib = calibrate(M);
    return M;
  }
  function campGroup(M, cid) {
    const c = M.campById[cid];
    const plan = M.plans[cid];
    if (plan && plan.group) return plan.group;
    if (!c) return 'cold';
    return WARM_CHANNELS.has(c.channel) ? 'warm' : 'cold';
  }
  function betOf(M, cid) {
    const plan = M.plans[cid];
    if (plan && plan.bet) return plan.bet;
    const b = BETS.find(x => x.campaigns.includes(cid));
    return b ? b.id : null;
  }

  // Win probability by furthest stage reached and channel group, from all closed deals (full history).
  function calibrate(M) {
    const tally = {};
    for (const o of M.opportunities) {
      const h = M.histByOpp[o.opportunity_id] || [];
      if (!h.length) continue;
      const last = h[h.length - 1];
      if (!CLOSED.has(last.stage)) continue;
      const won = last.stage === 'partner_confirmed';
      const g = campGroup(M, o.sponsor_campaign_id);
      const furthest = Math.max(...h.map(x => x.stage === 'partner_confirmed' ? 4 : (STAGE_RANK[x.stage] || 0)));
      for (let s = 1; s <= Math.min(furthest, 4); s++) {
        for (const key of [g + ':' + s, 'all:' + s]) {
          tally[key] = tally[key] || { won: 0, n: 0 }; tally[key].n++; if (won) tally[key].won++;
        }
      }
    }
    const p = {};
    for (const g of ['warm', 'cold', 'all']) for (let s = 1; s <= 4; s++) {
      const t = tally[g + ':' + s] || { won: 0, n: 0 };
      p[g + ':' + s] = { p: (t.won + 0.5) / (t.n + 1), won: t.won, n: t.n };
    }
    return p;
  }
  function winProb(M, cid, stage) {
    const s = STAGE_RANK[stage]; if (!s || s > 4) return 0;
    const g = campGroup(M, cid);
    const c = M.calib[g + ':' + s];
    return (c && c.n >= 3) ? c.p : M.calib['all:' + s].p;
  }

  // ---------- snapshot ----------
  function snapshot(M, asOf) {
    const cut = cutoff(asOf);
    const A = M.assumptions;
    const S = { asOf, cut, M };
    S.target = null;
    for (const t of M.targets) if (t._t <= cut) S.target = t;
    S.interactions = M.interactions.filter(i => i._t <= cut);
    S.brands = M.brands.filter(b => !(b._t > cut));
    // latest qualification per brand
    S.qual = {};
    for (const q of M.qualification) if (q._t <= cut) S.qual[q.brand_id] = q;
    // deals
    S.deals = [];
    for (const o of M.opportunities) {
      if (o._t > cut) continue;
      const h = (M.histByOpp[o.opportunity_id] || []).filter(x => x._t <= cut);
      if (!h.length) continue;
      const last = h[h.length - 1];
      const firstAt = h[0]._t;
      const conf = h.find(x => x.stage === 'partner_confirmed');
      const reached = Math.max(...h.map(x => STAGE_RANK[x.stage] || 0));
      const open = OPEN.has(last.stage);
      const daysIn = Math.floor((cut - last._t) / DAY);
      const cid = o.sponsor_campaign_id;
      const camp = M.campById[cid];
      const brand = M.brandById[o.brand_id] || {};
      const d = {
        id: o.opportunity_id, name: o.opportunity_name, brand_id: o.brand_id, brand: o.brand_name || brand.brand_name,
        industry: brand.industry || null, campaign_id: cid, campaign: camp ? camp.campaign_name : o.originating_campaign_name,
        group: campGroup(M, cid), owner: last.owner_name || null, support_type: o.support_type, stage: last.stage,
        proposed: num(last.proposed_value_inr), confirmed_value: last.stage === 'partner_confirmed' ? num(last.confirmed_value_inr || last.proposed_value_inr) : 0,
        created: istDate(o._t), last_update: istDate(last._t), days_in_stage: daysIn, open,
        stale: open && daysIn > A.stale_days, reached_proposal: reached >= 3 || last.stage === 'partner_confirmed' || h.some(x => x.stage === 'proposal_sent'),
        reached_negotiation: h.some(x => x.stage === 'negotiating' || x.stage === 'partner_confirmed'),
        ever_confirmed: !!conf, confirmed_on: conf ? istDate(conf._t) : null,
        cycle_days: conf ? Math.round((conf._t - firstAt) / DAY) : null,
        win_prob: open ? winProb(M, cid, last.stage) : (last.stage === 'partner_confirmed' ? 1 : 0),
        history: h.map(x => ({ stage: x.stage, at: istDate(x._t), proposed: num(x.proposed_value_inr), confirmed: num(x.confirmed_value_inr), owner: x.owner_name, note: x.note || null, by_app: !!(x._app || x.app_created) }))
      };
      S.deals.push(d);
    }
    S.dealsByBrand = {};
    for (const d of S.deals) (S.dealsByBrand[d.brand_id] = S.dealsByBrand[d.brand_id] || []).push(d);
    // qualified brands with no deal (leak)
    S.leaks = [];
    for (const b of S.brands) {
      const q = S.qual[b.brand_id];
      if (!q || q.qualification_status !== 'qualified') continue;
      if ((S.dealsByBrand[b.brand_id] || []).length) continue;
      const hours = Math.round((cut - q._t) / 3600000);
      S.leaks.push({ brand_id: b.brand_id, brand: b.brand_name, industry: b.industry, campaign_id: q.sponsor_campaign_id,
        campaign: q.source_campaign_name, group: campGroup(M, q.sponsor_campaign_id), qualified_on: istDate(q._t), hours_waiting: hours, owner: b.owner_name,
        over_sla: hours > A.proposal_sla_hours });
    }
    S.campaigns = M.campaigns.map(c => campaignMetrics(S, c));
    S.totals = totals(S);
    S.bets = BETS.map(b => betHealth(S, b));
    S.owners = ownerMetrics(S);
    S.recs = recommendations(S);
    return S;
  }

  function campaignMetrics(S, c) {
    const M = S.M, A = M.assumptions, cid = c.sponsor_campaign_id, cut = S.cut;
    const ic = S.interactions.filter(i => i.sponsor_campaign_id === cid);
    const by = t => ic.filter(i => i.event_type === t);
    const brandsOf = arr => new Set(arr.map(i => i.brand_id)).size;
    const roots = ic.filter(i => ROOT_EVENTS.has(i.event_type));
    const replied = by('replied');
    const deals = S.deals.filter(d => d.campaign_id === cid);
    const conf = deals.filter(d => d.stage === 'partner_confirmed');
    const lost = deals.filter(d => d.stage === 'lost'), wd = deals.filter(d => d.stage === 'withdrawn');
    const open = deals.filter(d => d.open);
    const qualRows = Object.values(S.qual).filter(q => q.sponsor_campaign_id === cid);
    const qcount = s => qualRows.filter(q => q.qualification_status === s).length;
    const plan = M.plans[cid] || {};
    const confValue = conf.reduce((s, d) => s + d.confirmed_value, 0);
    const touched = brandsOf(ic);
    const winEnd = Math.min(cut, M.eventStart || cut);
    const last7 = roots.filter(i => i._t <= winEnd && i._t > winEnd - 7 * DAY).length;
    const startMs = T(plan.start || c.planned_start_at);
    const sent = by('outreach_sent').length;
    const m = {
      id: cid, name: c.campaign_name, channel: c.channel, group: campGroup(M, cid), bet: betOf(M, cid),
      owner: plan.owner || c.owner_name, status: plan.status || 'active', objective: c.objective, audience: c.audience,
      planned_start: c.planned_start_at ? istDate(T(c.planned_start_at)) : null, planned_end: c.planned_end_at ? istDate(T(c.planned_end_at)) : null,
      weeks_running: isNaN(startMs) ? null : Math.max(0, Math.floor((cut - startMs) / (7 * DAY))),
      attempts: new Set(roots.map(i => i.attempt_id)).size, outreach_sent: sent, delivered: by('delivered').length,
      introductions: by('introduction_received').length, form_fills: by('web_inbound').length, form_fills_last7: last7, root_touches_last7: last7,
      replies: replied.length, positive_replies: replied.filter(i => i.outcome === 'positive').length,
      neutral_replies: replied.filter(i => i.outcome === 'neutral').length, not_interested: replied.filter(i => i.outcome === 'not_interested').length,
      meetings_booked: by('meeting_booked').length, meetings_held: by('meeting_held').length,
      opt_outs: by('opt_out').length, opt_out_rate: pct(by('opt_out').length, sent),
      brands_touched: touched, contacts_touched: new Set(ic.map(i => i.contact_id)).size,
      brands_replied: brandsOf(replied), brands_positive: brandsOf(replied.filter(i => i.outcome === 'positive')), brands_met: brandsOf(by('meeting_held')),
      qualified: qcount('qualified'), engaged: qcount('engaged'), unqualified: qcount('unqualified'), dormant: qcount('dormant'), unreviewed: qcount('unreviewed'),
      deals: deals.length, open_deals: open.length, reached_proposal: deals.filter(d => d.reached_proposal).length,
      reached_negotiation: deals.filter(d => d.reached_negotiation).length,
      confirmed: conf.length, lost: lost.length, withdrawn: wd.length,
      confirmed_value: confValue, confirmed_cash_value: conf.filter(d => d.support_type !== 'in_kind').reduce((s, d) => s + d.confirmed_value, 0),
      open_value: open.reduce((s, d) => s + d.proposed, 0), weighted_open_value: Math.round(open.reduce((s, d) => s + d.proposed * d.win_prob, 0)),
      avg_deal: conf.length ? Math.round(confValue / conf.length) : null,
      win_rate_closed: pct(conf.length, conf.length + lost.length + wd.length), deal_to_win: pct(conf.length, deals.length),
      median_cycle_days: median(conf.map(d => d.cycle_days).filter(x => x != null)),
      stale_deals: open.filter(d => d.stale).length, stale_value: open.filter(d => d.stale).reduce((s, d) => s + d.proposed, 0),
      qualified_without_deal: S.leaks.filter(l => l.campaign_id === cid).length,
      budget_inr: plan.budget_inr != null ? num(plan.budget_inr) : null, spent_inr: plan.spent_inr != null ? num(plan.spent_inr) : null,
      budget_simulated: !!plan.simulated, plan_notes: plan.notes || ''
    };
    m.cost_per_confirmed = (m.spent_inr != null && m.confirmed) ? Math.round(m.spent_inr / m.confirmed) : null;
    m.value_per_rupee = (m.spent_inr) ? r1(m.confirmed_value / m.spent_inr) : null;
    // stage chain + bottleneck
    const chain = [
      ['Brands touched', touched], ['Replied', m.brands_replied], ['Meeting held', m.brands_met], ['Qualified', m.qualified],
      ['Deal opened', m.deals], ['Proposal sent', m.reached_proposal], ['Confirmed', m.confirmed]
    ];
    m.chain = chain.map(([label, n], i) => ({ label, n, rate_from_prev: i ? pct(n, chain[i - 1][1]) : null }));
    let worst = null;
    for (let i = 1; i < chain.length; i++) {
      const prev = chain[i - 1][1]; if (prev < 3) continue;
      const rate = chain[i][1] / prev;
      if (chain[i][0] === 'Deal opened' && rate > 1) continue;
      if (!worst || rate < worst.rate) worst = { step: chain[i - 1][0] + ' → ' + chain[i][0], rate, pct: pct(chain[i][1], prev) };
    }
    m.bottleneck = (worst && worst.rate < 0.8) ? worst : null;
    return m;
  }

  function totals(S) {
    const M = S.M, A = M.assumptions;
    const deals = S.deals;
    const conf = deals.filter(d => d.stage === 'partner_confirmed');
    const open = deals.filter(d => d.open);
    const eventOver = S.cut >= M.eventStart;
    const confCash = conf.filter(d => d.support_type !== 'in_kind').reduce((s, d) => s + d.confirmed_value, 0);
    const expOpen = eventOver ? [] : open;
    const expDeals = expOpen.reduce((s, d) => s + d.win_prob, 0);
    const expValue = expOpen.reduce((s, d) => s + d.proposed * d.win_prob, 0);
    const expCash = expOpen.filter(d => d.support_type !== 'in_kind').reduce((s, d) => s + d.proposed * d.win_prob, 0);
    const qualified = Object.values(S.qual).filter(q => q.qualification_status === 'qualified').length;
    const t = S.target || {};
    const confValue = conf.reduce((s, d) => s + d.confirmed_value, 0);
    const out = {
      as_of: S.asOf, data_window: istDate(M.start) + ' to ' + istDate(M.end), event_starts: istDate(M.eventStart), event_over: eventOver,
      days_to_event: eventOver ? 0 : Math.ceil((M.eventStart - S.cut) / DAY),
      target_version: t.target_version || null, qualified_goal: t.qualified_brands_goal != null ? num(t.qualified_brands_goal) : null,
      partnerships_goal: t.confirmed_partnerships_goal != null ? num(t.confirmed_partnerships_goal) : null,
      cash_goal_inr: t.cash_goal_inr != null ? num(t.cash_goal_inr) : null,
      brands_in_research: S.brands.length, brands_touched: new Set(S.interactions.map(i => i.brand_id)).size,
      qualified_brands: qualified, confirmed_partnerships: conf.length, confirmed_value: confValue,
      confirmed_cash_type_value: confCash, confirmed_in_kind_value: confValue - confCash,
      open_deals: open.length, open_value: open.reduce((s, d) => s + d.proposed, 0),
      stale_deals: open.filter(d => d.stale).length, stale_value: open.filter(d => d.stale).reduce((s, d) => s + d.proposed, 0),
      lost: deals.filter(d => d.stage === 'lost').length, withdrawn: deals.filter(d => d.stage === 'withdrawn').length,
      qualified_without_deal: S.leaks.length, qualified_without_deal_warm: S.leaks.filter(l => l.group === 'warm').length,
      expected_more_deals: r1(expDeals), expected_more_value: Math.round(expValue),
      projected_partnerships: r1(conf.length + expDeals), projected_signed_value: Math.round(confValue + expValue),
      projected_cash: Math.round((confCash + expCash) * A.retention * A.safety_margin),
      cash_formula: `(confirmed cash-type value + Σ open cash-type deals × win probability) × ${A.retention} retention × ${A.safety_margin} safety margin`,
      win_rate_closed: pct(conf.length, deals.filter(d => CLOSED.has(d.stage)).length),
      avg_deal: conf.length ? Math.round(confValue / conf.length) : null,
      median_cycle_days: median(conf.map(d => d.cycle_days).filter(x => x != null))
    };
    out.partnerships_pct_of_goal = out.partnerships_goal ? pct(out.confirmed_partnerships, out.partnerships_goal) : null;
    out.qualified_pct_of_goal = out.qualified_goal ? pct(out.qualified_brands, out.qualified_goal) : null;
    out.gap_to_partnerships_goal = out.partnerships_goal != null ? out.partnerships_goal - out.confirmed_partnerships : null;
    // overall funnel (brand level)
    const brandsOf = arr => new Set(arr.map(i => i.brand_id)).size;
    const I = S.interactions;
    out.funnel = [
      ['Brands in research', S.brands.length], ['Brands touched', out.brands_touched],
      ['Replied', brandsOf(I.filter(i => i.event_type === 'replied'))], ['Meeting held', brandsOf(I.filter(i => i.event_type === 'meeting_held'))],
      ['Qualified', qualified], ['Deal opened', new Set(deals.map(d => d.brand_id)).size],
      ['Proposal sent', new Set(deals.filter(d => d.reached_proposal).map(d => d.brand_id)).size],
      ['Confirmed', new Set(conf.map(d => d.brand_id)).size]
    ].map(([label, n]) => ({ label, n }));
    return out;
  }

  function status(code, label) { return { code, label }; }
  function betHealth(S, b) {
    const M = S.M;
    const camps = S.campaigns.filter(c => (c.bet === b.id));
    const sum = k => camps.reduce((s, c) => s + (c[k] || 0), 0);
    const base = { id: b.id, name: b.name, campaigns: camps.map(c => c.name), signal_name: b.signal, rule: b.rule };
    if (!camps.length) return Object.assign(base, { status: status('nodata', 'No data yet'), value: null,
      evidence: 'No campaign in the data is mapped to this bet, so it cannot be judged. Log a campaign and assign it to ' + b.id + ' to track it.' });
    if (b.id === 'B1') {
      const t = sum('brands_touched'), met = sum('brands_met'); const r = t ? met / t : 0;
      const st = t < 5 ? status('early', 'Too early') : r >= 0.5 ? status('scale', 'Scale') : r >= 0.3 ? status('change', 'Change') : (t >= 15 ? status('stop', 'Stop') : status('change', 'Change'));
      return Object.assign(base, { status: st, value: pct(met, t), value_label: `${met} of ${t} brands met (${pct(met, t) ?? 0}%)`, evidence: `meeting_held events vs brands with any interaction, as of ${S.asOf}` });
    }
    if (b.id === 'B2') {
      const t = sum('brands_touched'), q = sum('qualified'); const r = t ? q / t : 0;
      const st = t < 5 ? status('early', 'Too early') : r >= 0.6 ? status('scale', 'Scale') : r >= 0.4 ? status('change', 'Change') : (t >= 20 ? status('stop', 'Stop') : status('change', 'Change'));
      return Object.assign(base, { status: st, value: pct(q, t), value_label: `${q} of ${t} referred brands qualified (${pct(q, t) ?? 0}%)`, evidence: 'latest qualification status = qualified, by source campaign' });
    }
    if (b.id === 'B3') {
      const n = sum('form_fills_last7'); const wk = Math.max(...camps.map(c => c.weeks_running || 0));
      const st = n >= 5 ? status('scale', 'Scale') : n >= 2 ? status('change', 'Change') : (wk >= 5 ? status('stop', 'Stop') : status('early', 'Too early'));
      return Object.assign(base, { status: st, value: n, value_label: `${n} form fills in the 7 days to ${istDate(Math.min(S.cut, M.eventStart || S.cut))} (week ${wk} of campaign)`, evidence: 'web_inbound events in the last 7 days' });
    }
    if (b.id === 'B5') {
      const signed = sum('confirmed'), neg = sum('reached_negotiation'), sent = sum('outreach_sent'), opt = sum('opt_outs'), t = sum('brands_touched');
      const optRate = sent ? opt / sent : 0;
      const st = optRate > 0.03 ? status('stop', 'Stop') : signed >= 1 ? status('scale', 'Scale') : neg >= 1 ? status('change', 'Change') : (t >= 40 ? status('stop', 'Stop') : status('early', 'Too early'));
      return Object.assign(base, { status: st, value: signed, value_label: `${signed} signed, ${neg} reached negotiation, opt-outs ${pct(opt, sent) ?? 0}% of ${sent} emails`, evidence: 'opportunity stages + opt_out events, cold campaigns combined' });
    }
    return Object.assign(base, { status: status('nodata', 'No data yet'), value: null, evidence: '' });
  }

  function ownerMetrics(S) {
    const map = {};
    for (const d of S.deals) {
      const k = d.owner || 'Unassigned';
      const o = map[k] = map[k] || { owner: k, deals: 0, open: 0, confirmed: 0, confirmed_value: 0, open_value: 0, stale: 0, lost: 0 };
      o.deals++; if (d.open) { o.open++; o.open_value += d.proposed; } if (d.stale) o.stale++;
      if (d.stage === 'partner_confirmed') { o.confirmed++; o.confirmed_value += d.confirmed_value; } if (d.stage === 'lost') o.lost++;
    }
    return Object.values(map).sort((a, b) => b.confirmed_value - a.confirmed_value);
  }

  function recommendations(S) {
    const T_ = S.totals, out = [];
    const L = n => '₹' + (n / 1e5).toFixed(1) + 'L';
    const warmLeaks = S.leaks.filter(l => l.group === 'warm');
    if (S.leaks.length) {
      const avg = T_.avg_deal || 90000;
      out.push({ id: 'leak', severity: warmLeaks.length ? 'high' : 'medium', title: `${S.leaks.length} qualified brands have no deal (${warmLeaks.length} from warm/inbound)`,
        detail: `They were qualified but never got a proposal. At the average deal of ${L(avg)}, warm ones alone are worth ~${L(warmLeaks.length * avg * (S.M.calib['warm:1'].p))} expected.`,
        evidence: 'latest qualification = qualified and no opportunity for the brand',
        task: { title: `Send proposals to ${warmLeaks.length || S.leaks.length} qualified brands with no deal`, priority: 'high', bet: 'B1',
          reason: (warmLeaks.length ? warmLeaks : S.leaks).slice(0, 12).map(l => l.brand).join(', ') } });
    }
    if (T_.stale_deals) {
      const stale = S.deals.filter(d => d.stale);
      const cold = stale.filter(d => d.group === 'cold').length;
      out.push({ id: 'stale', severity: 'medium', title: `${T_.stale_deals} open deals untouched for ${S.M.assumptions.stale_days}+ days (${L(T_.stale_value)})`,
        detail: `${cold} of them come from cold campaigns, which have never closed a deal. Follow up once, then close as lost so the forecast stays honest.`,
        evidence: 'open stage, last history version older than the stale threshold',
        task: { title: `Review ${T_.stale_deals} stale deals: follow up or close`, priority: 'medium', reason: stale.slice(0, 12).map(d => d.brand).join(', ') } });
    }
    for (const b of S.bets) {
      if (b.status.code === 'stop') out.push({ id: 'bet-' + b.id, severity: 'high', title: `${b.name}: stop rule hit`, detail: b.value_label + '. Rule: ' + b.rule, evidence: b.evidence,
        task: { title: `Stop or rework ${b.name}; move effort to warm channels`, priority: 'high', bet: b.id, reason: b.value_label } });
      if (b.status.code === 'change') out.push({ id: 'bet-' + b.id, severity: 'medium', title: `${b.name}: change the approach`, detail: b.value_label + '. Rule: ' + b.rule, evidence: b.evidence,
        task: { title: `Adjust ${b.name} per its change rule`, priority: 'medium', bet: b.id, reason: b.value_label } });
      if (b.status.code === 'scale') out.push({ id: 'bet-' + b.id, severity: 'low', title: `${b.name}: working, scale it`, detail: b.value_label, evidence: b.evidence,
        task: { title: `Scale ${b.name}`, priority: 'medium', bet: b.id, reason: b.value_label } });
    }
    if (T_.partnerships_goal != null && !T_.event_over && T_.projected_partnerships < T_.partnerships_goal) {
      out.push({ id: 'pace', severity: 'high', title: `Projected ${T_.projected_partnerships} partnerships vs goal ${T_.partnerships_goal}`,
        detail: `Gap of ${r1(T_.partnerships_goal - T_.projected_partnerships)} deals with ${T_.days_to_event} days to the fest. Warm deals take ~${T_.median_cycle_days ?? 10} days to close, so new pitches must start now.`,
        evidence: 'confirmed + Σ open deals × win probability', task: { title: 'Close the partnership gap: add warm pitches this week', priority: 'high' } });
    }
    const busy = S.owners.filter(o => o.open > 20);
    for (const o of busy) out.push({ id: 'owner-' + o.owner, severity: 'medium', title: `${o.owner} holds ${o.open} open deals`, detail: 'Above the ~20 live deals one owner handled last year.', evidence: 'open deals by latest owner', task: { title: `Rebalance ${o.owner}'s open deals`, priority: 'medium', owner: o.owner } });
    const rank = { high: 0, medium: 1, low: 2 };
    return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  }

  // ---------- trend ----------
  function trend(M, from, to, stepDays) {
    const pts = []; stepDays = stepDays || 7;
    let t = cutoff(from); const end = cutoff(to);
    while (t <= end + 1) {
      const d = istDate(t);
      let target = null; for (const x of M.targets) if (x._t <= t) target = x;
      const qual = {}; for (const q of M.qualification) if (q._t <= t) qual[q.brand_id] = q.qualification_status;
      let conf = 0, val = 0;
      for (const o of M.opportunities) {
        if (o._t > t) continue;
        const h = (M.histByOpp[o.opportunity_id] || []).filter(x => x._t <= t); if (!h.length) continue;
        const l = h[h.length - 1]; if (l.stage === 'partner_confirmed') { conf++; val += num(l.confirmed_value_inr || l.proposed_value_inr); }
      }
      pts.push({ date: d, qualified: Object.values(qual).filter(s => s === 'qualified').length, confirmed: conf, confirmed_value: val,
        partnerships_goal: target ? num(target.confirmed_partnerships_goal) : null, qualified_goal: target ? num(target.qualified_brands_goal) : null });
      if (t >= end) break;
      t = Math.min(t + stepDays * DAY, end);
    }
    return pts;
  }

  // ---------- generic query (for the copilot) ----------
  function tableRows(S, table) {
    const M = S.M;
    switch (table) {
      case 'brands': return S.brands.map(b => { const q = S.qual[b.brand_id]; const ds = S.dealsByBrand[b.brand_id] || [];
        return { brand_id: b.brand_id, brand: b.brand_name, industry: b.industry, owner: b.owner_name, created: istDate(b._t),
          qualification: q ? q.qualification_status : 'none', qualification_reason: q ? q.reason : null, source_campaign: q ? q.source_campaign_name : null,
          contacts: M.contacts.filter(c => c.brand_id === b.brand_id).length, deals: ds.length, confirmed: ds.some(d => d.stage === 'partner_confirmed') }; });
      case 'contacts': return M.contacts.filter(c => !(c._t > S.cut)).map(c => ({ contact_id: c.contact_id, contact: c.contact_name, job_title: c.job_title, brand: c.brand_name, brand_id: c.brand_id, created: istDate(c._t) }));
      case 'interactions': return S.interactions.map(i => ({ id: i.interaction_id, date: istDate(i._t), brand: i.brand_name, brand_id: i.brand_id, contact: i.contact_name,
        campaign: i.campaign_name, campaign_id: i.sponsor_campaign_id, channel: i.channel, event_type: i.event_type, outcome: i.outcome, attempt_id: i.attempt_id }));
      case 'deals': return S.deals.map(d => { const o = Object.assign({}, d); delete o.history; return o; });
      case 'qualification_history': return M.qualification.filter(q => q._t <= S.cut).map(q => ({ brand: q.brand_name, brand_id: q.brand_id, status: q.qualification_status, reason: q.reason, campaign: q.source_campaign_name, date: istDate(q._t) }));
      case 'deal_history': return M.opportunity_history.filter(h => h._t <= S.cut).map(h => ({ deal_id: h.opportunity_id, brand: h.brand_name, stage: h.stage, proposed: num(h.proposed_value_inr), confirmed: num(h.confirmed_value_inr), owner: h.owner_name, date: istDate(h._t) }));
      case 'campaigns': return S.campaigns.map(c => { const o = Object.assign({}, c); delete o.chain; return o; });
      case 'tasks': return M.tasks.map(t => ({ id: t.id, title: t.title, owner: t.owner, due: t.due, status: t.status, priority: t.priority, campaign_id: t.campaign_id, deal_id: t.opportunity_id, source: t.source, created: t.created_at }));
      case 'leaks': return S.leaks;
      default: throw new Error('Unknown table "' + table + '". Use one of: brands, contacts, interactions, deals, qualification_history, deal_history, campaigns, tasks, leaks');
    }
  }
  function query(S, q) {
    let rows = tableRows(S, q.table);
    const cols = rows.length ? Object.keys(rows[0]) : [];
    for (const f of q.filters || []) {
      if (rows.length && !(f.field in rows[0])) throw new Error(`Field "${f.field}" not in ${q.table}. Fields: ${cols.join(', ')}`);
      const op = f.op || 'eq';
      const sample = rows.length ? rows[0][f.field] : null;
      let v = f.value;
      if (op === 'in' && typeof v === 'string') v = v.split(',').map(s => s.trim());
      else if (typeof v === 'string' && typeof sample === 'number' && /^-?\d+(\.\d+)?$/.test(v.trim())) v = +v;
      else if (typeof v === 'string' && typeof sample === 'boolean' && /^(true|false)$/i.test(v.trim())) v = /^true$/i.test(v.trim());
      rows = rows.filter(r => { const x = r[f.field];
        switch (op) {
          case 'eq': return String(x).toLowerCase() === String(v).toLowerCase();
          case 'neq': return String(x).toLowerCase() !== String(v).toLowerCase();
          case 'in': return (Array.isArray(v) ? v : [v]).map(s => String(s).toLowerCase()).includes(String(x).toLowerCase());
          case 'contains': return String(x || '').toLowerCase().includes(String(v).toLowerCase());
          case 'gt': return x > v; case 'gte': return x >= v; case 'lt': return x < v; case 'lte': return x <= v;
          default: throw new Error('Unknown op ' + op);
        } });
    }
    const agg = q.agg || 'count';
    if (agg === 'rows') { const lim = Math.min(q.limit || 25, 60); return { table: q.table, matched: rows.length, rows: rows.slice(0, lim), truncated: rows.length > lim }; }
    const val = r => num(r[q.field]);
    const aggregate = list => {
      if (agg === 'count') return list.length;
      if (agg === 'count_distinct') return new Set(list.map(r => r[q.field])).size;
      if (agg === 'sum') return list.reduce((s, r) => s + val(r), 0);
      if (agg === 'avg') return list.length ? r1(list.reduce((s, r) => s + val(r), 0) / list.length) : null;
      if (agg === 'min') return list.length ? Math.min(...list.map(val)) : null;
      if (agg === 'max') return list.length ? Math.max(...list.map(val)) : null;
      throw new Error('Unknown agg ' + agg);
    };
    if (['count_distinct', 'sum', 'avg', 'min', 'max'].includes(agg) && rows.length && !(q.field in rows[0])) throw new Error(`Field "${q.field}" not in ${q.table}. Fields: ${cols.join(', ')}`);
    if (!q.group_by) return { table: q.table, matched: rows.length, agg, field: q.field || null, value: aggregate(rows) };
    const g = {};
    for (const r of rows) { const k = String(r[q.group_by]); (g[k] = g[k] || []).push(r); }
    const groups = Object.entries(g).map(([k, list]) => ({ [q.group_by]: k, n: list.length, value: aggregate(list) })).sort((a, b) => (b.value || 0) - (a.value || 0));
    return { table: q.table, matched: rows.length, agg, field: q.field || null, group_by: q.group_by, groups: groups.slice(0, 50) };
  }

  // safe arithmetic
  function calc(expr) {
    const s = String(expr).replace(/,/g, '').replace(/₹/g, '');
    let i = 0;
    const peek = () => s[i], ws = () => { while (s[i] === ' ') i++; };
    function num_() { ws(); let st = i; while (/[0-9.eE]/.test(s[i] || '')) { if ((s[i] === 'e' || s[i] === 'E') && /[+-]/.test(s[i + 1])) i++; i++; } if (st === i) throw new Error('Expected a number at ' + i); let v = parseFloat(s.slice(st, i)); ws(); if (s[i] === '%') { i++; v /= 100; } return v; }
    function fac() { ws(); if (peek() === '(') { i++; const v = add(); ws(); if (s[i] !== ')') throw new Error('Missing )'); i++; return v; } if (peek() === '-') { i++; return -fac(); } if (peek() === '+') { i++; return fac(); } return num_(); }
    function pow() { let v = fac(); ws(); if (s[i] === '^') { i++; v = Math.pow(v, pow()); } return v; }
    function mul() { let v = pow(); for (;;) { ws(); if (s[i] === '*') { i++; v *= pow(); } else if (s[i] === '/') { i++; const d = pow(); if (d === 0) throw new Error('Division by zero'); v /= d; } else return v; } }
    function add() { let v = mul(); for (;;) { ws(); if (s[i] === '+') { i++; v += mul(); } else if (s[i] === '-') { i++; v -= mul(); } else return v; } }
    const v = add(); ws(); if (i < s.length) throw new Error('Unexpected "' + s[i] + '" — use numbers and + - * / ^ ( ) % only');
    return Math.round(v * 1e6) / 1e6;
  }

  root.Engine = { build, snapshot, trend, query, tableRows, calc, BETS, STAGES, QUAL, DEFAULT_ASSUMPTIONS, T, cutoff, istDate, istStamp, winProb };
})(typeof window !== 'undefined' ? window : globalThis);
