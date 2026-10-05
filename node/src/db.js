const knex = require('knex');
const config = require('../knexfile');

const env = process.env.NODE_ENV || 'development';

if (!config[env]) {
  throw new Error(`No knex configuration found for environment "${env}"`);
}

// One shared connection pool for the whole API.
const db = knex(config[env]);

module.exports = db;
