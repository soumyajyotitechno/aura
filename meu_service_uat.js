require('dotenv').config(); // no-op in Lambda (no .env there); loads local env for `node index.js`
const { Pool } = require('pg');
const express = require('express');
const serverless = require('serverless-http');
const axios = require('axios')
const crypto = require('crypto');
// const verifyImposSignature = require('./verifyImposSignature'); // TODO: restore once you have the real file -- the local stub was removed
const app = express();
const IS_TESTING = true;

// API hit log: one line per request (method, path, status, ms) for EVERY route. me&u routes also print the request and
// response bodies, with mobile/email masked; headers and query strings are never logged. MEU_LOG_BODIES=false turns bodies off.
const LOG_BODIES = process.env.MEU_LOG_BODIES !== 'false';
const maskPii = (k, v) => (String(k).match(/^(mobile|phone|email)$/i) && typeof v === 'string' ? v.replace(/.(?=.{3})/g, '*') : v);
app.use((req, res, next) => {
  const start = Date.now();
  const json = res.json.bind(res);
  res.json = (body) => { // logged here, before the reply goes out, so Lambda can't freeze before the line is written
    console.log(`[API] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`);
    if (LOG_BODIES && req.path.match(/^\/(meu\/|auto-linking)/)) {
      console.log('[API] in :', JSON.stringify(req.body, maskPii));
      console.log('[API] out:', JSON.stringify(body, maskPii));
    }
    return json(body);
  };
  next();
});

// Capture raw body + parse JSON in one step
app.use(express.json({
  limit: '5mb',
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8'); // raw body string for HMAC
  }
}));



const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.HOST,
  database: process.env.DBNAME,
  password: process.env.DB_PASSWORD,
  port: process.env.PORT,
});

async function queryDatabase(query, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(query, params);
    return res.rows;
  } catch (err) {
    console.error('Database query error:', err);
    throw err; // Propagate error to be caught by calling function
  } finally {
    client.release();
  }
}


const SERVER_ERROR={ success: false, "errorCode": "SYSTEM_ERROR", "errorMessage": "Internal server error" }
// Routes
app.get('/test', async (req, res) => {
  try {
     res.json({msg :"working...meu service UAT"});
   // res.json(req.headers);
  } catch (err) {
    res.status(500).json({ message: 'Internal Server Error', error: err.message });
  }
});




/**
 * Store an error log in withdrawal_error_logs table
 * @param {Object} logData
 * @param {Object} logData.requestPayload - JSON object of the request
 * @param {Object} logData.responsePayload - JSON object of the response
 * @param {string} logData.recordId - Optional record identifier
 * @param {string} logData.memberId - UUID of the member
 * @param {string} logData.eventType - Type of event (e.g., "withdrawal")
 * @param {string} logData.errorType - Type of error (e.g., "DB_ERROR")
 * @param {string} logData.errorMessage - Error message text
 */


async function storeErrorLog({
  requestPayload = null,
  responsePayload = null,
  recordId = null,
  memberId = null,
  eventType = null,
  errorType = null,
  errorMessage = null,
  withdrawalPartner =null
}) {
  const query = `
    INSERT INTO withdrawal_error_logs (
      request_payload, response_payload, record_id, member_id,
      event_type, error_type, error_message, withdrawal_partner, created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7,$8, NOW())
    RETURNING *;
  `;

  const values = [
    requestPayload,
    responsePayload,
    recordId,
    memberId,
    eventType,
    errorType,
    errorMessage,
    withdrawalPartner
  ];

  try {
    const result = await queryDatabase(query, values);
    console.log('Error log stored:', result[0]);
    return result[0];
  } catch (err) {
    console.error('Failed to store error log:', err);
   // throw err;
  }
}

// Renamed from the pasted storeErrorLog to avoid overwriting the function above (same name, different
// table -- withdrawal_error_logs vs meu_log). Logic is exactly as given, just the name changed.
// The one place for any me&u-side error (auto-linking, membership-link, points-balance, apply-reward, webhooks).
async function storeMeuLog({ programId, membershipId = null, eventType, errorMessage }) {
  const query = `
    INSERT INTO public.meu_log (program_id, membership_id, event_type, error_message, created_at)
    VALUES ($1, $2, $3, $4, NOW())
    RETURNING id;
  `;

  const values = [programId, membershipId, eventType, errorMessage];

  try {
    const result = await pool.query(query, values);
    console.log("meu_log row written, id:", result.rows[0].id);
    return result.rows[0].id;
  } catch (err) {
    console.error("Failed to log error:", err.message);
  }
}



// ============================================================
// me&u -- Membership auto-linking (Aura -> me&u) and
// Membership linking on provider (me&u -> Aura)
// ============================================================
const MEU_BASE_URL = process.env.MEU_BASE_URL; // e.g. https://ap1-loyalty-connector.meandu.app
const MEU_PROVIDER_ID = process.env.MEU_PROVIDER_ID; // issued by me&u
const MEU_SIGNING_SECRET = process.env.MEU_SIGNING_SECRET || 'verysecret'; // issued by me&u, signs outbound requests

function signMeuPayload(payload) {
  console.log('Signing payload for me&u:', payload);

  let signature= crypto.createHmac('sha256', MEU_SIGNING_SECRET).update(payload).digest('hex');

  console.log('Signed payload for me&u:', signature);
  return signature;
}


// Saves me&u's membership id against the Aura member in meu_member_linking, using the memberId
// passed straight from the payload -- no lookup against aura_customer or any other table.
// partnerId is taken from the request payload as sent, not cross-checked against meu_partner_program_config.
// A call that omits it keeps whatever partner_id is already on the row, instead of clearing it.
// Never fails the request: me&u has already created the membership, so a DB problem only raises an alert.
async function meuSaveLink(programId, externalId, membershipId, memberId, partnerId) {
  if (!externalId || !membershipId || !memberId) {
    return console.log("me&u link not saved: payload.memberId, payload.externalId or the returned membership id is missing");
  }
  try {
    const rows = await queryDatabase(
      `INSERT INTO meu_member_linking (member_id, external_id, membership_id, partner_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (partner_id, member_id) DO UPDATE SET
         membership_id = EXCLUDED.membership_id,
         partner_id = COALESCE(EXCLUDED.partner_id, meu_member_linking.partner_id)
       RETURNING member_id`,
      [memberId, externalId, membershipId, partnerId]
    );
    console.log("[meu] link saved", JSON.stringify({ programId, externalId, membershipId, memberId: rows[0].member_id }));
    await storeMeuLog({ programId, membershipId, eventType: "MEU_AUTO_LINKING_SAVED", errorMessage: `link saved: externalId=${externalId}, memberId=${rows[0].member_id}` });
  } catch (err) {
    console.error("me&u link not saved:", err.message);
    await storeMeuLog({ programId, membershipId, eventType: "MEU_AUTO_LINKING", errorMessage: err.message });
  }
}


// POST /auto-linking
// Aura core -> here -> me&u. The program must be configured (meu_partner_program_config); on success the
// returned me&u membership id is saved to meu_member_linking.
app.post("/meu/auto-linking", async (req, res) => {
  if (!meuAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  console.log("req.body ==> ",req.body)
  const { programId, payload } = req.body || {};

  if (!programId || !payload) {
    return res.status(400).json({ error: "programId and payload are required" });
  }
  if (!payload.venueId) {
    return res.status(400).json({ error: "payload.venueId is required" });
  }

  try {
    const configured = await queryDatabase(
      `SELECT partner_id FROM meu_partner_program_config WHERE venue_id = $1 AND active = true LIMIT 1`,
      [payload.venueId]
    );
    if (!configured.length) return res.status(404).json({ error: "Program not configured for me&u" });
    const partnerId = configured[0].partner_id; // sourced from config, never trusted from the request payload

    let status, data;
    if (process.env.MEU_DUMMY_MODE === "true") {
      // skip the outbound call and return a fake membership (unique id: the link table keeps one row per me&u membership)
      console.log("MEU_DUMMY_MODE: skipping me&u call for programId", programId);
      status = 202;
      data = { status: 202, body: { id: `${Date.now()}` } };
    } else {
      const bodyString = JSON.stringify(payload);

      const response = await axios.post(
        `${MEU_BASE_URL}/v0/membership-programs/${programId}/memberships`,
        bodyString,
        {
          headers: {
            "x-provider-id": MEU_PROVIDER_ID,
            "x-signature-sha256": signMeuPayload(bodyString),
            "Content-Type": "application/json",
          },
        }
      );
      
      status = response.status;
      data = response.data;
    }

    await meuSaveLink(programId, payload.externalId, data && (data.id || (data.body && data.body.id)), payload.memberId, partnerId);
    return res.status(status).json(data);
  } catch (error) {
    console.error("Error in /auto-linking:", error);
    await storeMeuLog({ programId, eventType: "MEU_AUTO_LINKING", errorMessage: error.response ? JSON.stringify(error.response.data) : error.message });
    return res.status(error.response ? error.response.status : 500).json({
      error: "Failed to auto-link membership",
      detail: error.response ? error.response.data : error.message,
    });
  }
});




// POST /meu/membership-link
// "Membership linking on provider" (me&u -> Aura): Loyalty Connector ->
// Loyalty Provider (us). Recognises a loyalty membership that was created
// OUTSIDE me&u Order&Pay -- Connector calls us so we can associate that
// membership with the guest.
//

// Not-found behaviour (member with that mobile doesn't exist in aura_customer)
// isn't specified in me&u's docs -- returns 404 here, our own judgement call.


app.post('/meu/membership-link', async (req, res) => {

  const { guestId, externalMembershipId, mobile, email, venueId, programId } = req.body || {};

  console.table(req.body)
  let client;
  let status = 'success';
  let message = 'Membership linked successfully';

  try {
    client = await pool.connect();
// validate mobile no
    if (!mobile) {
      status = 'error';
      message = 'mobile is required';
      return res.status(400).json({ message });
    }

    // Validate against our config + link table. Read-only: search/link never inserts anything.
    if (programId) {
      const configured = await client.query(
        `SELECT 1 FROM meu_partner_program_config WHERE program_id = $1 AND active = true LIMIT 1`,
        [programId]
      );
      if (configured.rowCount === 0) {
        status = 'error';
        message = 'Program not configured for me&u';
        return res.status(404).json({ message });
      }

      // an id we already linked on this program beats a phone/email match
      if (externalMembershipId) {
        const linked = await client.query(
          `SELECT external_id FROM meu_member_linking WHERE program_id = $1 AND membership_id = $2`,
          [programId, externalMembershipId]
        );
        if (linked.rowCount > 0) {
          message = 'Membership already linked';
          return res.status(200).json({ membershipId: linked.rows[0].external_id });
        }
      }
    } else {
      status = 'error';
      message = 'programId is required';
      return res.status(400).json({ message });
    }

    // Search for an existing membership created outside me&u (same lookup)

    const memberResult = await client.query(
      `SELECT member_id, referral_id
       FROM aura_customer
       WHERE phone = $1 OR email = $2
       LIMIT 1`,
      [mobile, email || null]
    );

    if (memberResult.rowCount === 0) {
      status = 'error';
      message = 'Member not found';
      console.log(message, { guestId, externalMembershipId, mobile, email, venueId, programId });
      return res.status(404).json({ message });
    }

    const { referral_id: membershipId } = memberResult.rows[0];

    console.log('membership linked >>', membershipId, 'guestId >>', guestId);
    return res.status(200).json({ membershipId });

  } catch (err) {
    console.error('Error in /meu/membership-link:', err);
    status = 'error';
    message = err.message;
    await storeMeuLog({ programId, membershipId: externalMembershipId, eventType: 'MEU_MEMBERSHIP_LINKING', errorMessage: err.message });
    return res.status(500).json({ message });
  } finally {
    const insertLogQuery = `
      INSERT INTO aura_logs (api_url, status, msg, created_date, ip)
      VALUES ($1, $2, $3, $4, $5)
    `;
    try {
      if (client) await client.query(insertLogQuery, ['/meu/membership-link', status, message, new Date(), req.ip || 'Unknown IP']);
    } catch (logError) {
      console.error('Error inserting log entry:', logError.stack);
    }
    if (client) client.release();
  }
});




// ---- me&u "Displaying points balance and rewards" (me&u -> Aura) ----
// Hot: me&u calls this on every venue home / cart view and every cart change, so it stays thin --
// no aura_logs on success, and the balance call never writes anything.
// Offers/deals/promo codes are out of scope: `rewards` holds at most the one cashback PointShopOffer.
const API_KEY = process.env.MEU_API_KEY; // checked as x-api-key on /auto-linking, /meu/webhooks, /meu/apply-reward, and /meu/points-balance

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Fails closed: if the key isn't configured, only local dummy mode gets through.
function meuAuthOk(req) { 
  return safeEqual(req.get('x-api-key'), API_KEY);
}

// venue -> Aura partner + its redemption limits (+ the program the venue is configured under). The reward
// application call carries no program id, so the venue alone picks the active config row (newest if there
// were ever several). Config rarely changes, so keep hits in Lambda memory for 5 min (a deactivated venue
// can linger that long). Misses aren't cached.
const meuPartnerCache = new Map();
async function getMeuPartner(venueId) {
  const hit = meuPartnerCache.get(venueId);
  if (hit && hit.exp > Date.now()) return hit.partner;

  const rows = await queryDatabase(
    `SELECT c.partner_id, c.program_id, r.redemption_min_withdrawal AS min_dollars, r.redemption_max_withdrawal AS max_dollars
     FROM meu_partner_program_config c
     LEFT JOIN partner_redemption_rule r ON r.partner_id = c.partner_id AND r.is_active = true
     WHERE c.venue_id = $1 AND c.active = true
     ORDER BY c.id DESC
     LIMIT 1`,
    [venueId]
  );
  if (!rows.length) return null;
  const partner = {
    partnerId: rows[0].partner_id,
    programId: rows[0].program_id,
    minCents: Math.round(Number(rows[0].min_dollars || 0) * 100),
    maxCents: Math.round(Number(rows[0].max_dollars || 0) * 100), // 0 = no maximum
  };
  meuPartnerCache.set(venueId, { partner, exp: Date.now() + 5 * 60 * 1000 });
  return partner;
}

// Balance in cents (1 point = 1 cent) from the Redemption Service `enquiry`, the same source the IMPOS
// routes trust (it returns dollars). MEU_DUMMY_MODE skips the call so this runs locally without touching
// the real service: externalId "dummy-<dollars>" (e.g. dummy-30) gives that balance, anything else 12.34.
async function getMeuBalanceCents(partnerId, externalId) {
  let data;
  if (process.env.MEU_DUMMY_MODE === 'true') {
    const m = /^dummy-(\d+(?:\.\d+)?)$/.exec(externalId);
    data = { success: true, valid: true, balance: (m ? Number(m[1]) : 12.34) - (meuDummyDeducted.get(externalId) || 0) / 100 };
  } else {
    // Balance from the me&u `meu/points` URL (same one /meu/points-balance uses), not `enquiry`.
    try {
      const response = await axios.get(`https://jqzlxs0nr9.execute-api.ap-southeast-2.amazonaws.com/v1/meu/points?partnerId=${encodeURIComponent(partnerId)}&externalId=${encodeURIComponent(externalId)}`);
      data = response.data;
    } catch (err) {
      data = err.response ? err.response.data : { success: false, errorMessage: err.message };
    }
  }
  if (!data.success) return { error: data.errorMessage || 'Member not found' };
  const cents = data.points != null
    ? Number(data.points)
    : (data.totalPoints != null
        ? Number(data.totalPoints)
        : (data.valid ? Math.round(Number(data.balance || 0) * 100) : 0));
  return { cents };
}

// ---- the one points offer (PointShopOffer); used by /meu/apply-reward (meuApply) ----
// /meu/points-balance is standalone below and does not use this -- it has its own, independent
// copy of this calc so it never shares code with any other route.
// Applying DEDUCTS the cashback straight away (Redemption Service `redeem`). There is no hold, expiry or auto-refund:
// if the guest removes the reward or abandons the cart, giving the points back is me&u's call, not Aura's.
const MEU_OFFER_ID = 'aura-cashback';
// TODO(Redemption Service): confirm it accepts these for me&u (IMPOS sends 'instore' / 'IMPOS').
const MEU_WITHDRAWAL_TYPE = process.env.MEU_WITHDRAWAL_TYPE || 'online';
const MEU_WITHDRAWAL_GATEWAY = process.env.MEU_WITHDRAWAL_GATEWAY || 'MEU';
const meuDummyDeducted = new Map(); // MEU_DUMMY_MODE only: cents "redeemed" so far per externalId, so local tests see the balance drop

const meuIsOurs = (d) => !!(d && d.metadata && d.metadata.externalRewardId === MEU_OFFER_ID);

// me&u sends the current cart on every call, including our discount from an earlier apply.
// That amount is what has already been deducted for this cart (apply-reward has no cart id to key on).
const meuAppliedCents = (cart) =>
  ((cart && cart.discounts) || []).filter(meuIsOurs).reduce((s, d) => s + (Number(d.amountInCents) || 0), 0);

// What the reward can be applied against: items minus every discount that isn't ours (we recompute ours).
// Only discounts with isInternal === false count; internal ones' amountInCents is not taken.
// TODO(me&u): is items[].amountInCents a line total or a unit price? Read as a line total (the lower, safer reading).
function meuApplicableCents(cart) {
  if (!cart) return 0;
  const items = (cart.items || []).reduce((s, i) => s + (Number(i.amountInCents) || 0), 0);
  const others = (cart.discounts || []).filter((d) => !meuIsOurs(d) && d.isInternal === false).reduce((s, d) => s + (Number(d.amountInCents) || 0), 0);
  return Math.max(0, items - others);
}

// spendable = what's left on the balance + what this cart already had deducted; the cap never exceeds the cart, so the total can't go below $0.
function meuCalc(balanceCents, appliedCents, applicableCents, partner) {
  const spendable = balanceCents + appliedCents;
  const cap = Math.min(spendable, applicableCents, partner.maxCents > 0 ? partner.maxCents : Infinity);
  let cause = null;
  if (spendable <= 0) cause = { code: 'INSUFFICIENT_POINTS', message: 'Not enough points' };
  else if (applicableCents <= 0) cause = { code: 'EMPTY_CART', message: 'Add items to use your cashback' };
  else if (cap < partner.minCents) cause = { code: 'BELOW_MINIMUM', message: `Minimum redemption is $${(partner.minCents / 100).toFixed(2)}` };
  return { spendable, cap, cause };
}

// selectedCents > 0 = shown as applied at that amount
function meuOffer(calc, selectedCents) {
  const base = { id: MEU_OFFER_ID, type: 'PointShopOffer', name: 'Use your Aura cashback', description: 'Spend your cashback on this order' };
  if (calc.cause) return { ...base, pointsPrice: calc.spendable, status: 'UNAVAILABLE_TO_REDEEM', nonRedeemableCause: calc.cause };
  if (selectedCents > 0) return { ...base, pointsPrice: selectedCents, status: 'SELECTED_TO_REDEEM', discountAmountInCents: selectedCents };
  return { ...base, pointsPrice: calc.cap, status: 'AVAILABLE_TO_REDEEM' };
}

// Deduct `cents` from the member's cashback. The Redemption Service `amount` is in cents (as in the IMPOS redeem).
// MEU_DUMMY_MODE never calls the real service.


// Returns the most that can be redeemed on this cart (in cents), from the payload only.
function getRedemptionAmount(body) {
  const items = body.cart?.items || [];
  const discounts = body.cart?.discounts || [];
  const sum = (arr) => arr.reduce((s, x) => s + (Number(x.amountInCents) || 0), 0);

  return Math.max(0, sum(items) - sum(discounts.filter((d) => d.isInternal === false)));
}

async function meuRedeem(partnerId, externalId,cents) {
  if (process.env.MEU_DUMMY_MODE === 'true') {
    meuDummyDeducted.set(externalId, (meuDummyDeducted.get(externalId) || 0) + 500);
    return { success: true };
  }
  try {

    const orderId = `${process.hrtime.bigint()}_${crypto.randomUUID()}`;
    const transactionRef = `${process.hrtime.bigint()}_${crypto.randomUUID()}`;
    const response = await axios.post(
      'https://jqzlxs0nr9.execute-api.ap-southeast-2.amazonaws.com/v1/redeem',
      {
        partnerId,
        barcodeText: externalId,
        orderId: "meu-"+orderId,
        transactionRef:"meu-"+ transactionRef,
        amount: cents,
        withdrawalType: 'redemption',
        withdrawalInstrument: 'Halo_Loyalty_Card',
        tipAmount: 0,
        withdrawalGateWay: 'me&u',
      }
    );
    return {
      statusCode: response.status,
      ...response.data
    };
  } catch (err) {
    if (err.response) {
      return {
        statusCode: err.response.status,
        ...err.response.data
      };
    }
    throw err;
  }
}

// The guest tapped Apply: deduct whatever the cart doesn't already carry. One apply at a time per member+partner
// (advisory lock), so a parallel tap reads the balance after this deduction. Nothing is written to our own tables.
async function meuApply({ partner, externalId, cart }) {
  
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${externalId}|${partner.partnerId}`]);

    const balance = await getMeuBalanceCents(partner.partnerId, externalId);
    if (balance.error) {
      await client.query('ROLLBACK');
      return { error: balance.error };
    }
    const calc = meuCalc(balance.cents, applied, meuApplicableCents(cart), partner);

    // Only the part not already on the cart is deducted, so re-applying an unchanged cart deducts nothing.
    if (!calc.cause && calc.cap > applied) {
      const data = await meuRedeem(partner.partnerId, externalId, calc.cap - applied);
      console.log('[meu] redeem', JSON.stringify({ partnerId: partner.partnerId, externalId, cents: calc.cap - applied, dummy: process.env.MEU_DUMMY_MODE === 'true', success: !!data.success, errorCode: data.errorCode || null, remainingBalance: data.remainingBalance }));
      if (!data.success) {
        if (applied > 0) calc.cap = applied; // the top-up failed; what was already deducted stays applied
        else calc.cause = { code: 'REDEMPTION_FAILED', message: data.errorMessage || 'Could not use your cashback' };
      }
    }
    console.log('[meu] apply', JSON.stringify({ partnerId: partner.partnerId, externalId, balanceCents: balance.cents, appliedCents: applied, capCents: calc.cap, cause: calc.cause ? calc.cause.code : null }));
    await client.query('COMMIT');
    return { calc };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}













// POST /meu/points-balance -- STANDALONE route: does not call getMeuPartner, getMeuBalanceCents,
// meuCalc, meuOffer, meuApplicableCents, meuAppliedCents or callRedemptionService. It resolves the
// partner and redemption limits with its own inline query, and calls the me&u `meu/points` URL
// directly via axios -- nothing in this handler is shared with any other route.
// Read-only. pointsBalance is what is left after any deduction; a cart that already carries our discount shows as SELECTED.
// IN : { membership: { id, externalId, guestId, programId, mobile, firstName, lastName, email, birthday,
//        allowEmailMarketing, allowSMSMarketing }, cart?: { id, venueId, items: [{id,name,quantity,amountInCents,metadata?}],
//        discounts: [{isInternal,name,amountInCents,metadata?}] }, venueId, programId }
// OUT: { status: 'ok', membership: { id, pointsBalance, rewards: [] | [PointShopOffer] } }
app.post('/meu/points-balance', async (req, res) => {


  if (!meuAuthOk(req)) return res.status(401).json({ status: 'error', message: 'Unauthorized' });

  console.log("/meu/points-balance ==> ",req.body)
  try {
    const { membership, cart, venueId, programId } = req.body || {};
    if (!venueId || !programId) {
      return res.status(400).json({ status: 'error', message: 'venueId and programId are required' });
    }

    // At least one of membership.externalId or membership.id is required
    if (!membership || (!membership.externalId && !membership.id)) {
      return res.status(400).json({ status: 'error', message: 'membership.externalId or membership.id is required' });
    }

    const partner = await getMeuPartner(venueId);
    if (!partner) return res.status(404).json({ status: 'error', message: 'Venue not configured for me&u' });

    let externalId=null
    let membershipId = membership.id;
    let partnerId = partner?.partnerId;
    if (membership.id) {
      const linkRows = await queryDatabase(
        `SELECT external_id FROM meu_member_linking WHERE membership_id = $1 AND partner_id = $2 LIMIT 1`,
        [membership.id, partnerId]
      );
      if (!linkRows.length) {
        return res.status(404).json({ status: 'error', message: `Membership ID ${membership.id} not found in member linking for this program` });
      }
      externalId = linkRows[0].external_id;
    } 
    if(!externalId)
    {
        return res.status(400).json({ status: 'error', message: 'membership.id  is required' });
    }
 
    // Balance, straight from the me&u `meu/points` URL -- no callRedemptionService, no other helper, no dummy mode.
    // Used raw, exactly as the service returns it: no unit conversion.
    let pointsData;
    try {
      const response = await axios.get(`https://jqzlxs0nr9.execute-api.ap-southeast-2.amazonaws.com/v1/meu/points?partnerId=${partnerId}&externalId=${encodeURIComponent(externalId)}`);
      pointsData = response.data;
    } catch (err) {
      pointsData = err.response ? err.response.data : { success: false, errorMessage: err.message };
    }
    if (!pointsData.success) return res.status(404).json({ status: 'error', message: pointsData.errorMessage || 'Member not found' });
    const balance = pointsData.points != null
      ? Number(pointsData.points)
      : (pointsData.totalPoints != null
          ? Number(pointsData.totalPoints)
          : (pointsData.valid ? Number(pointsData.balance) || 0 : 0));

    
    return res.status(200).json({ status: 'ok', membership: { id: membershipId, pointsBalance: balance, rewards:[] } });
  } catch (err) {
    console.error('Error in /meu/points-balance:', err.message);
    await storeMeuLog({ programId: (req.body && req.body.programId) || 'unknown', membershipId: req.body && req.body.membership && req.body.membership.id, eventType: 'MEU_POINTS_BALANCE', errorMessage: err.message });
    return res.status(500).json({ status: 'error', message: 'Internal Server Error' });
  }
});











// POST /meu/apply-reward  ("Reward application", me&u -> Aura)
// The guest tapped Apply on the cashback offer. We DEDUCT the cashback now (no hold); me&u decides about any refund.
// IN : { membership?: { id, mobile, externalId }, cart: { venueId, items, discounts }, orderingType, rewards: { offer?, promoCode? } }
//      The request carries no program id: the partner is found from cart.venueId alone.
// OUT: { status: 'ok', rewards: [PointShopOffer] } -- SELECTED_TO_REDEEM with discountAmountInCents, or UNAVAILABLE_TO_REDEEM with a cause
app.post('/meu/apply-reward', async (req, res) => {
  if (!meuAuthOk(req)) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  let programId = 'unknown';
  try {
    const { membership, cart, rewards } = req.body || {};
    console.log("/meu/apply-reward ==> ",req.body)
    if (!cart || !cart.venueId) {
      return res.status(400).json({ status: 'error', message: 'cart.venueId is required' });
    }
    if (!membership || !membership.id) {
      return res.status(400).json({ status: 'error', message: 'membership.id is required' });
    }
    if ((cart.items != null && !Array.isArray(cart.items)) ||
        (cart.discounts != null && !Array.isArray(cart.discounts))) {
      return res.status(400).json({ status: 'error', message: 'cart.items and cart.discounts must be arrays' });
    }

    // Offers and promo codes out of scope
    if (!rewards || rewards.offer !== MEU_OFFER_ID) {
      return res.status(200).json({ status: 'ok', rewards: [] });
    }

    const membershipId = String(membership.id);

    const partner = await getMeuPartner(cart.venueId);
    if (!partner) return res.status(404).json({ status: 'error', message: 'Venue not configured for me&u' });
    programId = partner.programId;
    let partnerId = partner.partnerId;
    const linkRows = await queryDatabase(
      `SELECT external_id FROM meu_member_linking WHERE membership_id = $1 AND partner_id = $2 LIMIT 1`,
      [membershipId, partnerId]
    );
    if (!linkRows.length || !linkRows[0].external_id) {
      return res.status(404).json({ status: 'error', message: `Membership ID ${membershipId} not found in member linking for this program` });
    }
    const externalId = linkRows[0].external_id;

    // externalId is optional; if sent it must match. Never echo the linked value back.
    if (!externalId) {
      return res.status(400).json({ status: 'error', message: `Provided externalId does not match the linked membership ${membershipId}` });
    }
    const cents =  getRedemptionAmount(req.body);
    const result = await meuRedeem(partnerId, externalId,cents);
    console.log("RESPONSE " ,result)
    return res.status(result.statusCode).json({ status: result.success ? 'ok' : 'error', rewards: [], message:  (result.success ? 'Reward applied successfully' : 'Failed to apply reward') });
  } catch (err) {
    console.error('Error in /meu/apply-reward:', err.message);
    await storeMeuLog({
      programId,
      membershipId: req.body && req.body.membership && req.body.membership.id,
      eventType: 'MEU_APPLY_REWARD',
      errorMessage: `${err.message} | venue=${req.body && req.body.cart && req.body.cart.venueId}`
    });
    return res.status(500).json({ status: 'error', message: 'Internal Server Error' });
  }
});









// ============================================================
// me&u -- Webhook events (me&u -> Aura): cart-submitted, cart-claimed, marketing-consent-given
// ============================================================
// me&u's rule: respond immediately rather than once handling is finished. The only work we do
// before replying is a handful of DB inserts -- no outbound calls -- so the reply stays fast in
// practice. Rewards are NOT re-deducted here: /meu/apply-reward already deducted at apply time
// (no holds), so this endpoint only records the cart against meu_transactions / meu_sales /
// meu_payments (one header row, one row per item, one row per discount -- straight from the payload).

// externalId -> referral_id, then membership.id -> meu_member_linking (this program), then mobile -> phone.
async function meuResolveMember(client, membership, programId) {
  if (!membership) return null;
  let r;
  // aura_customer intentionally not used -- only members already known to meu_member_linking
  // resolve here. No mobile search: no me&u table stores a phone number.
  if (membership.externalId) {
    r = await client.query(
      `SELECT member_id, external_id AS referral_id FROM meu_member_linking WHERE external_id = $1 AND program_id = $2`,
      [membership.externalId, programId]
    );
    if (r.rowCount) return r.rows[0];
  }
  if (membership.id) {
    r = await client.query(
      `SELECT member_id, external_id AS referral_id FROM meu_member_linking WHERE membership_id = $1 AND program_id = $2`,
      [membership.id, programId]
    );
    if (r.rowCount) return r.rows[0];
  }
  return null;
}

// Stores the cart into that partner's OWN three tables (meu_<prefix>_transactions/_sales/_payments,
// resolved from venue+program), not a shared table -- one header row, one row per item, one row per
// discount. No aura_transactions_raw write any more; this replaces that entirely.

async function meuStoreCartEvent(payload, eventType) {
  const { programId, programName, membership, venue, cart } = payload || {};
  if (!programId || !venue || !venue.id || !cart || !cart.id) {
    throw Object.assign(new Error('programId, venue.id and cart.id are required'), { status: 400 });
  }

  // meu_transactions.trx_id IS cart.id -- nothing appended, nothing generated. Because
  // cart-submitted and cart-claimed share one cart.id, this can only have ONE row per cart:
  // the second event UPDATEs the first row (event_type moves to whichever came last) instead of
  // inserting a second one. A retried event safely re-applies to the same row instead of erroring.
  const transactionId = cart.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Resolve venue+program -> partner -> table_prefix. Everything now goes into that partner's OWN
    // meu_<prefix>_transactions/_sales/_payments -- not a shared table -- so without a resolvable,
    // safe prefix there is nowhere to insert at all. Table names can't be parameterized like values,
    // so the prefix is validated (letters/digits/underscore only) before it's ever put into SQL text.
    const partnerRows = await client.query(
      `SELECT p.table_prefix, p.partner_id, c.site_id
       FROM meu_partner_program_config c
       JOIN aura_partner p ON p.partner_id = c.partner_id
       WHERE c.venue_id = $1 AND c.program_id = $2 AND c.active = true
       LIMIT 1`,
      [venue.id, programId]
    );
    let prefix = partnerRows.rows[0] && partnerRows.rows[0].table_prefix;
    
    const partnerId = partnerRows.rows[0] && partnerRows.rows[0].partner_id;
    if (!prefix || !prefix.match(/^[a-z][a-z0-9_]*$/i)) {
      await client.query('ROLLBACK');
      console.log('[meu] webhook cart event skipped -- no partner/table_prefix resolved', JSON.stringify({ cartId: cart.id, venueId: venue.id, programId }));
      return { skipped: true };
    }
    const transactionsTable = `meu_${prefix}_transactions`;
    const salesTable = `meu_${prefix}_sales`;
    const paymentsTable = `meu_${prefix}_payments`;

    // Gate: only store if this me&u membership is already linked to a known Aura member.
    // Looked up by membership.id -> meu_member_linking.member_id; no membership, no match, or no
    // member_id on that row all mean skip -- nothing goes into the partner's transaction tables.
    // externalId is NOT taken from the payload -- it comes from this same meu_member_linking row.
    let memberId = null;
    let externalId = null;
    if (membership && membership.id) {
      const linked = await client.query(
        `SELECT member_id, external_id FROM meu_member_linking WHERE membership_id = $1 AND partner_id = $2 LIMIT 1`,
        [membership.id, partnerId]
      );
      if (linked.rowCount && linked.rows[0].member_id) {
        memberId = linked.rows[0].member_id;
        externalId = linked.rows[0].external_id || null;
      }
    }
    if (!memberId) {
      await client.query('ROLLBACK');
      console.log('[meu] webhook cart event skipped -- membership not linked', JSON.stringify({ cartId: cart.id, membershipId: membership && membership.id }));
      return { skipped: true };
    }

    // Check if transaction already exists: if already inserted, do not update or insert again
    const existing = await client.query(
      `SELECT 1 FROM ${transactionsTable} WHERE trx_id = $1 LIMIT 1`,
      [transactionId]
    );
    if (existing.rowCount) {
      await client.query('ROLLBACK');
      console.log('[meu] webhook cart event already inserted -- skipping without update', JSON.stringify({ cartId: cart.id }));
      return { alreadyExists: true };
    }

    // check_total = sum of every cart item's amountInCents (in cents), written to both transaction tables.
    const checkTotal = getFinalTrxAmount(payload)
   
    // Insert once:
    await client.query(
      `INSERT INTO ${transactionsTable}
         (trx_id, program_id, program_name, membership_id, membership_external_id, membership_program_id, membership_mobile, venue_id, submitted_at, event_type, check_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (trx_id) DO NOTHING`,
      [transactionId, programId, programName || null, membership ? membership.id : null, externalId,
       membership ? membership.programId : null, membership ? membership.mobile : null, venue.id,
       cart.submittedAt ? new Date(cart.submittedAt) : null, eventType, checkTotal]
    );

    // One sales row per product in the cart. Each item is inserted only if that item_id isn't already
    // stored for this trx_id, so a repeat adds nothing twice but a product missing from an earlier hit is still added.
    for (const item of cart.items || []) {
      const hasItem = await client.query(`SELECT 1 FROM ${salesTable} WHERE trx_id = $1 AND item_id = $2 LIMIT 1`, [transactionId, item.id]);
      if (hasItem.rowCount) continue;
      await client.query(
        `INSERT INTO ${salesTable} (trx_id, item_id, item_name, pos_id, amount_in_cents, quantity, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())`,
        [transactionId, item.id, item.name || null, (item.metadata && item.metadata.posId) || null, item.amountInCents, item.quantity]
      );
    }

    const hasPayments = await client.query(`SELECT 1 FROM ${paymentsTable} WHERE trx_id = $1 LIMIT 1`, [transactionId]);
    if (!hasPayments.rowCount) {
      for (const discount of cart.discounts || []) {
        const meta = discount.metadata || {};
        await client.query(
          `INSERT INTO ${paymentsTable} (trx_id, discount_type, discount_name, amount_in_cents, is_internal, external_reward_id, reward_type, promo_code, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())`,
          [transactionId, discount.type, discount.name, discount.amountInCents, !!discount.isInternal,
           meta.externalRewardId || null, meta.rewardType || null, meta.promoCode || null]
        );
      }
    }

    // ---- ALSO write into the REAL POS-ingestion tables (<prefix>_transactions/_sales/_payments),
    // alongside the me&u-only meu_<prefix>_* tables above. me&u's venue.id still isn't mapped to any
    // ONE of the partner's real site_ids, so every me&u order on a partner is attributed to the same
    // site: impos_sites' own "Testing Site" for that partner_id when one exists, else its lowest
    // site_id. If the partner has no row in impos_sites at all, siteId stays null and this is skipped
    // (site_id is NOT NULL on all three real tables).
    // const siteRows = partnerId
    //   ? await client.query(
    //       `SELECT site_id FROM impos_sites WHERE partner_id = $1
    //        ORDER BY (site_name ILIKE '%test%') DESC, site_id ASC LIMIT 1`,
    //       [partnerId]
    //     )                  // partner cnonfig theke asbe
    //   : { rows: [] };
    // const siteId = siteRows.rows[0] ? siteRows.rows[0].site_id : null;
    // site_id now comes from the meu_partner_program_config row matched above (partner + venue + program).
    const siteId = partnerRows.rows[0] && partnerRows.rows[0].site_id != null ? partnerRows.rows[0].site_id : null;

    if (siteId !== null) {
       
        if(IS_TESTING)
        {
            prefix = 'meu_impos_dummy'
        }
      const sourceTransactionsTable = `${prefix}_transactions`;
      const sourceSalesTable = `${prefix}_sales`;
      const sourcePaymentsTable = `${prefix}_payments`;
      const posUpdatedAt = cart.submittedAt ? new Date(cart.submittedAt) : new Date();

      // Header row. DO NOTHING (not DO UPDATE, unlike meu_<prefix>_transactions above): this table
      // is also written by the real POS ingestion pipeline, so a key collision must never let our
      // write clobber theirs.
      await client.query(     //check_total, member col er moddhe card json "cardNumber":"{externalId}"
        `INSERT INTO ${sourceTransactionsTable}
           (transaction_id, site_id, pos_updated_at, trx_raw_processed, member, check_total,
            order_state, payment_state, void_state,source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, $10)
         ON CONFLICT (transaction_id, site_id) DO NOTHING`,
        [transactionId, siteId, posUpdatedAt, IS_TESTING,
         externalId ? JSON.stringify({ cardNumber: externalId }) : null, checkTotal != null ? checkTotal / 100 : null,
         'completed', 'paid', 'none','me&u']
      );


      
      // id has no default/identity on these two tables -- computed here in code (MAX(id)+1,
      // incremented per row), per instruction. Not safe under concurrent writers to the same
      // table; accepted as a known limitation for now.
      // One row per product; this table has no item_id, so an item counts as already stored
      // when a row with the same name1 and item_price exists for this transaction.
      if ((cart.items || []).length) {
       ;
        let nextSaleId =  1;
        for (const item of cart.items || []) {
          const itemPrice = item.amountInCents != null ? item.amountInCents / 100 : null;
          const hasItem = await client.query(
            `SELECT 1 FROM ${sourceSalesTable}
             WHERE transaction_id = $1 AND site_id = $2 AND name1 IS NOT DISTINCT FROM $3 AND item_price IS NOT DISTINCT FROM $4 LIMIT 1`,
            [transactionId, siteId, item.name || null, itemPrice]
          );
          if (hasItem.rowCount) continue;
          const posItemId = item.metadata && item.metadata.posId 
          const item_id = item?.id;
      
          await client.query(
            `INSERT INTO ${sourceSalesTable}
               (id,transaction_id, site_id, name1, quantity, item_price, pos_updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              item_id,
              transactionId, 
              siteId,
              item.name || null,
              item.quantity || null,
              item.amountInCents != null ? Number(item.amountInCents) / 100 : 0,
              posUpdatedAt
            ]
          );
        }
      }

    //   const hasSourcePayments = await client.query(
    //     `SELECT 1 FROM ${sourcePaymentsTable} WHERE transaction_id = $1 AND site_id = $2 LIMIT 1`,
    //     [transactionId, siteId]
    //   );
    //   if (!hasSourcePayments.rowCount && (cart.discounts || []).length) {
        
    //     for (const discount of cart.discounts || []) {
    //       await client.query(
    //         `INSERT INTO ${sourcePaymentsTable}
    //            (transaction_id, site_id, payment_total, member_id, pos_updated_at)
    //          VALUES ($1,$2,$3,$4,$5)`,
    //         [transactionId, siteId,
    //          discount.amountInCents != null ? discount.amountInCents / 100 : null, memberId, posUpdatedAt]
    //       );
    //     }
    //   }

    await client.query(
          `UPDATE ${transactionsTable}
          SET is_transferred_to_source = TRUE
          WHERE trx_id = $1
            AND venue_id = $2`,
          [transactionId, venue.id]
        );
      console.log(`trx ${transactionId} sent to source`)

      console.log('[meu] source-table rows written', JSON.stringify({ transactionId, siteId }));
    } else {
      console.log('[meu] source-table insert skipped -- site_id not resolvable yet', JSON.stringify({ transactionId }));
    }

    await client.query('COMMIT');
    console.log('[meu] webhook cart event stored', JSON.stringify({ transactionId, cartId: cart.id, items: (cart.items || []).length, discounts: (cart.discounts || []).length }));
  } catch (err) {
    console.error('Error storing meu cart event:', err);
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
function getFinalTrxAmount(event) {
  const { cart } = event;

  const itemsTotal = (cart.items ?? []).reduce(
    (sum, item) => sum + item.amountInCents * item.quantity,
    0
  );
  console.log("itemsTotal",itemsTotal)
  const externalDiscountTotal = (cart.discounts ?? [])
    .filter((d) => d.isInternal === false)
    .reduce((sum, d) => sum + d.amountInCents, 0);

    console.table({itemsTotal,externalDiscountTotal})
  // never go below zero
  const finalTrxAmountInCents = Math.max(0, itemsTotal - externalDiscountTotal);

  return finalTrxAmountInCents; // divide by 100 for dollars
}

async function meuBackfillLinkFromClaim(programId, membership) {
  if (!programId || !membership || !membership.id || !membership.externalId) return;
  const client = await pool.connect();
  try {
    // UPDATE only -- a customer with no meu_member_linking row is not ours, so nothing is inserted.
    const updated = await client.query(
      `UPDATE meu_member_linking SET membership_id = $1
       WHERE external_id = $2 AND program_id = $3`,
      [membership.id, membership.externalId, programId]
    );
    if (!updated.rowCount) {
      console.log('[meu] cart-claimed link backfill skipped -- customer not in meu_member_linking', JSON.stringify({ programId, membershipId: membership.id }));
    }
  } catch (err) {
    console.error('me&u link backfill from cart-claimed failed:', err.message);
    await storeMeuLog({ programId: programId || 'unknown', membershipId: membership && membership.id, eventType: 'MEU_WEBHOOK_LINK_BACKFILL', errorMessage: err.message });
  } finally {
    client.release();
  }
}

// POST /meu/webhooks
// IN : { type: 'cart-submitted' | 'cart-claimed' | 'marketing-consent-given', payload: {...} }
app.post('/meu/webhooks', async (req, res) => {
  if (!meuAuthOk(req)) return res.status(401).json({ status: 'error', message: 'Unauthorized' });

  const { type, payload } = req.body || {};
  console.log('/meu/webhooks',req.body)
  try {
    if (type === 'cart-submitted' || type === 'cart-claimed') {
      const result = await meuStoreCartEvent(payload, type);
      if (type === 'cart-claimed') await meuBackfillLinkFromClaim(payload && payload.programId, payload && payload.membership);
      if (result && result.skipped) {
        return res.status(200).json({ status: 'ok', skipped: true, message: 'Customer is not a linked member -- transaction skipped' });
      }
      if (result && result.alreadyExists) {
        return res.status(200).json({ status: 'ok', message: 'already inserted' });
      }
      return res.status(200).json({ status: 'ok' });
    }
    if (type === 'marketing-consent-given') {
      // No column on aura_customer to store consent yet -- logged only until that's decided.
      console.log('[meu] webhook marketing-consent-given', JSON.stringify(payload));
      return res.status(200).json({ status: 'ok' });
    }
    console.log('[meu] webhook: unknown event type', type); // ack unknown/future types rather than erroring
    return res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('Error in /meu/webhooks:', err.message);
    await storeMeuLog({ programId: (payload && payload.programId) || 'unknown', membershipId: payload && payload.membership && payload.membership.id, eventType: `MEU_WEBHOOK_${(type || 'UNKNOWN').toUpperCase().replace(/-/g, '_')}`, errorMessage: err.message });
    return res.status(err.status || 500).json({ status: 'error', message: err.status ? err.message : 'Internal Server Error' });
  }
});



app.use((req, res, next) => {
  res.status(404).json({
    "message": "API not found",
    "statusCode": 404
  });
});
// General Error Handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    "message": 'Something went wrong!',
    "statusCode": 500
  });
});






// Serverless handler
const handler = serverless(app);

// Start server locally if not in AWS Lambda environment
if (process.env.NODE_ENV !== 'production') {
  app.listen(3000, () => {
    console.log("Server listening on port 3000!");
  });
}

exports.handler = async (event, context) => {
  app.request.context = context;
  context.callbackWaitsForEmptyEventLoop = false;

  // Strip the stage prefix for HTTP API (v2.0) — REST API doesn't need this
  if (event.requestContext?.http && event.rawPath) {
    const stage = event.requestContext.stage;
    if (stage && stage !== '$default' && event.rawPath.startsWith(`/${stage}`)) {
      event.rawPath = event.rawPath.slice(`/${stage}`.length) || '/';
      // also fix requestContext.http.path, which some serverless-http versions use instead
      event.requestContext.http.path = event.rawPath;
    }
  }

  return handler(event, context);
};
