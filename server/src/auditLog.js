const { knex } = require('./db/schema');

async function logAudit(brand_id, user_id, entity_type, entity_id, action, before, after) {
  await knex('audit_log').insert({
    brand_id, user_id, entity_type, entity_id, action,
    before_value: before ? JSON.stringify(before) : null,
    after_value: after ? JSON.stringify(after) : null,
  });
}

module.exports = { logAudit };
