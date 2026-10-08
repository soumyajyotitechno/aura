// Prints a fresh random API key -- run whenever you want a new value for API_KEY in .env.
// This file only generates and prints; it never touches .env or the running server itself.
// After running it: paste the printed value into API_KEY= in .env, then restart `node index.js`.
const crypto = require('crypto');

function generateApiKey() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(32);
  let key = '';
  for (let i = 0; i < bytes.length; i++) key += chars[bytes[i] % chars.length];
  return key;
}

console.log(generateApiKey());
