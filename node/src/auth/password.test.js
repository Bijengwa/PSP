const { HASH_OPTIONS, MAX_LENGTH, hashPassword, verifyPassword, passwordProblems } = require('./password');

const PERSON = { email: 'mary.okafor@psp.test', fullName: "Mary-Jane O'Brien" };
const NAME_RULE = 'Do not use your name or email in the password.';

describe('hashing (H1)', () => {
  test('hashes with argon2id at the pinned parameters, never the plain password', async () => {
    const hash = await hashPassword('Correct-Horse-42!');

    expect(HASH_OPTIONS).toMatchObject({ memoryCost: 65536, timeCost: 3, parallelism: 4, hashLength: 32 });
    // $argon2id$v=19$<params>$<salt>$<hash>; the library orders the params as it likes.
    const [, type, version, params] = hash.split('$');
    expect([type, version]).toEqual(['argon2id', 'v=19']);
    expect(params.split(',').sort()).toEqual(['m=65536', 'p=4', 't=3']);
    expect(hash).not.toContain('Correct-Horse-42!');
    expect(await verifyPassword(hash, 'Correct-Horse-42!')).toBe(true);
    expect(await verifyPassword(hash, 'Correct-Horse-43!')).toBe(false);
  });

  test('the same password gets a different salt each time', async () => {
    const [a, b] = await Promise.all([hashPassword('Correct-Horse-42!'), hashPassword('Correct-Horse-42!')]);
    expect(a).not.toBe(b);
  });

  test('a hash made with other parameters still verifies', async () => {
    const argon2 = require('argon2');
    const older = await argon2.hash('Correct-Horse-42!', { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    expect(await verifyPassword(older, 'Correct-Horse-42!')).toBe(true);
  });

  test('a malformed hash is a mismatch, not an error', async () => {
    await expect(verifyPassword('not-a-hash', 'Correct-Horse-42!')).resolves.toBe(false);
  });
});

describe('password rules (H1)', () => {
  test('a strong password passes', () => {
    expect(passwordProblems('Correct-Horse-42!', PERSON)).toEqual([]);
  });

  test('the 1024-character cap: 1024 passes, 1025 is refused', () => {
    const atCap = `Aa1!${'x'.repeat(MAX_LENGTH - 4)}`;
    expect(MAX_LENGTH).toBe(1024);
    expect(passwordProblems(atCap, PERSON)).toEqual([]);
    expect(passwordProblems(`${atCap}x`, PERSON)).toEqual(['Use at most 1024 characters.']);
  });

  test.each([
    ['the first part of a hyphenated name', 'Mary-Rocks-2026#'],
    ['the second part of a hyphenated name', 'Jane-Rocks-2026#'],
    ['a name after an apostrophe', 'Brien-Rocks-2026#'],
    ['a part of the email name', 'Okafor-Rocks-2026#'],
    ['the name in another case', 'MARY-rocks-2026#'],
  ])('refuses %s', (_, password) => {
    expect(passwordProblems(password, PERSON)).toContain(NAME_RULE);
  });

  test('accented names are matched whole', () => {
    expect(passwordProblems('José-Rocks-2026#', { email: 'j@psp.test', fullName: 'José Mtui' })).toContain(NAME_RULE);
  });

  test('name parts shorter than 3 characters are not forbidden', () => {
    expect(passwordProblems('Al-Rocks-2026#', { email: 'al@psp.test', fullName: 'Al Ng' })).toEqual([]);
  });

  test.each(['Password123!', 'WELCOME@123', 'P@ssw0rd123', 'Summer2026!'])('refuses the common password %s', (password) => {
    expect(passwordProblems(password, PERSON)).toContain('This password is too common.');
  });

  test('the reasons never repeat the password', () => {
    const password = 'mary-short';
    for (const problem of passwordProblems(password, PERSON)) expect(problem).not.toContain(password);
  });
});
