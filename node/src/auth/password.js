const argon2 = require('argon2');

// argon2id with the library's defaults (OWASP-recommended memory and time cost).
function hashPassword(password) {
  return argon2.hash(password, { type: argon2.argon2id });
}

// Never throws for a malformed hash; a mismatch and a bad hash both return false.
async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

// Verified against when the email is unknown or the account is inactive, so the
// response takes as long as a real check and does not reveal which case it was.
let dummyHash;
async function verifyAgainstDummy(password) {
  dummyHash ??= await hashPassword('psp-dummy-password-never-matches');
  await verifyPassword(dummyHash, password);
  return false;
}

module.exports = { hashPassword, verifyPassword, verifyAgainstDummy };
