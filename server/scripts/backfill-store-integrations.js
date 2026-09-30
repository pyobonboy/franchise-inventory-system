const { knex, initDb, isProduction } = require('../src/db/schema');
const { syncStoreIntegrations } = require('../src/dbHelpers');

async function backfillStoreIntegrations() {
  if (isProduction) {
    throw new Error('This local-only backfill must not run with DATABASE_URL set.');
  }

  await initDb();
  const stores = await knex('stores')
    .select('id', 'toss_store_id', 'last_synced_at', 'toss_client_id', 'toss_client_secret')
    .where(function () {
      this.whereNotNull('toss_store_id')
        .orWhereNotNull('toss_client_id')
        .orWhereNotNull('toss_client_secret');
    });

  let placeCount = 0;
  let paymentsCount = 0;
  for (const store of stores) {
    const synced = await syncStoreIntegrations(knex, store.id);
    placeCount += synced.place;
    paymentsCount += synced.payments;
  }

  console.log(`store_integrations backfill complete: TOSS_PLACE=${placeCount}, TOSS_PAYMENTS=${paymentsCount}`);
}

if (require.main === module) {
  backfillStoreIntegrations()
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => knex.destroy());
}

module.exports = { backfillStoreIntegrations };
