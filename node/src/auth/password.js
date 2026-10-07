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

const MIN_LENGTH = 10;
const MAX_LENGTH = 1024;
const COMMON_PASSWORDS = new Set([
  'password1!', 'password12!', 'password123!', 'passw0rd123!', 'p@ssword123', 'p@ssw0rd123',
  'welcome123!', 'welcome@123', 'qwerty123!', 'qwerty@123', 'admin@1234', 'admin12345!',
  'letmein123!', 'iloveyou123!', 'changeme123!', 'abcd@12345', 'abc123456!', 'summer2026!',
  'winter2026!', 'tanzania123!', 'company123!', 'psp@123456',
]);

// Parts of a name or email shorter than this are too common to forbid.
const MIN_PERSONAL_PART = 3;

function personalParts({ email, fullName }) {
  const localPart = String(email || '').split('@')[0];
  return [...String(fullName || '').split(/\s+/), ...localPart.split(/[^a-z0-9]+/i)]
    .map((part) => part.toLowerCase())
    .filter((part) => part.length >= MIN_PERSONAL_PART);
}

// The password strength rules from the auth spec §7. Returns the rules the
// password breaks, as messages for the person; an empty list means it passes.
function passwordProblems(password, person) {
  const problems = [];
  if (password.length < MIN_LENGTH) problems.push(`Use at least ${MIN_LENGTH} characters.`);
  if (password.length > MAX_LENGTH) problems.push(`Use at most ${MAX_LENGTH} characters.`);
  if (!/[a-z]/.test(password)) problems.push('Include a lowercase letter.');
  if (!/[A-Z]/.test(password)) problems.push('Include an uppercase letter.');
  if (!/[0-9]/.test(password)) problems.push('Include a digit.');
  if (!/[^A-Za-z0-9]/.test(password)) problems.push('Include a symbol.');

  const lower = password.toLowerCase();
  if (personalParts(person).some((part) => lower.includes(part))) {
    problems.push('Do not use your name or email in the password.');
  }
  if (COMMON_PASSWORDS.has(lower)) problems.push('This password is too common.');
  return problems;
}

module.exports = { hashPassword, verifyPassword, verifyAgainstDummy, passwordProblems };
