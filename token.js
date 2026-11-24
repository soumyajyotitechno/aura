const jwt = require('jsonwebtoken');
const  fs  = require('fs');
// Lambda has no local file for the key, so keep it in an env var (or Secrets Manager).
// If it is an env var, store it with \n for line breaks and restore them here.
const AURA_JWT_PRIVATE_KEY = fs.readFileSync('./Auth/private.key')

const AURA_JWT_ISSUER   ='AURA-CORE'    // TODO: value API 1 expects
const AURA_JWT_AUDIENCE = 'EXTERNAL-API';  // TODO: value API 1 expects
const AURA_JWT_KID      = '';       // optional key id

exports.generateAuraJwt=()=> {
  return jwt.sign(
    { /* TODO: any custom claims API 1 requires, e.g. partner or scope */ },
    AURA_JWT_PRIVATE_KEY,
    {
      algorithm: 'RS256',
     // expiresIn: '5m',
      expiresIn: '10d',
      issuer: AURA_JWT_ISSUER,
      audience: AURA_JWT_AUDIENCE
    
    }
  );
}



exports.verifyAuraJwt = (token) => {
  try {
    const publicKey = fs.readFileSync('./Auth/public.key');

    const decoded = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: AURA_JWT_ISSUER,
      audience: AURA_JWT_AUDIENCE
    });

    return {
      valid: true,
      decoded
    };
  } catch (error) {
    return {
      valid: false,
      error: error.message
    };
  }
};