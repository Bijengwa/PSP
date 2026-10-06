require('dotenv').config({ quiet: true });

const { hashPassword } = require('../src/auth/password');

// Creates the `admin` role and the first admin from SEED_ADMIN_*. Running it
// again changes nothing. The admin must change the password at first login.
exports.seed = async function (knex) {
  const email = (process.env.SEED_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD || '';
  const fullName = (process.env.SEED_ADMIN_NAME || '').trim();

  if (!email || !password || !fullName) {
    throw new Error('Set SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD and SEED_ADMIN_NAME before seeding');
  }
  if (password.length < 10) {
    throw new Error('SEED_ADMIN_PASSWORD must be at least 10 characters');
  }

  await knex('roles')
    .insert({ name: 'admin', description: 'Full access to the office' })
    .onConflict('name')
    .ignore();
  const role = await knex('roles').where({ name: 'admin' }).first('id');

  await knex('staff_profiles')
    .insert({
      full_name: fullName,
      email,
      password_hash: await hashPassword(password),
      role_id: role.id,
      must_change_password: true,
    })
    .onConflict('email')
    .ignore();
};
