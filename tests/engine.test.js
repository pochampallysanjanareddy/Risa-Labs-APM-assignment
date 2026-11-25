// Checks the calculation engine against figures verified independently (pandas) from the source file.
const assert = require('assert');
require('../engine.js');
const E = globalThis.Engine;
const src = require('../data/sponsor_source.json');
const M = E.build(src, {});
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

ok(M.dq.interactions.duplicates_removed === 3 && M.dq.qualification.duplicates_removed === 1 && M.dq.opportunity_history.duplicates_removed === 2, 'duplicates removed 3/1/2');
const S = E.snapshot(M, '2025-04-20'), T = S.totals;
ok(T.qualified_brands === 60, 'qualified 60'); ok(T.confirmed_partnerships === 24, 'confirmed 24');
ok(T.confirmed_value === 2240000 && T.confirmed_cash_type_value === 2000000, 'value 22.4L / cash 20L');
ok(T.open_value === 1440000 && T.open_deals === 26, 'open 26 deals 14.4L');
ok(T.qualified_without_deal === 18 && T.qualified_without_deal_warm === 12, '18 leaks, 12 warm');
ok(T.partnerships_goal === 28 && T.qualified_goal === 55, 'revised targets apply');
const m = E.snapshot(M, '2025-03-15').totals;
ok(m.qualified_brands === 55 && m.confirmed_partnerships === 17 && m.confirmed_value === 1505000, '15 Mar snapshot');
ok(E.snapshot(M, '2025-03-14').totals.partnerships_goal === 20, 'launch target before 15 Mar');
const by = Object.fromEntries(S.campaigns.map(c => [c.id, c]));
ok(by.SC02.confirmed === 8 && by.SC05.confirmed === 9 && by.SC04.confirmed === 7, 'warm wins 8/9/7');
ok(by.SC01.confirmed + by.SC03.confirmed + by.SC06.confirmed === 0 && by.SC01.deals + by.SC03.deals + by.SC06.deals === 33, 'cold 0 of 33');
// edits flow through: confirm one open deal
const open = S.deals.find(d => d.open);
const M2 = E.build(src, { opp_history: [{ _id: 'X1', history_id: 'X1', opportunity_id: open.id, stage: 'partner_confirmed', proposed_value_inr: 100000, confirmed_value_inr: 100000, owner_name: 'Test', effective_at: '2025-04-05T18:00:00+05:30' }] });
ok(E.snapshot(M2, '2025-04-20').totals.confirmed_partnerships === 25, 'edit adds a confirmation');
ok(E.snapshot(M2, '2025-04-04').totals.confirmed_partnerships === E.snapshot(M, '2025-04-04').totals.confirmed_partnerships, 'edit does not leak into earlier snapshot');
// query + calc
ok(E.query(S, { table: 'interactions', filters: [{ field: 'event_type', op: 'eq', value: 'opt_out' }] }).value === 7, 'query opt-outs 7');
ok(E.query(S, { table: 'deals', filters: [{ field: 'proposed', op: 'gte', value: '125000' }], agg: 'count' }).value >= 1, 'string number filter coerced');
ok(E.calc('2240000/24') === 93333.333333, 'calc');
assert.throws(() => E.query(S, { table: 'deals', agg: 'sum', field: 'nope' }), /not in deals/); n++;
console.log(`engine tests passed: ${n}`);
