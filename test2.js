

// POST /meu/register-member -- me&u -> Aura registration for a guest who has no Aura account yet.
// One transaction creates (or reuses) aura_customer and its meu_member_linking row together.
app.post('/meu/register-member', async (req, res) => {
  if (!meuAuthOk(req)) return res.status(401).json({ status: 'error', message: 'Unauthorized' });

  const requestId = req.get('x-request-id') || null;
  const { membership, venueId, programId: bodyProgramId } = req.body || {};
  const headerProgramId = req.get('x-program-id');
  const programId = bodyProgramId || headerProgramId;
  // memberId is optional in me&u's registration contract. If it is absent,
  // Aura creates the provider-side membership id and returns it below.
  const incomingMeuMembershipId = membership && (membership.id || membership.memberId);
  // Read every documented member field. Consent values are accepted but aura_customer currently
  // has no consent columns, so they are not persisted until that schema is added.

  const {
    mobile, firstName, lastName, email, birthday, postcode,
    allowEmailMarketing, allowSMSMarketing, marketingConsentGiven
  } = membership || {};

  if (bodyProgramId && headerProgramId && bodyProgramId !== headerProgramId) {
    return res.status(400).json({ status: 'error', message: 'X-Program-Id does not match programId' });
  }
  if (!mobile || !venueId || !programId) {
    return res.status(400).json({ status: 'error', message: 'membership.mobile, venueId and programId are required' });
  }

  let client;
  let step = 'config';
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const configured = await client.query(
      `SELECT partner_id, registration_referrer_id
       FROM meu_partner_program_config
       WHERE venue_id = $1 AND program_id = $2 AND active = true
       ORDER BY id DESC LIMIT 1`,
      [venueId, programId]
    );
    if (!configured.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'error', message: 'Venue/program not configured for me&u' });
    }
    const { partner_id: partnerId, registration_referrer_id: referrerId } = configured.rows[0];

    /*
     * FUTURE EXTERNAL AURA-MEMBER API REPLACEMENT — START
     *
     * When getExternalMember(...) and createMemberAPI(...) are available and tested,
     * replace ONLY this marked block (up to the END marker below). Do NOT run the
     * external create call together with this direct aura_customer INSERT/UPDATE,
     * otherwise a customer can be created twice.
    *
     * The replacement must finish by setting both variables used by the unchanged
     * link block below:
     *   memberId   = Aura customer UUID returned by the external API
     *   externalId = Aura referral/card ID returned by the external API
     *
     * Keep the config lookup above, the meu_member_linking upsert below, the
     * transaction handling, logs, and response unchanged.
     */

    // Retry-safe: a repeated me&u registration request reuses its original Aura customer.
    step = 'customer';
    // const ext = await getExternalMember({ email: membership.email, phone: membership.mobile, referrerId:registration_referrer_id });
    let customer = { rowCount: 0, rows: [] };
    if (incomingMeuMembershipId) {
      customer = await client.query(
        `SELECT member_id, referral_id FROM aura_customer WHERE meu_membership_id = $1 LIMIT 1`,
        [incomingMeuMembershipId]
      );
    }

    if (!customer.rowCount) {
      // A pre-existing Aura customer with the same phone/email is linked instead of duplicated.
      customer = await client.query(
        `SELECT member_id, referral_id FROM aura_customer
         WHERE phone = $1 OR ($2::text IS NOT NULL AND email = $2)
         LIMIT 2`,
        [mobile, email || null]
      );
      if (customer.rowCount > 1) {
        throw Object.assign(new Error('Mobile/email match different Aura customers'), { status: 409 });
      }
    }

    let memberId;
    let externalId;
    if (customer.rowCount) {
      ({ member_id: memberId, referral_id: externalId } = customer.rows[0]);
      await client.query(
        `UPDATE aura_customer
         SET given_name = COALESCE($1, given_name), family_name = COALESCE($2, family_name),
             phone = $3, email = COALESCE($4, email), post_code = COALESCE($5, post_code),
             date_of_birth = COALESCE($6::date, date_of_birth),
             meu_membership_id = COALESCE($7, meu_membership_id), is_meu_synced = true
         WHERE member_id = $8`,
        [firstName || null, lastName || null, mobile,
         email || null, postcode || null, birthday || null,
         incomingMeuMembershipId || null, memberId]
      );
    } else {
      // Aura referral_id is the external/card identifier. A numeric value works with existing barcode flows.
      externalId = String(crypto.randomInt(100000000000, 1000000000000));
      const inserted = await client.query(
        `INSERT INTO aura_customer
           (referral_id, referrer_id, given_name, family_name, phone, email, post_code,
            date_of_birth, meu_membership_id, is_meu_synced)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,true)
         RETURNING member_id, referral_id`,
        [externalId, referrerId || null, firstName || null, lastName || null,
         mobile, email || null, postcode || null, birthday || null, incomingMeuMembershipId || null]
      );
      ({ member_id: memberId, referral_id: externalId } = inserted.rows[0]);
    }

    // FUTURE EXTERNAL AURA-MEMBER API REPLACEMENT — END

    step = 'link';
    // This is the provider membership id that me&u receives in the response.
    // For a fresh registration it is Aura's new UUID; an optional me&u id is retained when supplied.
    const providerMembershipId = incomingMeuMembershipId || String(memberId);
    await client.query(
      `INSERT INTO meu_member_linking
         (member_id, external_id, membership_id, partner_id, program_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
       ON CONFLICT (partner_id, member_id) DO UPDATE SET
         external_id = EXCLUDED.external_id, membership_id = EXCLUDED.membership_id,
         program_id = EXCLUDED.program_id, updated_at = NOW()`,
      [memberId, externalId, providerMembershipId, partnerId, programId]
    );

    await client.query('COMMIT');
    console.log('[meu] register-member stored', JSON.stringify({
      requestId, programId, partnerId, memberId, membershipId: providerMembershipId,
      allowEmailMarketing: !!allowEmailMarketing,
      allowSMSMarketing: !!allowSMSMarketing,
      marketingConsentGiven: !!marketingConsentGiven
    }));
    // me&u's registration contract returns only the provider-side membership id.
    // externalId/referral_id is stored internally in aura_customer and meu_member_linking.
    return res.status(200).json({ status: 'ok', membership: { id: providerMembershipId } });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    const status = err.status || 500;
    console.error(`Error in /meu/register-member (${step}):`, detail);
    await storeMeuLog({
      programId: programId || 'unknown',
      membershipId: incomingMeuMembershipId,
      eventType: 'MEU_REGISTER_MEMBER',
      errorMessage: `${step}: ${detail} | requestId=${requestId}`,
    });
    return res.status(status).json({ status: 'error', message: status === 500 ? 'Internal Server Error' : detail });
  } finally {
    if (client) client.release();
  }
});
