const { knex, initDb, isProduction } = require('../src/db/schema');
const { syncOrderTemplateItems } = require('../src/dbHelpers');

async function backfillOrderTemplateItems() {
  if (isProduction) {
    throw new Error('This local-only backfill must not run with DATABASE_URL set.');
  }

  await initDb();
  const templates = await knex('order_templates').select('id', 'items');
  let templateCount = 0;
  let itemCount = 0;
  let skippedCount = 0;

  for (const template of templates) {
    let items;
    try {
      items = JSON.parse(template.items);
    } catch (error) {
      skippedCount += 1;
      console.warn(`Skipping order template ${template.id}: items is not valid JSON`);
      continue;
    }
    if (!Array.isArray(items)) {
      skippedCount += 1;
      console.warn(`Skipping order template ${template.id}: items is not an array`);
      continue;
    }

    itemCount += await syncOrderTemplateItems(knex, template.id, items);
    templateCount += 1;
  }

  console.log(`order_template_items backfill complete: templates=${templateCount}, items=${itemCount}, skipped=${skippedCount}`);
}

if (require.main === module) {
  backfillOrderTemplateItems()
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => knex.destroy());
}

module.exports = { backfillOrderTemplateItems };
