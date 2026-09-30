async function syncStoreIntegrations(knex, storeId) {
  const store = await knex('stores')
    .where({ id: storeId })
    .select('id', 'toss_store_id', 'last_synced_at', 'toss_client_id', 'toss_client_secret')
    .first();
  if (!store) throw new Error(`Store not found: ${storeId}`);

  let place = 0;
  let payments = 0;
  if (store.toss_store_id) {
    await knex('store_integrations')
      .insert({
        store_id: store.id,
        provider: 'TOSS_PLACE',
        external_id: store.toss_store_id,
        last_synced_at: store.last_synced_at || null,
      })
      .onConflict(['store_id', 'provider'])
      .merge({
        external_id: store.toss_store_id,
        last_synced_at: store.last_synced_at || null,
      });
    place = 1;
  }

  if (store.toss_client_id != null && store.toss_client_secret != null) {
    // store.toss_client_secret은 CREDENTIALS_KEY 설정 여부에 따라 평문이거나 'enc:v1:' 접두사가
    // 붙은 암호문이다(server/src/crypto.js). 여기서 복호화한 뒤 다시 저장하면 credentials 컬럼에
    // 평문 사본이 남아 stores 쪽만 암호화한 의미가 없어지므로, DB에서 읽은 값을 그대로(=같은
    // 암호화 상태로) 복사한다 — stores와 store_integrations가 항상 같은 형태(둘 다 평문 또는 둘 다
    // 암호문)를 유지하게 하기 위함.
    const credentials = JSON.stringify({
      client_id: store.toss_client_id,
      client_secret: store.toss_client_secret,
    });
    await knex('store_integrations')
      .insert({
        store_id: store.id,
        provider: 'TOSS_PAYMENTS',
        credentials,
      })
      .onConflict(['store_id', 'provider'])
      .merge({ credentials });
    payments = 1;
  }

  return { place, payments };
}

function asFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function syncOrderTemplateItems(knex, orderTemplateId, items) {
  // 전 브랜드 상품 전체를 스캔할 필요 없이, items에 실제로 등장하는 id만 조회한다.
  const wanted = [...new Set(
    (Array.isArray(items) ? items : [])
      .map(i => Number(i?.product_id))
      .filter(Number.isInteger),
  )];
  const productRows = wanted.length ? await knex('products').whereIn('id', wanted).select('id') : [];
  const productIds = new Set(productRows.map(product => Number(product.id)));
  const rows = (Array.isArray(items) ? items : []).map(item => {
    const parsedProductId = Number(item?.product_id);
    const productId = Number.isInteger(parsedProductId) && productIds.has(parsedProductId)
      ? parsedProductId
      : null;
    return {
      order_template_id: orderTemplateId,
      product_id: productId,
      product_name: String(item?.product_name ?? ''),
      unit: String(item?.unit ?? ''),
      unit_price: asFiniteNumber(item?.unit_price),
      quantity: asFiniteNumber(item?.quantity),
    };
  });

  await knex.transaction(async trx => {
    await trx('order_template_items').where({ order_template_id: orderTemplateId }).delete();
    if (rows.length > 0) await trx('order_template_items').insert(rows);
  });
  return rows.length;
}

module.exports = { syncStoreIntegrations, syncOrderTemplateItems };
