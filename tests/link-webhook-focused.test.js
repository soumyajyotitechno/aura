'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'production';
process.env.MEU_API_KEY = 'test-key';
process.env.MEU_LOG_BODIES = 'false';
const seen = [];
let scenario = {};
const result = rows => ({ rows, rowCount: rows.length });
async function query(sql, args = []) {
  const q = sql.replace(/\s+/g, ' ').trim().toLowerCase();
  seen.push({ q, args });
  if (/\baura_customer\b/.test(q)) throw Error('Unexpected customer lookup');
  if (scenario.fail && q.includes(scenario.fail)) throw Error('mock database failure');
  if (q.includes('select distinct partner_id')) return result(scenario.config || [{ partner_id: 'P1' }]);
  if (q.includes('from meu_partner_program_config c join aura_partner')) return result(scenario.config || [{ table_prefix: 'test', partner_id: 'P1', site_id: null }]);
  if (q.includes('from meu_member_linking where')) return result(scenario.link === false ? [] : [{ member_id: 'M1', external_id: args[q.includes('where partner_id') ? 1 : 0] }]);
  if (q.startsWith('select 1 from meu_test_transactions')) return result(scenario.existing ? [{}] : []);
  if (q.startsWith('insert into public.meu_log')) return result([{ id: 1 }]);
  return result([]);
}
class Pool { async connect() { return { query, release() {} }; } async query(q, a) { return query(q, a); } }
const pg = require.resolve('pg');
require.cache[pg] = { id: pg, filename: pg, loaded: true, exports: { Pool } };
console.log = console.error = console.table = () => {};
const { handler } = require('../index');
async function invoke(path, body, key = 'test-key') {
  const r = await handler({ version: '2.0', rawPath: path, rawQueryString: '', headers: { 'content-type': 'application/json', 'x-api-key': key }, requestContext: { stage: '$default', http: { method: 'POST', path } }, body: JSON.stringify(body) }, {});
  return { status: r.statusCode, body: JSON.parse(r.body) };
}
const linkBody = () => ({ programId: 'PR1', venueId: 'V1', externalMembershipId: 'E1' });
const cartPayload = () => ({ programId: 'PR1', venue: { id: 'V1' }, membership: { externalId: 'E1', mobile: '123' }, cart: { id: 'C1', items: [], discounts: [] } });
function setup(options = {}) { scenario = options; seen.length = 0; }

const linkCases = [
  ['linked ID returns its value', {}, b => b, 200, 'E1'],
  ['mobile is not required', {}, b => b, 200, 'E1'],
  ['unlinked ID returns 404 even with mobile', { link: false }, b => ({ ...b, mobile: '123' }), 404],
  ['missing external ID returns 400', {}, b => ({ ...b, externalMembershipId: undefined }), 400],
  ['empty external ID returns 400', {}, b => ({ ...b, externalMembershipId: '' }), 400],
  ['missing program returns 400', {}, b => ({ ...b, programId: undefined }), 400],
  ['unknown program returns 404', { config: [] }, b => b, 404],
  ['ambiguous program returns 400', { config: [{ partner_id: 'P1' }, { partner_id: 'P2' }] }, b => ({ ...b, venueId: undefined }), 400],
  ['config failure returns 500', { fail: 'select distinct partner_id' }, b => b, 500],
  ['link failure returns 500', { fail: 'from meu_member_linking' }, b => b, 500],
  ['lookup does not create a link', {}, b => b, 200, 'E1'],
  ['lookup passes resolved partner and ID', {}, b => b, 200, 'E1'],
];
for (const [name, config, change, status, expected] of linkCases) test(`membership-link: ${name}`, async () => {
  setup(config); const r = await invoke('/meu/membership-link', change(linkBody()));
  assert.equal(r.status, status);
  if (expected) assert.equal(r.body.membershipId, expected);
  assert.equal(seen.some(x => x.q.startsWith('insert into meu_member_linking')), false);
  if (name.includes('resolved partner')) assert.deepEqual(seen.find(x => x.q.includes('from meu_member_linking')).args, ['P1', 'E1']);
});

for (const type of ['cart-submitted', 'cart-claimed']) {
  const cases = [
    ['linked cart stored', {}, p => p, 200, false, true],
    ['missing membership skipped', {}, p => ({ ...p, membership: undefined }), 200, true, false],
    ['missing external ID skipped', {}, p => ({ ...p, membership: { mobile: '123' } }), 200, true, false],
    ['unlinked ID skipped even with phone', { link: false }, p => p, 200, true, false],
    ['missing program rejected', {}, p => ({ ...p, programId: undefined }), 400, false, false],
    ['missing venue rejected', {}, p => ({ ...p, venue: undefined }), 400, false, false],
    ['missing cart rejected', {}, p => ({ ...p, cart: undefined }), 400, false, false],
    ['missing cart ID rejected', {}, p => ({ ...p, cart: { items: [], discounts: [] } }), 400, false, false],
    ['unknown venue skipped', { config: [] }, p => p, 200, true, false],
    ['unsafe table prefix skipped', { config: [{ table_prefix: 'bad;drop', partner_id: 'P1' }] }, p => p, 200, true, false],
    ['lookup failure returns 500', { fail: 'from meu_member_linking' }, p => p, 500, false, false],
    ['wrong key rejected', { badKey: true }, p => p, 401, false, false],
    ['existing cart handled without insert', { existing: true }, p => p, 200, type === 'cart-submitted', false],
  ];
  for (const [name, config, change, status, skipped, inserted] of cases) test(`${type}: ${name}`, async () => {
    setup(config); const r = await invoke('/meu/webhooks', { type, payload: change(cartPayload()) }, config.badKey ? 'wrong' : 'test-key');
    assert.equal(r.status, status);
    assert.equal(r.body.skipped === true, skipped);
    assert.equal(seen.some(x => x.q.startsWith('insert into meu_test_transactions')), inserted);
    if (name === 'linked cart stored') {
      assert.deepEqual(seen.find(x => x.q.includes('from meu_member_linking')).args, ['E1', 'P1']);
      assert.equal(seen.find(x => x.q.startsWith('insert into meu_test_transactions')).args[3], 'E1');
    }
    if (name === 'existing cart handled without insert' && type === 'cart-claimed') assert.ok(seen.some(x => x.q.startsWith('update meu_test_transactions')));
  });
}
