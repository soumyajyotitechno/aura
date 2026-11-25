'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'production';
process.env.MEU_API_KEY = 'external-id-test-key';
process.env.MEU_DUMMY_MODE = 'false';
process.env.MEU_LOG_BODIES = 'false';
process.env.MEU_BASE_URL = 'https://meu.test';
process.env.MEU_PROVIDER_ID = 'test-provider';

const queries = [];
const linked = (externalId) => !String(externalId || '').includes('missing');

function result(rows = []) {
  return { rows, rowCount: rows.length };
}

async function query(sql, params = []) {
  const compact = sql.replace(/\s+/g, ' ').trim().toLowerCase();
  queries.push({ sql: compact, params });

  if (compact.includes('insert into public.meu_log')) return result([{ id: 1 }]);
  if (compact.startsWith('update public.meu_log')) return result([]);
  if (compact.includes('registration_referrer_id') && compact.includes('from meu_partner_program_config')) {
    return result([{ partner_id: 'PARTNER-1', registration_referrer_id: 'REFERRER-1' }]);
  }
  if (compact.includes('select distinct partner_id from meu_partner_program_config')) {
    if (params[0] === 'UNKNOWN') return result([]);
    if (params[0] === 'AMBIGUOUS' && !params[1]) return result([{ partner_id: 'PARTNER-1' }, { partner_id: 'PARTNER-2' }]);
    return result([{ partner_id: 'PARTNER-1' }]);
  }
  if (compact.includes('select partner_id from meu_partner_program_config')) return result([{ partner_id: 'PARTNER-1' }]);
  if (compact.includes('from meu_partner_program_config c left join partner_redemption_rule')) {
    return result([{ partner_id: 'PARTNER-1', program_id: 'PROGRAM-1', min_dollars: 0, max_dollars: 0 }]);
  }
  if (compact.includes('from meu_partner_program_config c join aura_partner')) {
    return result([{ table_prefix: 'testpartner', partner_id: 'PARTNER-1', site_id: null }]);
  }
  if (compact.includes('select 1 from meu_partner_program_config')) return result([{ '?column?': 1 }]);
  if (compact.includes('from meu_member_linking where external_id')) {
    return linked(params[0]) ? result([{ member_id: 'AURA-MEMBER-1', external_id: params[0] }]) : result([]);
  }
  if (compact.includes('from meu_member_linking where partner_id')) {
    return params[0] === 'PARTNER-1' && linked(params[1]) ? result([{ external_id: params[1] }]) : result([]);
  }
  if (compact.includes('from aura_customer')) throw new Error('Unexpected customer table access');
  if (compact.includes('from meu_aura_offers') && compact.includes('where active = 1 and id=$1')) {
    return result([{ id: '1', type: 'PointShopOffer', code: 'OFFER-500', name: '5 off', pointsPrice: 500, status: 'SELECTED_TO_REDEEM', discountAmountInCents: 500 }]);
  }
  if (compact.includes('from meu_aura_offers')) {
    return result([{ id: 1, off_type: 'PointShopOffer', off_price: '5', off_price_cent: 500, off_description: 'Five dollars off' }]);
  }
  if (compact.includes('insert into meu_member_linking')) return result([{ member_id: params[0] }]);
  if (compact.startsWith('select 1 from meu_')) return result([]);
  return result([]);
}

class FakePool {
  async connect() {
    return { query, release() {} };
  }
  async query(sql, params) {
    return query(sql, params);
  }
}

const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: FakePool } };

const axios = require('axios');
axios.get = async () => ({ status: 200, data: { success: true, valid: true, balance: 25 } });
axios.post = async (url) => {
  if (url.includes('/memberships')) return { status: 202, data: { status: 'accepted' } };
  if (url.includes('/v2/registerMember')) return { status: 200, data: { auraNumber: 'AURA-MEMBER-1', referFriendId: 'EXT-REGISTER-1', referrerId: 'REFERRER-1' } };
  if (url.includes('/createMember-test')) return { status: 200, data: { success: true } };
  return { status: 200, data: { success: true, amountRedeemed: 500, remainingBalance: 20 } };
};

const quiet = () => {};
console.log = quiet;
console.error = quiet;
console.table = quiet;

const { handler } = require('../index');

async function invoke(pathname, body, key = 'external-id-test-key') {
  const response = await handler({
    version: '2.0',
    rawPath: pathname,
    rawQueryString: '',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    requestContext: { stage: '$default', http: { method: 'POST', path: pathname } },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  }, { callbackWaitsForEmptyEventLoop: true });
  return { status: response.statusCode, body: JSON.parse(response.body) };
}

const validMembership = (n = 1) => ({ externalId: `EXT-${n}`, mobile: '0400000000', email: 'member@example.test' });
const validCart = () => ({ venueId: 'VENUE-1', items: [{ id: 'item-1', name: 'Coffee', quantity: 1, amountInCents: 1000 }], discounts: [] });
const validWebhook = (n = 1) => ({
  programId: 'PROGRAM-1',
  programName: 'Program',
  membership: validMembership(n),
  venue: { id: 'VENUE-1' },
  cart: { id: `cart-${n}`, submittedAt: '2026-11-24T00:00:00.000Z', items: [], discounts: [] },
});

const cases = (count, create) => Array.from({ length: count }, (_, index) => create(index));

for (const item of cases(20, (index) => {
  if (index === 0) return { name: 'rejects an invalid API key', body: { programId: 'PROGRAM-1', payload: { venueId: 'VENUE-1' } }, key: 'bad-key', status: 401 };
  if (index === 1) return { name: 'requires programId', body: { payload: { venueId: 'VENUE-1' } }, status: 400 };
  if (index === 2) return { name: 'requires payload', body: { programId: 'PROGRAM-1' }, status: 400 };
  if (index === 3) return { name: 'requires venueId', body: { programId: 'PROGRAM-1', payload: {} }, status: 400 };
  return { name: `links external id ${index}`, body: { programId: 'PROGRAM-1', payload: { venueId: 'VENUE-1', memberId: `AURA-${index}`, externalId: `EXT-${index}` } }, status: 202 };
})) {
  test(`auto-linking: ${item.name}`, async () => {
    const start = queries.length;
    const response = await invoke('/meu/auto-linking', item.body, item.key);
    assert.equal(response.status, item.status);
    const inserts = queries.slice(start).filter(({ sql }) => sql.startsWith('insert into meu_member_linking'));
    if (item.status === 202) {
      assert.equal(inserts.length, 1);
      assert.deepEqual(inserts[0].params, [item.body.payload.memberId, item.body.payload.externalId, 'PARTNER-1', item.body.programId]);
    } else {
      assert.equal(inserts.length, 0);
    }
  });
}

for (const item of cases(20, (index) => {
  if (index === 0) return { name: 'requires external ID', body: { programId: 'PROGRAM-1' }, status: 400 };
  if (index === 1) return { name: 'requires programId', body: { externalMembershipId: 'EXT-1' }, status: 400 };
  if (index === 2) return { name: 'returns 404 for an unlinked member', body: { programId: 'PROGRAM-1', externalMembershipId: 'missing-1', mobile: '0400000000' }, status: 404 };
  return { name: `finds external id ${index}`, body: { programId: 'PROGRAM-1', mobile: '0400000000', externalMembershipId: `EXT-${index}` }, status: 200 };
})) {
  test(`membership-link: ${item.name}`, async () => {
    const response = await invoke('/meu/membership-link', item.body);
    assert.equal(response.status, item.status);
    if (item.status === 200) assert.equal(response.body.membershipId, item.body.externalMembershipId);
  });
}

for (const item of cases(20, (index) => {
  if (index === 0) return { name: 'rejects an invalid API key', body: { venueId: 'VENUE-1', programId: 'PROGRAM-1', membership: validMembership() }, key: 'bad-key', status: 401 };
  if (index === 1) return { name: 'requires venueId', body: { programId: 'PROGRAM-1', membership: validMembership() }, status: 400 };
  if (index === 2) return { name: 'requires programId', body: { venueId: 'VENUE-1', membership: validMembership() }, status: 400 };
  if (index === 3) return { name: 'requires externalId', body: { venueId: 'VENUE-1', programId: 'PROGRAM-1', membership: {} }, status: 400 };
  if (index === 4) return { name: 'rejects an unlinked external id', body: { venueId: 'VENUE-1', programId: 'PROGRAM-1', membership: validMembership('missing-1') }, status: 404 };
  return { name: `gets balance for external id ${index}`, body: { venueId: 'VENUE-1', programId: 'PROGRAM-1', membership: validMembership(index), cart: validCart() }, status: 200 };
})) {
  test(`points-balance: ${item.name}`, async () => {
    const response = await invoke('/meu/points-balance', item.body, item.key);
    assert.equal(response.status, item.status);
    if (item.status === 200) assert.equal(response.body.membership.id, item.body.membership.externalId);
  });
}

for (const item of cases(20, (index) => {
  if (index === 0) return { name: 'rejects an invalid API key', body: { membership: validMembership(), cart: validCart(), rewards: { offer: 1 } }, key: 'bad-key', status: 401 };
  if (index === 1) return { name: 'requires cart venue', body: { membership: validMembership(), cart: {}, rewards: { offer: 1 } }, status: 400 };
  if (index === 2) return { name: 'requires externalId', body: { membership: {}, cart: validCart(), rewards: { offer: 1 } }, status: 400 };
  if (index === 3) return { name: 'requires array cart items', body: { membership: validMembership(), cart: { venueId: 'VENUE-1', items: {} }, rewards: { offer: 1 } }, status: 400 };
  if (index === 4) return { name: 'rejects an unlinked external id', body: { membership: validMembership('missing-2'), cart: validCart(), rewards: { offer: 1 } }, status: 404 };
  return { name: `redeems external id ${index}`, body: { membership: validMembership(index), cart: validCart(), rewards: { offer: 1 } }, status: 200 };
})) {
  test(`apply-reward: ${item.name}`, async () => {
    const response = await invoke('/meu/apply-reward', item.body, item.key);
    assert.equal(response.status, item.status);
  });
}

for (const item of cases(20, (index) => {
  if (index === 0) return { name: 'rejects an invalid API key', body: { type: 'cart-submitted', payload: validWebhook() }, key: 'bad-key', status: 401 };
  if (index === 1) return { name: 'acknowledges unknown events', body: { type: 'future-event', payload: {} }, status: 200 };
  if (index === 2) return { name: 'requires a cart payload', body: { type: 'cart-submitted', payload: {} }, status: 400 };
  if (index === 3) return { name: 'skips claimed cart without external id', body: { type: 'cart-claimed', payload: { ...validWebhook(), membership: {} } }, status: 200 };
  if (index === 4) return { name: 'skips unlinked claimed cart', body: { type: 'cart-claimed', payload: validWebhook('missing-3') }, status: 200 };
  return { name: `stores cart using external id ${index}`, body: { type: index % 2 ? 'cart-submitted' : 'cart-claimed', payload: validWebhook(index) }, status: 200 };
})) {
  test(`webhooks: ${item.name}`, async () => {
    const response = await invoke('/meu/webhooks', item.body, item.key);
    assert.equal(response.status, item.status);
    if (item.name.startsWith('skips')) assert.equal(response.body.skipped, true);
    if (item.name.startsWith('stores')) assert.equal(response.body.skipped, undefined);
  });
}

test('membership-link requires a venue when the program spans partners', async () => {
  const response = await invoke('/meu/membership-link', { programId: 'AMBIGUOUS', externalMembershipId: 'EXT-1' });
  assert.equal(response.status, 400);
});

test('unlinked submitted cart is skipped even if a mobile is present', async () => {
  const start = queries.length;
  const response = await invoke('/meu/webhooks', { type: 'cart-submitted', payload: validWebhook('missing-1') });
  assert.equal(response.body.skipped, true);
  assert.equal(queries.slice(start).some(({ sql }) => sql.startsWith('insert into meu_testpartner_transactions')), false);
});

for (const item of cases(20, (index) => {
  if (index === 0) return { name: 'rejects an invalid API key', body: { programId: 'PROGRAM-1', membership: validMembership() }, key: 'bad-key', status: 401 };
  if (index === 1) return { name: 'requires mobile', body: { programId: 'PROGRAM-1', membership: {} }, status: 400 };
  if (index === 2) return { name: 'requires programId', body: { membership: validMembership() }, status: 400 };
  return { name: `registers and links external id ${index}`, body: { programId: 'PROGRAM-1', venueId: 'VENUE-1', membership: { ...validMembership(index), firstName: 'Test', lastName: 'Member' } }, status: 200 };
})) {
  test(`register-member: ${item.name}`, async () => {
    const response = await invoke('/meu/register-member', item.body, item.key);
    assert.equal(response.status, item.status);
    if (item.status === 200) assert.equal(response.body.membership.id, 'EXT-REGISTER-1');
  });
}

test('source has no runtime me&u membership-id dependency', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.doesNotMatch(source, /membership_id|membership\.id|resolvedMembershipId/);
});

test('all database access during the suite is membership-id-free', () => {
  assert.equal(queries.some(({ sql }) => /membership_id/.test(sql)), false);
});
