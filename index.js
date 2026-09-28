require('dotenv').config(); // no-op in Lambda (no .env there); loads local env for `node index.js`
const { Pool } = require('pg');
const express = require('express');
const serverless = require('serverless-http');
const axios = require('axios')
const crypto = require('crypto');
// const verifyImposSignature = require('./verifyImposSignature'); // TODO: restore once you have the real file -- the local stub was removed
const app = express();
GROUP_ID = 5


// API hit log: one line per request (method, path, status, ms) for EVERY route. me&u routes also print the request and
// response bodies, with mobile/email masked; headers and query strings are never logged. MEU_LOG_BODIES=false turns bodies off.
const LOG_BODIES = process.env.MEU_LOG_BODIES !== 'false';
const maskPii = (k, v) => (/^(mobile|phone|email)$/i.test(k) && typeof v === 'string' ? v.replace(/.(?=.{3})/g, '*') : v);
app.use((req, res, next) => {
  const start = Date.now();
  const json = res.json.bind(res);
  res.json = (body) => { // logged here, before the reply goes out, so Lambda can't freeze before the line is written
    console.log(`[API] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`);
    if (LOG_BODIES && /^\/(meu\/|auto-linking)/.test(req.path)) {
      console.log('[API]   in :', JSON.stringify(req.body, maskPii));
      console.log('[API]   out:', JSON.stringify(body, maskPii));
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



// TODO: restore real IMPOS signature verification here once verifyImposSignature.js is available --
// every /loyalty/* request is currently unauthenticated.
// app.use((req, res, next) => {
//   if (req.path === '/test' || req.path === '/meu/auto-link') return next(); // skip signature check
//   verifyImposSignature(req, res, next);
// });

// Set up the PostgreSQL connection pool
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
     res.json({msg :"working...impos_redemption_adapter"});
   // res.json(req.headers);
  } catch (err) {
    res.status(500).json({ message: 'Internal Server Error', error: err.message });
  }
});

app.get('/loyalty/enquiry', async (req, res) => {
  const {
    cardId:cardNumber,
    siteId,
    stationId,
    email,
    phone,
    membershipNo
  } = req.query;

  console.log("Enquiry request:", req.query);
  if (isNaN(Number(siteId))) {
    return res.status(200).json({
      success: false,
      errorCode: "INVALID_REQUEST",
      message: "siteId must be numeric (e.g 5)"
    });
  }

  // At least one identifier is required
  if (!cardNumber && !email && !phone && !membershipNo) {
    return res.status(200).json({
      success: false,
      errorCode: "INVALID_REQUEST",
      message: "Provide cardId, email, phone or membershipNo"
    });
  }

  if (!siteId) {
    return res.status(200).json({
      success: false,
      errorCode: "INVALID_REQUEST",
      message: "siteId is required"
    });
  }




  let client;
  let partnerId = null;
  let lookupCardNumber = cardNumber;

  try {
    client = await pool.connect();
    console.log("req.clientId ",req?.clientId)
    // Lookup partner
    partnerId = await getPartnerId(client,req?.clientId,siteId)
    console.log("Partner id ",partnerId)
    if (!partnerId) {
      return res.status(200).json({
        success: false,
        errorCode: "SITE_NOT_FOUND",
        message: "Invalid site"
      });
    }



    // Optional lookup if cardNumber wasn't supplied
    if (!lookupCardNumber) {
      const member = await client.query(
        `SELECT referral_id
         FROM aura_customer
         WHERE (
             phone = $1
            OR email = $2

         )
         LIMIT 1`,
        [

          phone || null,
          email || null

        ]
      );

      if (member.rowCount === 0) {
        return res.status(200).json({
          success: false,
          errorCode: "CARD_NOT_FOUND",
          message: "Member not found"
        });
      }

      lookupCardNumber = member.rows[0].referral_id;
    }

    const endpoint =
      `enquiry?partnerId=${partnerId}&barcodeText=${encodeURIComponent(lookupCardNumber)}`;

      console.log("callRedemptionService endpoint===> ",endpoint)

    const data = await callRedemptionService(endpoint);
    console.log("response from callRedemptionService")
    // Forward business errors from redemption service
    if (!data.success) {
      return res.status(200).json({
        success: false,
        errorCode: data.errorCode,
        message: data.errorMessage
      });
    }
    const resObj ={
      success: true,
      "partnerMemberId": cardNumber, //data?.profile?.member_id,
      "profile": {
        "firstName": data?.profile?.given_name,
        "lastName": data?.profile?.family_name,
        "email": data?.profile?.email,
        "mobile": data?.profile?.phone ?? "",
      },

      balance: Number(data.balance || 0) * 100,
      currency: "AUD",
      status: data.valid ? "active" : "inactive"
    }
    console.log("RESPONSE :", resObj);
    return res.status(200).json(resObj);

  } catch (err) {
    console.error("Error in /enquiry:", err);

    try {
      await storeErrorLog({
        recordId: null,
        memberId: null,
        eventType: "ENQUIRY",
        errorType: "SERVER_ERROR",
        errorMessage: err.message,
        withdrawalPartner: partnerId
      });
    } catch (e) {
      console.error("Failed to log error:", e);
    }

    if(err.response)
    {

    }
    return res.status(500).json({
      success: false,
      errorCode: "SYSTEM_ERROR",
      message: "Internal Server Error"
    });

  } finally {
    if (client) client.release();
  }
});

app.get('/loyalty/member', async (req, res) => {
  const {
    membershipNo: cardNumber,
    siteId,
    stationId,
    name,
    email,
    phone
  } = req.query;

  console.log("Enquiry request:", req.query);

  // Validate siteId
  if (!siteId) {
    return res.status(200).json({
      success: false,
      errorCode: "INVALID_REQUEST",
      message: "siteId is required"
    });
  }

  if (isNaN(Number(siteId))) {
    return res.status(200).json({
      success: false,
      errorCode: "INVALID_REQUEST",
      message: "siteId must be numeric (e.g. 23)"
    });
  }

  // At least one identifier is required
  if (!cardNumber && !email && !phone && !name) {
    return res.status(200).json({
      success: false,
      errorCode: "INVALID_REQUEST",
      message: "Provide at least one of membershipNo, name, email, or phone"
    });
  }


  let client;
  let partnerId = null;

  // Use cardNumber directly if supplied
  let lookupCardNumber = cardNumber
    ? String(cardNumber).trim()
    : null;

  try {
    client = await pool.connect();

    console.log("req.clientId:", req?.clientId);

    // Lookup partner
    partnerId = await getPartnerId(
      client,
      req?.clientId,
      siteId
    );

    console.log("Partner id:", partnerId);

    if (!partnerId) {
      return res.status(200).json({
        success: false,
        errorCode: "SITE_NOT_FOUND",
        message: "Invalid site"
      });
    }

    // Lookup member if membershipNo was not supplied
    if (!lookupCardNumber) {
      const conditions = [];
      const values = [];

      if (phone) {
        values.push(phone);
        conditions.push(`phone = $${values.length}`);
      }

      if (email) {
        values.push(email.toLowerCase());
        conditions.push(`lower(email) = $${values.length}`);
      }

      if (name) {
        values.push(`${name.toLowerCase()}`);
        conditions.push(`lower(given_name) = $${values.length}` );
      }

      const query = `
        SELECT referral_id
        FROM aura_customer
        WHERE ${conditions.join(" OR ")}
        LIMIT 1
      `;

      console.log("Member lookup query:", query);

      const member = await client.query(query, values);

      if (member.rowCount === 0) {
        return res.status(200).json({
          success: false,
          errorCode: "CARD_NOT_FOUND",
          message: "Member not found"
        });
      }

      lookupCardNumber = member.rows[0].referral_id;
    }

    if (!lookupCardNumber) {
      return res.status(200).json({
        success: false,
        errorCode: "CARD_NOT_FOUND",
        message: "Member does not have a valid membership number"
      });
    }

    const endpoint =
      `enquiry?partnerId=${partnerId}` +
      `&barcodeText=${encodeURIComponent(lookupCardNumber)}`;

    console.log(
      "callRedemptionService endpoint:",
      endpoint
    );

    const data = await callRedemptionService(endpoint);

    console.log(
      "Response from callRedemptionService:",
      data
    );

    // Forward business errors from redemption service
    if (!data?.success) {
      const errorPayload = {
        success: false,
        errorCode: data?.errorCode || "CARD_NOT_FOUND",
        message: data?.errorMessage || "Member not found"
      };

      console.log("BUSINESS ERROR RESPONSE:", errorPayload);

      return res.status(200).json(errorPayload);
    }

    const responsePayload = {
      success: true,
      members:[
        {
          partnerMemberId: lookupCardNumber, // data?.profile?.member_id,
          profile: {
            firstName: data?.profile?.given_name,
            lastName: data?.profile?.family_name,
            email: data?.profile?.email,
            mobile: data?.profile?.phone ?? "",
          },
          tier:{
            code:"",
            name:""
          },
          balance: Number(data.balance || 0) * 100,
          currency: "AUD",
          status: data.valid ? "active" : "inactive"
        }
      ]
    };

    console.log("RESPONSE :", responsePayload);

    return res.status(200).json(responsePayload);


  } catch (err) {
    console.error(
      "Error in /loyalty/member:",
      err?.response?.data || err.message
    );

    try {
      await storeErrorLog({
        recordId: null,
        memberId: null,
        eventType: "ENQUIRY",
        errorType: "SERVER_ERROR",
        errorMessage:
          err?.response?.data?.message ||
          err.message ||
          "Unknown server error",
        withdrawalPartner: partnerId
      });
    } catch (logError) {
      console.error(
        "Failed to log error:",
        logError.message
      );
    }

    return res.status(500).json({
      success: false,
      errorCode: "SYSTEM_ERROR",
      message: "Internal Server Error"
    });

  } finally {
    if (client) {
      client.release();
    }
  }
});

// POST /redemptions
app.post('/loyalty/redeem', async (req, res) => {
  const {
    cardId: barcodeText,
    requestedAmount: amount,
    orderId,
    authCode,
    siteId,
    stationId: posId,
    transactionRef
  } = req.body;

  console.table(req.body)
  let client;
  try {
    client = await pool.connect();

    // if(barcodeText.trim()!=='987456321000')
    //   {
    //     return res.status(200).json({
    //       success: false,
    //       errorCode: `TEST_CARD_REQUIRED`,
    //       message:  `Card does not match (received cardId: ${barcodeText.trim()})`
    //     });
    // }

    if (isNaN(Number(siteId))) {
      return res.status(200).json({
        success: false,
        errorCode: "INVALID_REQUEST",
        message: "siteId must be numeric (e.g 5)"
      });
    }


    const  partnerId = await getPartnerId(client,req?.clientId,siteId)
    if (!partnerId) {
      return res.status(200).json({
        success: false,
        errorCode: "SITE_NOT_FOUND",
        message: "Invalid site"
      });
    }

    const payload = {
      partnerId,
      barcodeText,
      orderId,
      transactionRef,
      amount,
      authCode,
      withdrawalType: "instore",
      withdrawalInstrument: "Halo_Loyalty_Card",
      tipAmount: 0,
      withdrawalGateWay: "IMPOS"
    };


    const data = await callRedemptionService('redeem','POST',payload);

    if (!data.success) {
      return res.status(200).json({
        success: false,
        errorCode: data.errorCode || "REDEMPTION_FAILED",
        message: data.errorMessage || "Redemption failed"
      });
    }
    let obj = {
      success: true,
      successMessage:`${amount} has been redeemed from balance.`,
      grantedAmount: Number(data.amountRedeemed) * 100,
      newBalance: Number(data.remainingBalance) * 100,
      partnerReference: data.partnerReference

    }
    console.log("===RESPONSE==")
    console.table(obj)
    return res.status(200).json(obj);

  } catch (err) {
    console.error("Error in /loyalty/redeem:", err);
    return res.status(500).json(SERVER_ERROR);
  } finally {
    if (client) client.release();
  }
});

// POST /refund
app.post('/loyalty/reversal', async (req, res) => {
  let  {
    cardId:barcodeText,
    transactionRef,
    originalTransactionRef, // unqie identifier to search a record_id
    partnerReference,
    orderId
  } = req.body;
  let client;
  console.table(req.body)
  try {
    // if(barcodeText.trim()!=='987456321000')
    //   {
    //     return res.status(200).json({
    //       success: false,
    //       errorCode: `TEST_CARD_REQUIRED`,
    //       message:  `Card does not match (received cardId: ${barcodeText.trim()})`
    //     });
    // }

            // Phase 1: find member_id
          client = await pool.connect();
          const redemption = await getOriginalRedemption(client, partnerReference, originalTransactionRef)
          if (!redemption)
            {
                return res.status(200).json({
                    success:false,
                    errorCode:"ORIGINAL_TRANSACTION_NOT_FOUND", //"ORIGINAL_TRANSACTION_NOT_FOUND",
                    message:"Original redemption not found"
                });
            }
          const payload={
            posId:redemption.pos_id,
            withdrawalInstrument:'Halo_Loyalty_Card',
            metadata:{},
            withdrawalGateWay:'IMPOS',
            partnerId: redemption.partner_id,
            memberId:redemption.member_id,
            venue:redemption.venue,
            transactionRef,
            originalTransactionRef,
            amount:redemption.refund_amount
          }

          const endpoint = `refund`;
          const data = await callRedemptionService(endpoint,'POST',payload)

          if (!data.success) {
            return res.status(200).json({
              success: false,
              errorCode: data.errorCode || "REVERSAL_FAILED",
              message: data.errorMessage || "Reversal failed"
            });
          }

          let obj = {
            success: true,
            newBalance: Number(data.remainingBalance) * 100,
            // partnerReference: data.partnerReference,
            // errorCode: data.errorCode,
            // message: data.errorMessage

          }
          console.log("===RESPONSE==")
          console.table(obj)

          return res.status(200).json(obj);



  } catch (err) {
        try {
            if (client) {
                await client.query("ROLLBACK");
            }

        } catch (rollbackErr)
        {
          console.error("Rollback failed:", rollbackErr);
        }
     console.error(
            `Refund rollback for original transaction ${originalTransactionRef}`,
            err
        );
    return res.status(500).json(SERVER_ERROR);
  }
  finally{
    if (client) {
          client.release();
      }
  }
});

const getPartnerIdV2 = async (client, groupId, siteId) => {
  const { rows } = await client.query(
    `SELECT partner_id
     FROM impos_sites
     WHERE management_group_id = $1
       AND site_id = $2
     LIMIT 1`,
    [groupId, siteId]
  );

  return rows.length ? rows[0].partner_id : null;
};
const getPartnerId = async (client, clientId, siteId) => {
  const { rows } = await client.query(
    `SELECT partner_id
     FROM impos_sites
     WHERE site_id = $1  AND client_id=$2
     LIMIT 1`,
    [siteId,clientId]
  );

  return rows.length ? rows[0].partner_id : null;
};



const getOriginalRedemption = async (client, partnerReference,originalTransactionRef) => {
  const { rows } = await client.query(
    ` SELECT withdrawal_amount as refund_amount, withdrawal_partner as partner_id,member_id,
     aura_id, pos_id, venue,

    withdrawal_type FROM withdrawal_events
     WHERE (aura_id = $1
       and merchant_ref_trxid = $2)
       and event_type='redemption'
     LIMIT 1`,
    [partnerReference, originalTransactionRef]
  );

  return rows.length ? rows[0] : null;
};
const callRedemptionService = async (endpoint, method = 'GET', data = null, headers = {}) => {
  const apiUrl = `https://jqzlxs0nr9.execute-api.ap-southeast-2.amazonaws.com/v1/${endpoint}`;

  try {
    let response;
    if (method === 'GET') {
      response = await axios.get(apiUrl, { headers });
    } else if (method === 'POST') {
      response = await axios.post(apiUrl, data, { headers });
    } else {
      throw new Error(`Unsupported method: ${method}`);
    }

    return {
      statusCode: response.status,
      ...response.data
    };
  } catch (err) {
    if (err.response) {
      // Downstream returned a business error (e.g. 404 with JSON body)
      console.log("Error from service ",err.response)
      return {
        statusCode: err.response.status,
        ...err.response.data
      };
    }
    throw err; // true transport error (timeout, DNS, etc.)
  }
};



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



// ============================================================
// me&u -- Membership auto-linking (Aura -> me&u) and
// Membership linking on provider (me&u -> Aura)
// ============================================================
const MEU_BASE_URL = process.env.MEU_BASE_URL; // e.g. https://ap1-loyalty-connector.meandu.app
const MEU_PROVIDER_ID = process.env.MEU_PROVIDER_ID; // issued by me&u
const MEU_SIGNING_SECRET = process.env.MEU_SIGNING_SECRET; // issued by me&u, signs outbound requests

function signMeuPayload(payload) {
  console.log('Signing payload for me&u:', payload);

  let signature= crypto.createHmac('sha256', MEU_SIGNING_SECRET).update(payload).digest('hex');

  console.log('Signed payload for me&u:', signature);
  return signature;
}


// Records a confirmation row in meu_link_status_log so it's queryable whether a given
// me&u event ended up SAVED, NOT_SAVED (nothing matched, no error) or ERROR.
async function logMeuLinkStatus({ eventType, status, programId, externalId, membershipId, memberId, message }) {
  try {
    await queryDatabase(
      `INSERT INTO meu_link_status_log (event_type, status, program_id, external_id, membership_id, member_id, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [eventType, status, programId || null, externalId || null, membershipId || null, memberId || null, message || null]
    );
  } catch (err) {
    console.error('Failed to write meu_link_status_log:', err.message);
  }
}

// Saves me&u's membership id against the Aura member in meu_member_linking, using the memberId
// passed straight from the payload -- no lookup against aura_customer or any other table.
// Never fails the request: me&u has already created the membership, so a DB problem only raises an alert.
async function meuSaveLink(programId, externalId, membershipId, memberId) {
  if (!externalId || !membershipId || !memberId) {
    return console.log("me&u link not saved: payload.memberId, payload.externalId or the returned membership id is missing");
  }
  try {
    const rows = await queryDatabase(
      `INSERT INTO meu_member_linking (member_id, external_id, program_id, membership_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (program_id, member_id) DO UPDATE SET membership_id = EXCLUDED.membership_id
       RETURNING member_id`,
      [memberId, externalId, programId, membershipId]
    );
    console.log("[meu] link saved", JSON.stringify({ programId, externalId, membershipId, memberId: rows[0].member_id }));
    await logMeuLinkStatus({ eventType: "MEU_AUTO_LINKING", status: "SAVED", programId, externalId, membershipId, memberId: rows[0].member_id });
  } catch (err) {
    console.error("me&u link not saved:", err.message);
    await storeErrorLog({
      requestPayload: JSON.stringify({ programId, externalId, membershipId, memberId }),
      memberId,
      eventType: "MEU_AUTO_LINKING",
      errorType: err.name,
      errorMessage: err.message,
    });
    await logMeuLinkStatus({ eventType: "MEU_AUTO_LINKING", status: "ERROR", programId, externalId, membershipId, memberId, message: err.message });
  }
}


// POST /auto-linking
// Aura core -> here -> me&u. The program must be configured (meu_partner_program_config); on success the
// returned me&u membership id is saved to meu_member_linking.
app.post("/auto-linking", async (req, res) => {
  const { programId, payload } = req.body || {};

  if (!programId || !payload) {
    return res.status(400).json({ error: "programId and payload are required" });
  }

  try {
    const configured = await queryDatabase(
      `SELECT 1 FROM meu_partner_program_config WHERE program_id = $1 AND active = true LIMIT 1`,
      [programId]
    );
    if (!configured.length) return res.status(404).json({ error: "Program not configured for me&u" });

    let status, data;
    if (process.env.MEU_DUMMY_MODE === "true") {
      // skip the outbound call and return a fake membership (unique id: the link table keeps one row per me&u membership)
      console.log("MEU_DUMMY_MODE: skipping me&u call for programId", programId);
      status = 202;
      data = { status: 202, body: { id: `dummy-membership-id-${Date.now()}` } };
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

    await meuSaveLink(programId, payload.externalId, data && (data.id || (data.body && data.body.id)), payload.memberId);
    return res.status(status).json(data);
  } catch (error) {
    console.error("Error in /auto-linking:", error.response ? error.response.data : error.message);
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
          `SELECT external_id FROM meu_member_linking WHERE program_id = $1 AND external_id = $2`,
          [programId, externalMembershipId]
        );
        if (linked.rowCount > 0) {
          message = 'Membership already linked';
          return res.status(200).json({ membershipId: linked.rows[0].external_id });
        }
      }
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
    await logMeuLinkStatus({ eventType: 'MEU_MEMBERSHIP_LINKING', status: 'ERROR', programId, externalId: externalMembershipId, message: err.message });
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
const MEU_API_KEY = process.env.MEU_API_KEY;               // issued to me&u (X-Api-Key)
const MEU_INBOUND_SECRET = process.env.MEU_INBOUND_SECRET; // me&u's key for x-signature-sha256

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Fails closed: if the secrets aren't configured, only local dummy mode gets through.
function meuAuthOk(req) {
  if (!MEU_API_KEY || !MEU_INBOUND_SECRET) return process.env.MEU_DUMMY_MODE === 'true';
  const expectedSig = crypto.createHmac('sha256', MEU_INBOUND_SECRET).update(req.rawBody || '').digest('hex');
  return safeEqual(req.get('x-api-key'), MEU_API_KEY) && safeEqual(req.get('x-signature-sha256'), expectedSig);
}

// venue + program -> Aura partner + its redemption limits. Config rarely changes, so keep hits in
// Lambda memory for 5 min (a deactivated venue can linger that long). Misses aren't cached.
const meuPartnerCache = new Map();
async function getMeuPartner(venueId, programId) {
  const key = `${venueId}|${programId}`;
  const hit = meuPartnerCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.partner;

  const rows = await queryDatabase(
    `SELECT c.partner_id, r.redemption_min_withdrawal AS min_dollars, r.redemption_max_withdrawal AS max_dollars
     FROM meu_partner_program_config c
     LEFT JOIN partner_redemption_rule r ON r.partner_id = c.partner_id AND r.is_active = true
     WHERE c.venue_id = $1 AND c.program_id = $2 AND c.active = true
     LIMIT 1`,
    [venueId, programId]
  );
  if (!rows.length) return null;
  const partner = {
    partnerId: rows[0].partner_id,
    minCents: Math.round(Number(rows[0].min_dollars || 0) * 100),
    maxCents: Math.round(Number(rows[0].max_dollars || 0) * 100), // 0 = no maximum
  };
  meuPartnerCache.set(key, { partner, exp: Date.now() + 5 * 60 * 1000 });
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
    data = await callRedemptionService(`enquiry?partnerId=${partnerId}&barcodeText=${encodeURIComponent(externalId)}`);
  }
  if (!data.success) return { error: data.errorMessage || 'Member not found' };
  return { cents: data.valid ? Math.round(Number(data.balance || 0) * 100) : 0 }; // invalid (inactive) member = 0
}

// ---- the one points offer (PointShopOffer); shared by /meu/points-balance and /meu/apply-reward ----
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
// TODO(me&u): is items[].amountInCents a line total or a unit price? Read as a line total (the lower, safer reading).
function meuApplicableCents(cart) {
  if (!cart) return 0;
  const items = (cart.items || []).reduce((s, i) => s + (Number(i.amountInCents) || 0), 0);
  const others = (cart.discounts || []).filter((d) => !meuIsOurs(d)).reduce((s, d) => s + (Number(d.amountInCents) || 0), 0);
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
async function meuRedeem(partnerId, externalId, cents) {
  if (process.env.MEU_DUMMY_MODE === 'true') {
    meuDummyDeducted.set(externalId, (meuDummyDeducted.get(externalId) || 0) + cents);
    return { success: true };
  }
  const transactionRef = `meu-${crypto.randomUUID()}`;
  return callRedemptionService('redeem', 'POST', {
    partnerId,
    barcodeText: externalId,
    orderId: transactionRef,
    transactionRef,
    amount: cents,
    withdrawalType: MEU_WITHDRAWAL_TYPE,
    withdrawalInstrument: 'Halo_Loyalty_Card',
    tipAmount: 0,
    withdrawalGateWay: MEU_WITHDRAWAL_GATEWAY,
  });
}

// The guest tapped Apply: deduct whatever the cart doesn't already carry. One apply at a time per member+partner
// (advisory lock), so a parallel tap reads the balance after this deduction. Nothing is written to our own tables.
async function meuApply({ partner, externalId, cart }) {
  const applied = meuAppliedCents(cart);
  const client = await pool.connect();
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

// POST /meu/points-balance
// Read-only. pointsBalance is what is left after any deduction; a cart that already carries our discount shows as SELECTED.
// IN : { membership: { id, externalId (= referral_id), ... }, cart?, venueId, programId }
// OUT: { status: 'ok', membership: { id, pointsBalance, rewards: [] | [PointShopOffer] } }
app.post('/meu/points-balance', async (req, res) => {
  try {
    if (!meuAuthOk(req)) return res.status(401).json({ status: 'error', message: 'Unauthorized' });

    const { membership, cart, venueId, programId } = req.body || {};
    if (!membership || !membership.externalId || !venueId || !programId) {
      return res.status(400).json({ status: 'error', message: 'membership.externalId, venueId and programId are required' });
    }

    const partner = await getMeuPartner(venueId, programId);
    if (!partner) return res.status(404).json({ status: 'error', message: 'Venue/program not configured for me&u' });

    const balance = await getMeuBalanceCents(partner.partnerId, membership.externalId);
    if (balance.error) return res.status(404).json({ status: 'error', message: balance.error });

    const applied = meuAppliedCents(cart);
    const calc = meuCalc(balance.cents, applied, meuApplicableCents(cart), partner);
    // listed only if they have something to spend
    const offer = calc.spendable > 0 ? meuOffer(calc, calc.cause ? 0 : Math.min(applied, calc.cap)) : null;
    return res.status(200).json({
      status: 'ok',
      membership: { id: membership.id, pointsBalance: balance.cents, rewards: offer ? [offer] : [] },
    });
  } catch (err) {
    console.error('Error in /meu/points-balance:', err.message);
    return res.status(500).json({ status: 'error', message: 'Internal Server Error' });
  }
});



// POST /meu/apply-reward  ("Reward application", me&u -> Aura)
// The guest tapped Apply on the cashback offer. We DEDUCT the cashback now (no hold); me&u decides about any refund.
// IN : { membership?: { id, mobile, externalId }, cart: { venueId, items, discounts }, orderingType, rewards: { offer?, promoCode? } }
//      headers: X-Api-Key, x-signature-sha256, x-program-id (the program is not in the body)
// OUT: { status: 'ok', rewards: [PointShopOffer] } -- SELECTED_TO_REDEEM with discountAmountInCents, or UNAVAILABLE_TO_REDEEM with a cause
app.post('/meu/apply-reward', async (req, res) => {
  try {
    if (!meuAuthOk(req)) return res.status(401).json({ status: 'error', message: 'Unauthorized' });

    const { membership, cart, rewards } = req.body || {};
    const programId = req.get('x-program-id');
    if (!cart || !cart.venueId || !programId) {
      return res.status(400).json({ status: 'error', message: 'cart.venueId and the x-program-id header are required' });
    }

    // Guests without a membership, other offers and promo codes are out of scope: nothing to apply.
    if (!membership || !membership.externalId || !rewards || rewards.offer !== MEU_OFFER_ID) {
      return res.status(200).json({ status: 'ok', rewards: [] });
    }

    const partner = await getMeuPartner(cart.venueId, programId);
    if (!partner) return res.status(404).json({ status: 'error', message: 'Venue/program not configured for me&u' });

    const result = await meuApply({ partner, externalId: membership.externalId, cart });
    if (result.error) return res.status(404).json({ status: 'error', message: result.error });

    const { calc } = result;
    return res.status(200).json({ status: 'ok', rewards: [meuOffer(calc, calc.cause ? 0 : calc.cap)] });
  } catch (err) {
    console.error('Error in /meu/apply-reward:', err.message);
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
  if (membership.externalId) {
    r = await client.query(`SELECT member_id, referral_id FROM aura_customer WHERE referral_id = $1`, [membership.externalId]);
    if (r.rowCount) return r.rows[0];
  }
  if (membership.id) {
    r = await client.query(
      `SELECT c.member_id, c.referral_id FROM meu_member_linking l JOIN aura_customer c USING (member_id)
       WHERE l.membership_id = $1 AND l.program_id = $2`,
      [membership.id, programId]
    );
    if (r.rowCount) return r.rows[0];
  }
  if (membership.mobile) {
    r = await client.query(`SELECT member_id, referral_id FROM aura_customer WHERE phone = $1`, [membership.mobile]);
    if (r.rowCount) return r.rows[0];
  }
  return null;
}

// Stores the cart straight into the three tables -- one meu_transactions header row, one meu_sales
// row per item, one meu_payments row per discount -- exactly as given, no merging with any earlier
// event for the same cart.id (see the note where this is called: a retry or a cart-claimed that
// follows cart-submitted for the same cart each add their own rows, not update one).
async function meuStoreCartEvent(payload, eventType) {
  const { programId, programName, membership, venue, cart } = payload || {};
  if (!programId || !venue || !venue.id || !cart || !cart.id) {
    throw Object.assign(new Error('programId, venue.id and cart.id are required'), { status: 400 });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO meu_transactions
         (program_id, program_name, membership_id, membership_external_id, membership_program_id, membership_mobile, venue_id, cart_id, submitted_at, event_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [programId, programName || null, membership ? membership.id : null, membership ? membership.externalId : null,
       membership ? membership.programId : null, membership ? membership.mobile : null, venue.id, cart.id,
       cart.submittedAt ? new Date(cart.submittedAt) : null, eventType]
    );

    for (const item of cart.items || []) {
      await client.query(
        `INSERT INTO meu_sales (cart_id, item_id, item_name, pos_id, amount_in_cents, quantity)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [cart.id, item.id, item.name || null, (item.metadata && item.metadata.posId) || null, item.amountInCents, item.quantity]
      );
    }

    for (const discount of cart.discounts || []) {
      const meta = discount.metadata || {};
      await client.query(
        `INSERT INTO meu_payments (cart_id, discount_type, discount_name, amount_in_cents, is_internal, external_reward_id, reward_type, promo_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [cart.id, discount.type, discount.name, discount.amountInCents, !!discount.isInternal,
         meta.externalRewardId || null, meta.rewardType || null, meta.promoCode || null]
      );
    }

    await client.query('COMMIT');
    console.log('[meu] webhook cart event stored', JSON.stringify({ cartId: cart.id, items: (cart.items || []).length, discounts: (cart.discounts || []).length }));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Best-effort only: cart-claimed always carries a full membership, so this backfills
// meu_member_linking's membership id when we can resolve the Aura member -- the other place
// (besides /auto-linking) that can learn me&u's membership id. Never throws; a failure here must
// not fail the webhook, since the cart itself is already stored by the time this runs.
async function meuBackfillLinkFromClaim(programId, membership) {
  if (!membership || !membership.id) return;
  const client = await pool.connect();
  try {
    const member = await meuResolveMember(client, membership, programId);
    if (member) {
      await client.query(
        `INSERT INTO meu_member_linking (member_id, external_id, program_id, membership_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (program_id, member_id) DO UPDATE SET membership_id = EXCLUDED.membership_id`,
        [member.member_id, member.referral_id, programId, membership.id]
      );
    }
  } catch (err) {
    console.error('me&u link backfill from cart-claimed failed:', err.message);
  } finally {
    client.release();
  }
}

// POST /meu/webhooks
// IN : { type: 'cart-submitted' | 'cart-claimed' | 'marketing-consent-given', payload: {...} }
app.post('/meu/webhooks', async (req, res) => {
  if (!meuAuthOk(req)) return res.status(401).json({ status: 'error', message: 'Unauthorized' });

  const { type, payload } = req.body || {};
  try {
    if (type === 'cart-submitted' || type === 'cart-claimed') {
      await meuStoreCartEvent(payload, type);
      if (type === 'cart-claimed') await meuBackfillLinkFromClaim(payload && payload.programId, payload && payload.membership);
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
    await logMeuLinkStatus({ eventType: 'MEU_WEBHOOK', status: 'ERROR', programId: payload && payload.programId, message: `${type}: ${err.message}` });
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
