const isProduction = !!process.env.DATABASE_URL;

// isProduction 판별식 자체(DATABASE_URL 유무)는 바꾸지 않는다 — knexfile.js가 이 값으로 sqlite/pg
// 드라이버를 고르기 때문에, NODE_ENV까지 AND 조건으로 넣으면 DATABASE_URL만 설정한 배포가 조용히
// sqlite로 떠서 운영 데이터가 컨테이너와 함께 사라지는 더 나쁜 사고가 난다. 대신 위험한 방향
// (NODE_ENV는 production인데 DATABASE_URL이 없음)만 기동 시점에 즉시 막는다.
if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
  throw new Error('NODE_ENV=production인데 DATABASE_URL이 없습니다. 운영에서 SQLite로 기동하는 것을 막습니다.');
}

// 연결 설정(client/connection)과 migrations 디렉터리를 knexfile.js와 이중으로 유지하면 둘 중 하나만
// 바뀌었을 때 initDb()와 `knex migrate:*` CLI가 서로 다른 DB/디렉터리를 보게 될 수 있다.
// knexfile.js를 그대로 재사용해서 설정이 한 곳에만 존재하도록 한다.
const knexConfig = require('../../knexfile');
const knex = require('knex')(knexConfig);

async function createIfMissing(tableName, builder) {
  const exists = await knex.schema.hasTable(tableName);
  if (!exists) await knex.schema.createTable(tableName, builder);
}

async function addColumnIfMissing(table, column, builder) {
  const has = await knex.schema.hasColumn(table, column);
  if (!has) await knex.schema.table(table, t => builder(t));
}

function isAlreadyExistsError(error) {
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || error).toLowerCase();
  return ['42p07', '42710'].includes(code)
    || /already exists/.test(message)
    || /duplicate (?:index|relation|object)/.test(message);
}

async function indexExists(table, indexName) {
  if (isProduction) { const r = await knex.raw('SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ?', [indexName]); return r.rowCount > 0; }
  const rows = await knex.raw(`PRAGMA index_list("${table.replace(/"/g, '""')}")`);
  return rows.some(r => r.name === indexName);
}

async function addIndexIfMissing(table, columns, indexName) {
  if (await indexExists(table, indexName)) return;
  try {
    await knex.schema.table(table, t => t.index(columns, indexName));
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
}

async function foreignKeyExists(table, column, references) {
  const [referenceTable, referenceColumn] = references.split('.');
  if (isProduction) {
    const row = await knex('information_schema.table_constraints as tc')
      .join('information_schema.key_column_usage as kcu', function () {
        this.on('tc.constraint_name', '=', 'kcu.constraint_name')
          .andOn('tc.constraint_schema', '=', 'kcu.constraint_schema');
      })
      .join('information_schema.constraint_column_usage as ccu', function () {
        this.on('tc.constraint_name', '=', 'ccu.constraint_name')
          .andOn('tc.constraint_schema', '=', 'ccu.constraint_schema');
      })
      .whereRaw('tc.table_schema = current_schema()')
      .where('tc.table_name', table)
      .where('tc.constraint_type', 'FOREIGN KEY')
      .where('kcu.column_name', column)
      .where('ccu.table_name', referenceTable)
      .where('ccu.column_name', referenceColumn)
      .select('tc.constraint_name')
      .first();
    return !!row;
  }

  const safeTable = table.replace(/"/g, '""');
  const foreignKeys = await knex.raw(`PRAGMA foreign_key_list("${safeTable}")`);
  return foreignKeys.some(foreignKey => (
    foreignKey.from === column
    && foreignKey.table === referenceTable
    && foreignKey.to === referenceColumn
  ));
}

async function addForeignKeyIfMissing(table, column, references, onDelete) {
  if (await foreignKeyExists(table, column, references)) return;
  try {
    await knex.schema.table(table, t => {
      t.foreign(column).references(references).onDelete(onDelete);
    });
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
}

// addColumnIfMissing의 반대. deprecated 컬럼(예: stores.toss_api_key)이 "지울 방법이 없어서" 영구히
// 남는 문제를 해결하기 위한 헬퍼 — 단 SQLite는 DROP COLUMN을 위해 테이블 전체를 재생성(임시 테이블 생성 →
// 데이터 복사 → 원본 삭제 → 이름 변경)하므로, FK/인덱스가 얽힌 테이블에서 실데이터가 있는 채로 실행하면
// 손상 위험이 있다. 반드시 마이그레이션 파일 안에서, 백업을 확인한 뒤 신중하게 호출할 것.
async function dropColumnIfExists(table, column) {
  const has = await knex.schema.hasColumn(table, column);
  if (has) await knex.schema.table(table, t => t.dropColumn(column));
}

async function initDb() {
  // ── 브랜드 ────────────────────────────────────────────
  await createIfMissing('brands', t => {
    t.increments('id');
    t.string('name').notNullable();
    t.string('code').unique();
    t.datetime('created_at').defaultTo(knex.fn.now());
  });
  await addColumnIfMissing('brands', 'risk_settings', t => t.text('risk_settings').nullable());
  const defaultBrand = await knex('brands').first();
  let defaultBrandId = defaultBrand?.id;
  if (!defaultBrand) {
    const [row] = await knex('brands').insert({ name: '포스모스', code: 'posmos' }).returning('id');
    defaultBrandId = row.id;
  }

  // ── 가맹점 ────────────────────────────────────────────
  await createIfMissing('stores', t => {
    t.increments('id');
    t.integer('brand_id').references('brands.id').onDelete('CASCADE');
    t.string('name').notNullable();
    t.string('webhook_secret');
    t.string('toss_store_id'); // 토스플레이스(POS 매출 동기화) 가맹점 ID
    t.datetime('created_at').defaultTo(knex.fn.now());
  });
  await addColumnIfMissing('stores', 'brand_id', t => t.integer('brand_id').defaultTo(defaultBrandId));
  await addColumnIfMissing('stores', 'order_deadline', t => t.string('order_deadline').nullable());
  await addColumnIfMissing('stores', 'delivery_days', t => t.string('delivery_days').nullable());
  await addColumnIfMissing('stores', 'toss_api_key', t => t.string('toss_api_key').nullable()); // deprecated; 토스페이먼츠(결제) 자격증명
  await addColumnIfMissing('stores', 'toss_client_id', t => t.string('toss_client_id').nullable()); // 토스페이먼츠(결제) 자격증명
  await addColumnIfMissing('stores', 'toss_client_secret', t => t.string('toss_client_secret').nullable()); // 토스페이먼츠(결제) 자격증명
  await addColumnIfMissing('stores', 'last_synced_at', t => t.datetime('last_synced_at').nullable());
  await addColumnIfMissing('stores', 'business_number', t => t.string('business_number').nullable());
  await addColumnIfMissing('stores', 'owner_name', t => t.string('owner_name').nullable());
  await addColumnIfMissing('stores', 'phone', t => t.string('phone').nullable());
  await addColumnIfMissing('stores', 'open_date', t => t.date('open_date').nullable());
  await addColumnIfMissing('stores', 'franchise_type', t => t.string('franchise_type').nullable()); // 가맹점 / 직영점
  await addColumnIfMissing('stores', 'is_open', t => t.boolean('is_open').defaultTo(true));
  await addColumnIfMissing('stores', 'address', t => t.string('address').nullable());
  const defaultStore = await knex('stores').first();
  let defaultStoreId = defaultStore?.id;
  if (!defaultStore) {
    const [row] = await knex('stores').insert({ name: '기본 가맹점', webhook_secret: process.env.TOSS_WEBHOOK_SECRET || '', brand_id: defaultBrandId }).returning('id');
    defaultStoreId = row.id;
  }
  await knex('stores').whereNull('brand_id').update({ brand_id: defaultBrandId });

  // ── 외부 연동 (stores의 기존 연동 컬럼과 병행하는 확장용 테이블) ──
  await createIfMissing('store_integrations', t => {
    t.increments('id');
    t.integer('store_id').references('stores.id').onDelete('CASCADE');
    t.string('provider').notNullable(); // 예: TOSS_PLACE, TOSS_PAYMENTS
    t.string('external_id').nullable();
    t.text('credentials').nullable(); // JSON 문자열: 자격증명 저장 형식은 provider별로 해석
    t.datetime('last_synced_at').nullable();
    t.datetime('created_at').defaultTo(knex.fn.now());
    t.unique(['store_id', 'provider']);
  });

  // ── 사용자 ────────────────────────────────────────────
  await createIfMissing('users', t => {
    t.increments('id');
    t.integer('brand_id').references('brands.id').onDelete('CASCADE');
    t.integer('store_id').references('stores.id').onDelete('SET NULL').nullable();
    t.string('email').notNullable().unique();
    t.string('password_hash').notNullable();
    t.string('name').notNullable();
    // roles: SUPER_ADMIN, HQ_ADMIN, HQ_LOGISTICS, HQ_ACCOUNTING, STORE_OWNER, STORE_STAFF
    t.string('role').notNullable().defaultTo('STORE_OWNER');
    t.boolean('is_active').defaultTo(true);
    t.datetime('created_at').defaultTo(knex.fn.now());
  });
  // 기본 슈퍼 관리자
  // 예전엔 비밀번호가 'admin1234'로 소스에 그대로 박혀 있어서 git 이력에 영구히 남았다 — 운영 DB가
  // 비어있는 상태로 첫 배포를 하면 공개된 비밀번호를 가진 최고관리자 계정이 그대로 생성되는 문제였다.
  // 계정이 하나도 없으면 애초에 로그인할 방법이 없으므로 부트스트랩 자체는 필요하고,
  // 여기서는 "예측 가능한 비밀번호"만 없앤다. 이미 SUPER_ADMIN이 있으면(superAdmin 존재) 절대
  // 건드리지 않는다 — 재기동마다 비밀번호가 덮어써지면 그게 더 큰 사고다.
  const superAdmin = await knex('users').where({ role: 'SUPER_ADMIN' }).first();
  if (!superAdmin) {
    const bcrypt = require('bcryptjs');
    const adminEmail = process.env.INITIAL_ADMIN_EMAIL || 'admin@posmos.com';
    let adminPassword = process.env.INITIAL_ADMIN_PASSWORD;
    if (!adminPassword) {
      if (isProduction) {
        // 운영에서 INITIAL_ADMIN_PASSWORD를 안 넣었다고 서버 기동 자체를 막으면, 배포가 통째로
        // 실패했을 때 운영자가 복구할 방법이 더 어려워진다. 그래서 하드코딩된 값 대신 암호학적으로
        // 안전한 임의 비밀번호를 생성해서 쓰고, 로그인할 방법이 있어야 하니 로그에 딱 한 번 출력한다.
        // 트레이드오프: 이 임의 비밀번호가 서버 로그에 남는다 — 로그 접근 권한이 있는 운영자만
        // 볼 수 있고 계정마다 매번 새로 생성되므로, 소스에 고정값이 영구히 박히는 것보다는 낫다고
        // 판단했다. 확인 즉시 비밀번호를 바꾸라고 로그에 명시한다.
        const crypto = require('crypto');
        adminPassword = crypto.randomBytes(18).toString('base64url');
        console.warn('='.repeat(72));
        console.warn('[초기 관리자 계정] INITIAL_ADMIN_PASSWORD 미설정 — 임의 비밀번호를 생성했습니다.');
        console.warn(`  이메일: ${adminEmail}`);
        console.warn(`  임시 비밀번호: ${adminPassword}`);
        console.warn('  이 비밀번호는 이 로그에만 남습니다. 지금 로그인한 뒤 즉시 비밀번호를 변경하세요.');
        console.warn('='.repeat(72));
      } else {
        // 로컬 개발은 기존 동작을 그대로 유지 — 이미 이 값으로 접속하는 개발 흐름이 굳어져 있어서
        // 여기서 바꾸면 다른 개발자들의 로컬 환경이 깨진다.
        adminPassword = 'admin1234';
      }
    }
    const hash = await bcrypt.hash(adminPassword, 10);
    await knex('users').insert({ brand_id: defaultBrandId, email: adminEmail, password_hash: hash, name: '포스모스 관리자', role: 'SUPER_ADMIN' });
  }
  // 점주 비밀번호 일괄 초기화 (임시 — 로그인 후 삭제 예정)
  // 로컬 테스트 편의를 위해 일부러 남겨둔 코드라 삭제하지 않되, 운영 DB에서까지 서버가 뜰 때마다
  // 실제 점주/직원 비밀번호를 admin123으로 되돌려버리는 사고를 막기 위해 운영 환경에서는 건너뛴다
  if (!isProduction) {
    const bcrypt = require('bcryptjs');
    const resetHash = await bcrypt.hash('admin123', 10);
    await knex('users').whereIn('role', ['STORE_OWNER', 'STORE_STAFF']).update({ password_hash: resetHash });

    // 로컬 데모 로그인 버튼(client/src/pages/Login.jsx)이 쓰는 고정 계정. 운영에서는 절대 만들지 않는다
    // (위 if (!isProduction) 안). 이미 있으면 손대지 않되(수동으로 바꾼 값을 덮어쓰면 그게 더 사고),
    // 비밀번호는 위 일괄 초기화가 STORE_OWNER/STORE_STAFF만 대상으로 하므로 HQ_ADMIN 데모 계정만
    // 여기서 따로 admin123으로 맞춘다.
    // 스키마 변경이 아니라 로컬 전용 시드라 마이그레이션이 아닌 여기에 둔다 — 마이그레이션은 운영에서도
    // 실행되므로 데모 계정이 운영 DB에 생긴다(migrations/README.md의 원칙에 대한 의도적 예외).
    const demoHash = await bcrypt.hash('admin123', 10);
    const demoAccounts = [
      { email: 'owner@posmos.com', name: '데모 점주', role: 'STORE_OWNER', store_id: defaultStoreId },
      { email: 'hq@posmos.com',    name: '데모 본사', role: 'HQ_ADMIN',    store_id: null },
    ];
    for (const acc of demoAccounts) {
      const existing = await knex('users').where({ email: acc.email }).first();
      if (!existing) {
        await knex('users').insert({ brand_id: defaultBrandId, store_id: acc.store_id, email: acc.email,
          password_hash: demoHash, name: acc.name, role: acc.role, is_active: true });
      } else if (acc.role === 'HQ_ADMIN') {
        await knex('users').where({ id: existing.id }).update({ password_hash: demoHash, is_active: true });
      }
    }
  }
  // 이 가맹점을 담당하는 본사 직원(영업/배송 등) — users 테이블이 만들어진 뒤에 추가해야 FK 참조 가능
  await addColumnIfMissing('stores', 'assigned_user_id', t => t.integer('assigned_user_id').references('users.id').onDelete('SET NULL').nullable());

  // ── 발주 단위 ─────────────────────────────────────────
  await createIfMissing('units', t => {
    t.increments('id');
    t.integer('brand_id').references('brands.id').onDelete('CASCADE');
    t.string('name').notNullable();          // 박스, 봉, 통
    t.string('base_unit').notNullable();     // g, ml, 개
    t.float('conversion').notNullable();     // 1단위 = conversion * base_unit
    t.datetime('created_at').defaultTo(knex.fn.now());
  });

  // ── 재료 ─────────────────────────────────────────────
  await createIfMissing('ingredients', t => {
    t.increments('id');
    t.integer('brand_id').references('brands.id').onDelete('CASCADE');
    t.integer('store_id').references('stores.id').onDelete('CASCADE');
    t.string('name').notNullable();
    t.string('unit').notNullable();          // 기본 단위 (g, ml, 개)
    t.string('order_unit').nullable();       // 발주 단위 (박스, 봉)
    t.float('order_unit_conversion').nullable(); // 1발주단위 = N 기본단위
    t.float('stock').defaultTo(0);
    t.float('threshold').defaultTo(0);
    t.datetime('created_at').defaultTo(knex.fn.now());
  });
  await addColumnIfMissing('ingredients', 'brand_id', t => t.integer('brand_id').defaultTo(defaultBrandId));
  await addColumnIfMissing('ingredients', 'store_id', t => t.integer('store_id').defaultTo(defaultStoreId));
  await addColumnIfMissing('ingredients', 'order_unit', t => t.string('order_unit').nullable());
  await addColumnIfMissing('ingredients', 'order_unit_conversion', t => t.float('order_unit_conversion').nullable());
  await addColumnIfMissing('ingredients', 'is_key', t => t.boolean('is_key').defaultTo(false));
  await knex('ingredients').whereNull('brand_id').update({ brand_id: defaultBrandId });
  // store_id가 NULL인 재료는 "브랜드 공통 재료"라는 의미가 있다(api.js의 GET /ingredients가
  // 가맹점 전용 재료가 없을 때 이 공통 재료를 대신 보여준다). 그런데 예전에는 여기서 매 기동마다
  // NULL을 기본 가맹점으로 덮어써서, 공통 재료를 등록해도 서버를 재시작하면 특정 가맹점 소속으로
  // 바뀌어 사라졌다 — 그 기능이 사실상 한 번도 동작한 적이 없었다. 이 백필은 store_id 컬럼이
  // 없던 시절의 레거시 행을 메우려던 1회성 목적이었으므로 제거한다.
  // (컬럼 자체에 defaultTo(defaultStoreId)가 있어 새 행은 명시적으로 NULL을 넣지 않는 한 채워진다)

  // ── 메뉴 ─────────────────────────────────────────────
  await createIfMissing('menus', t => {
    t.increments('id');
    t.integer('brand_id').references('brands.id').onDelete('CASCADE');
    t.integer('store_id').references('stores.id').onDelete('CASCADE');
    t.string('name').notNullable();
    t.string('toss_menu_id');
    t.boolean('is_active').defaultTo(true);
    t.date('active_from').nullable();
    t.date('active_to').nullable();
    t.datetime('created_at').defaultTo(knex.fn.now());
  });
  await addColumnIfMissing('menus', 'brand_id', t => t.integer('brand_id').defaultTo(defaultBrandId));
  await addColumnIfMissing('menus', 'store_id', t => t.integer('store_id').defaultTo(defaultStoreId));
  await addColumnIfMissing('menus', 'is_active', t => t.boolean('is_active').defaultTo(true));
  await addColumnIfMissing('menus', 'is_key', t => t.boolean('is_key').defaultTo(false));
  await knex('menus').whereNull('brand_id').update({ brand_id: defaultBrandId });
  // 재료와 같은 이유로 제거 — store_id가 NULL인 메뉴는 "브랜드 표준 메뉴"다. 매장별 메뉴가
  // recipe_source_menu_id로 이 표준 메뉴를 가리켜 레시피를 공유하는 구조(menuResolver.js)라,
  // 매 기동마다 NULL을 기본 가맹점으로 덮어쓰면 표준 메뉴가 통째로 무너진다.

  // ── 레시피 ────────────────────────────────────────────
  await createIfMissing('recipes', t => {
    t.increments('id');
    t.integer('menu_id').references('menus.id').onDelete('CASCADE');
    t.integer('ingredient_id').references('ingredients.id').onDelete('CASCADE');
    t.float('amount').notNullable();
    t.unique(['menu_id', 'ingredient_id']);
  });

  // ── 발주 상품 ─────────────────────────────────────────
  await createIfMissing('products', t => {
    t.increments('id');
    t.integer('brand_id').references('brands.id').onDelete('CASCADE');
    t.integer('ingredient_id').references('ingredients.id').onDelete('SET NULL').nullable();
    t.string('name').notNullable();
    t.string('unit').notNullable();          // 발주 단위
    t.float('unit_conversion').defaultTo(1); // 1발주단위 = N 기본단위(g/ml/개)
    t.string('base_unit').notNullable();     // 기본 단위
    t.float('price').defaultTo(0);           // 단가
    t.boolean('is_active').defaultTo(true);
    t.datetime('created_at').defaultTo(knex.fn.now());
  });
  // 카탈로그가 커지면 가맹점이 발주 화면에서 한눈에 찾기 어려워지므로 카테고리로 묶어서 검색/필터 가능하게 함
  await addColumnIfMissing('products', 'category', t => t.string('category').nullable());

  // ── 발주서 ────────────────────────────────────────────
  await createIfMissing('purchase_orders', t => {
    t.increments('id');
    t.integer('brand_id').references('brands.id').onDelete('CASCADE');
    t.integer('store_id').references('stores.id').onDelete('CASCADE');
    t.integer('created_by').references('users.id').onDelete('SET NULL').nullable();
    t.string('status').defaultTo('DRAFT');
    // DRAFT, ORDERED, REVIEWING, REVISION_REQUESTED, CONFIRMED,
    // PAYMENT_PENDING, PAID, PREPARING_SHIPMENT, SHIPPED, DELIVERED, CLOSED, CANCELED
    t.float('total_amount').defaultTo(0);
    t.float('confirmed_amount').nullable();
    t.text('memo').nullable();
    t.datetime('ordered_at').nullable();
    t.datetime('confirmed_at').nullable();
    t.datetime('shipped_at').nullable();
    t.datetime('delivered_at').nullable();
    t.datetime('created_at').defaultTo(knex.fn.now());
  });
  await addColumnIfMissing('purchase_orders', 'toss_order_code', t => t.string('toss_order_code').nullable()); // 토스페이먼츠(발주 대금 결제) 필드
  await addColumnIfMissing('purchase_orders', 'toss_payment_key', t => t.string('toss_payment_key').nullable()); // 토스페이먼츠(발주 대금 결제) 필드
  await addColumnIfMissing('purchase_orders', 'paid_at', t => t.datetime('paid_at').nullable());
  await addColumnIfMissing('purchase_orders', 'refunded_amount', t => t.float('refunded_amount').defaultTo(0));
  await addColumnIfMissing('purchase_orders', 'stock_reversed', t => t.boolean('stock_reversed').defaultTo(false));
  await addColumnIfMissing('purchase_orders', 'updated_at', t => t.datetime('updated_at').nullable());
  await addColumnIfMissing('purchase_orders', 'stock_applied', t => t.boolean('stock_applied').defaultTo(false));
  // 본사가 수량조정/품절처리/수정요청 등 가맹점이 알아야 할 변경을 했을 때 띄워주는 알림용 플래그
  await addColumnIfMissing('purchase_orders', 'needs_attention', t => t.boolean('needs_attention').defaultTo(false));
  await addColumnIfMissing('purchase_orders', 'attention_note', t => t.text('attention_note').nullable());
  // 가맹점 수령확인(검수) — 본사가 "납품완료" 처리해도 실제로 가맹점이 받은 게 맞는지 확인하는 절차가
  // 없어서, 선결제인데 파손/누락이 있어도 본사에 전화로만 알릴 수밖에 없던 사각지대를 없애기 위함
  await addColumnIfMissing('purchase_orders', 'receipt_confirmed_at', t => t.datetime('receipt_confirmed_at').nullable());
  await addColumnIfMissing('purchase_orders', 'receipt_issue_note', t => t.text('receipt_issue_note').nullable());
  await addColumnIfMissing('purchase_orders', 'receipt_issue_resolved_at', t => t.datetime('receipt_issue_resolved_at').nullable());

  // ── 발주 상품 목록 ────────────────────────────────────
  await createIfMissing('purchase_order_items', t => {
    t.increments('id');
    t.integer('order_id').references('purchase_orders.id').onDelete('CASCADE');
    t.integer('product_id').references('products.id').onDelete('SET NULL').nullable();
    t.string('product_name').notNullable();
    t.string('unit').notNullable();
    t.float('unit_price').defaultTo(0);
    t.float('quantity').notNullable();
    t.float('confirmed_quantity').nullable();
    t.float('amount').defaultTo(0);
    t.string('status').defaultTo('NORMAL'); // NORMAL, OUT_OF_STOCK, SUBSTITUTED
    t.integer('substitute_product_id').nullable();
    t.string('substitute_note').nullable();
    t.datetime('created_at').defaultTo(knex.fn.now());
  });
  await addColumnIfMissing('purchase_order_items', 'refunded_quantity', t => t.float('refunded_quantity').defaultTo(0));

  // ── 레시피 변경 이력 ──────────────────────────────────
  await createIfMissing('recipe_history', t => {
    t.increments('id');
    t.integer('menu_id').references('menus.id').onDelete('CASCADE');
    t.integer('ingredient_id').references('ingredients.id').onDelete('CASCADE').nullable();
    t.string('ingredient_name').nullable();
    t.float('old_amount').nullable();
    t.float('new_amount').nullable();
    t.string('action').notNullable(); // ADDED, UPDATED, DELETED
    t.integer('changed_by').references('users.id').onDelete('SET NULL').nullable();
    t.datetime('created_at').defaultTo(knex.fn.now());
  });

  // ── 주문 수정 이력 ────────────────────────────────────
  // 이 테이블은 365일 후 하드 삭제됨 (실제 삭제 로직은 server/src/index.js의 runDataCleanup 참고).
  await createIfMissing('order_history', t => {
    t.increments('id');
    t.integer('order_id').references('purchase_orders.id').onDelete('CASCADE');
    t.integer('item_id').references('purchase_order_items.id').onDelete('CASCADE').nullable();
    t.integer('changed_by').references('users.id').onDelete('SET NULL').nullable();
    t.string('action').notNullable(); // STATUS_CHANGE, QUANTITY_CHANGE, etc.
    t.text('before_value').nullable();
    t.text('after_value').nullable();
    t.text('reason').nullable();
    t.datetime('created_at').defaultTo(knex.fn.now());
  });
  // 환불/반품 사유를 코드로 분류해서 나중에 "어떤 사유가 잦은지" 통계를 낼 수 있게 함 (자유 텍스트만으로는 집계 불가)
  await addColumnIfMissing('order_history', 'reason_code', t => t.string('reason_code').nullable());

  // ── 감사 로그 (가격/재료/사용자 등 민감 변경 기록) ──────
  await createIfMissing('audit_log', t => {
    t.increments('id');
    t.integer('brand_id').references('brands.id').onDelete('CASCADE');
    t.integer('user_id').references('users.id').onDelete('SET NULL').nullable();
    t.string('entity_type').notNullable(); // PRODUCT, INGREDIENT, MENU, STORE, USER
    t.integer('entity_id').nullable();
    t.string('action').notNullable(); // CREATE, UPDATE, DELETE
    t.text('before_value').nullable();
    t.text('after_value').nullable();
    t.datetime('created_at').defaultTo(knex.fn.now());
  });

  // ── 결제 ─────────────────────────────────────────────
  await createIfMissing('payments', t => {
    t.increments('id');
    t.integer('order_id').references('purchase_orders.id').onDelete('CASCADE');
    t.string('payment_key').unique().nullable();
    t.string('status').defaultTo('NOT_REQUESTED');
    // NOT_REQUESTED, REQUESTED, PENDING, PAID, FAILED, CANCELED, PARTIALLY_REFUNDED, REFUNDED
    t.float('amount').defaultTo(0);
    t.string('method').nullable(); // 가상계좌, 카드, 계좌이체
    t.text('raw_response').nullable();
    t.datetime('paid_at').nullable();
    t.datetime('created_at').defaultTo(knex.fn.now());
  });

  // ── 폐기 입력 ─────────────────────────────────────────
  await createIfMissing('waste_logs', t => {
    t.increments('id');
    t.integer('brand_id').references('brands.id').onDelete('CASCADE');
    t.integer('store_id').references('stores.id').onDelete('CASCADE');
    t.integer('ingredient_id').references('ingredients.id').onDelete('SET NULL').nullable();
    t.integer('created_by').references('users.id').onDelete('SET NULL').nullable();
    t.date('waste_date').notNullable();
    t.string('ingredient_name').notNullable();
    t.float('quantity').notNullable();
    t.string('unit').notNullable();
    t.string('reason').notNullable();
    t.text('memo').nullable();
    t.datetime('created_at').defaultTo(knex.fn.now());
  });

  // ── 정기 발주 템플릿 ───────────────────────────────────
  // 가맹점이 매번 같은 품목을 새로 장바구니에 담는 비효율을 없애기 위해 구성을 저장해두고 재사용
  await createIfMissing('order_templates', t => {
    t.increments('id');
    t.integer('brand_id').references('brands.id').onDelete('CASCADE');
    t.integer('store_id').references('stores.id').onDelete('CASCADE');
    t.string('name').notNullable();
    t.text('items').notNullable(); // JSON: [{product_id, product_name, unit, unit_price, quantity}]
    t.datetime('created_at').defaultTo(knex.fn.now());
  });

  // 기존 items JSON 컬럼과 병행하는 정규화 테이블. 기존 라우트는 아직 JSON 컬럼을 사용한다.
  await createIfMissing('order_template_items', t => {
    t.increments('id');
    t.integer('order_template_id').references('order_templates.id').onDelete('CASCADE');
    t.integer('product_id').references('products.id').onDelete('SET NULL').nullable();
    t.string('product_name').notNullable();
    t.string('unit').notNullable();
    t.float('unit_price').notNullable();
    t.float('quantity').notNullable();
    t.datetime('created_at').defaultTo(knex.fn.now());
  });

  // ── 리스크 알림 ───────────────────────────────────────
  // 이 테이블은 180일 후 하드 삭제됨 (실제 삭제 로직은 server/src/index.js의 runDataCleanup 참고).
  await createIfMissing('risk_alerts', t => {
    t.increments('id');
    t.integer('brand_id').references('brands.id').onDelete('CASCADE');
    t.integer('store_id').references('stores.id').onDelete('CASCADE').nullable();
    t.string('type').notNullable();
    // OVER_PURCHASE, SALES_DOWN_ORDER_UP, LOW_TURNOVER, HIGH_WASTE, STORE_OUTLIER, PAYMENT_OVERDUE, LOW_STOCK
    t.string('severity').defaultTo('MEDIUM'); // HIGH, MEDIUM, LOW
    t.string('status').defaultTo('OPEN');
    // OPEN, ACKNOWLEDGED, IN_PROGRESS, RESOLVED, DISMISSED
    t.text('description').nullable();
    t.text('detail').nullable();
    t.integer('acknowledged_by').nullable(); // users.id; 사용자가 삭제되면 NULL 처리
    t.text('memo').nullable();
    t.datetime('created_at').defaultTo(knex.fn.now());
  });
  await addColumnIfMissing('risk_alerts', 'occurrence_count', t => t.integer('occurrence_count').defaultTo(1));
  await addColumnIfMissing('risk_alerts', 'last_occurred_at', t => t.datetime('last_occurred_at').nullable());

  // ── POS 주문 (기존 orders → 토스 POS 판매 데이터) ─────
  await createIfMissing('orders', t => {
    t.increments('id');
    t.integer('brand_id').references('brands.id').onDelete('CASCADE');
    t.integer('store_id').references('stores.id').onDelete('CASCADE');
    t.string('toss_order_id').unique(); // 범용 주문 식별자: 토스/배민/쿠팡이츠/요기요 등은 channel로 구분
    t.text('raw_payload');
    t.datetime('processed_at').defaultTo(knex.fn.now());
  });
  await addColumnIfMissing('orders', 'brand_id', t => t.integer('brand_id').defaultTo(defaultBrandId));
  await addColumnIfMissing('orders', 'store_id', t => t.integer('store_id').defaultTo(defaultStoreId));
  await knex('orders').whereNull('brand_id').update({ brand_id: defaultBrandId });
  await knex('orders').whereNull('store_id').update({ store_id: defaultStoreId });
  // 매번 raw_payload를 파싱하지 않고 대시보드/정산에서 바로 합산할 수 있도록 정규화해서 같이 저장
  await addColumnIfMissing('orders', 'order_state', t => t.string('order_state').nullable());
  await addColumnIfMissing('orders', 'list_price', t => t.float('list_price').defaultTo(0));
  await addColumnIfMissing('orders', 'discount_amount', t => t.float('discount_amount').defaultTo(0));
  await addColumnIfMissing('orders', 'supply_amount', t => t.float('supply_amount').defaultTo(0));
  await addColumnIfMissing('orders', 'total_amount', t => t.float('total_amount').defaultTo(0));
  await addColumnIfMissing('orders', 'cash_amount', t => t.float('cash_amount').defaultTo(0));
  await addColumnIfMissing('orders', 'card_amount', t => t.float('card_amount').defaultTo(0));
  await addColumnIfMissing('orders', 'other_amount', t => t.float('other_amount').defaultTo(0));
  // 판매 채널 — 토스 주문 원본의 order.source 값 (POS/배민/쿠팡이츠/요기요 등, server/src/channels/toss.js 참고).
  // 이 컬럼이 생기기 전 동기화된 기존 데이터는 출처를 구분하지 못하므로 POS로 백필
  await addColumnIfMissing('orders', 'channel', t => t.string('channel').defaultTo('POS'));
  await knex('orders').whereNull('channel').update({ channel: 'POS' });

  // ── 판매 내역 (정규화된 메뉴별 판매) ─────────────────
  await createIfMissing('sales_items', t => {
    t.increments('id');
    t.integer('brand_id').references('brands.id').onDelete('CASCADE');
    t.integer('store_id').references('stores.id').onDelete('CASCADE');
    t.string('toss_order_id').notNullable(); // 범용 주문 식별자: toss_ 접두사는 레거시이며 토스 전용이 아님
    t.string('menu_name').notNullable();
    t.string('toss_menu_id').nullable(); // 범용 메뉴 식별자: toss_ 접두사는 레거시이며 토스 전용이 아님
    t.integer('quantity').defaultTo(1);
    t.float('unit_price').defaultTo(0);
    t.float('amount').defaultTo(0);
    t.datetime('sold_at').notNullable();
    t.datetime('created_at').defaultTo(knex.fn.now());
    t.unique(['toss_order_id', 'menu_name']);
  });
  await addColumnIfMissing('sales_items', 'channel', t => t.string('channel').defaultTo('POS'));
  await knex('sales_items').whereNull('channel').update({ channel: 'POS' });

  // ── 알림 로그 ─────────────────────────────────────────
  await createIfMissing('alert_log', t => {
    t.increments('id');
    t.integer('brand_id').defaultTo(defaultBrandId);
    t.integer('store_id').references('stores.id').onDelete('CASCADE');
    t.integer('ingredient_id').nullable(); // ingredients.id; 삭제 시 NULL 처리되는 알림 기록
    t.float('stock_at_alert');
    t.datetime('sent_at').defaultTo(knex.fn.now());
  });
  await addColumnIfMissing('alert_log', 'brand_id', t => t.integer('brand_id').defaultTo(defaultBrandId));
  await addColumnIfMissing('alert_log', 'store_id', t => t.integer('store_id').defaultTo(defaultStoreId));
  await knex('alert_log').whereNull('brand_id').update({ brand_id: defaultBrandId });
  await knex('alert_log').whereNull('store_id').update({ store_id: defaultStoreId });

  // 기존 데이터에 있는 orphan를 먼저 정리해야 기존 테이블에도 FK를 안전하게 추가할 수 있다.
  await knex('alert_log')
    .whereNotNull('ingredient_id')
    .whereNotExists(function () {
      this.select(knex.raw('1'))
        .from('ingredients')
        .whereRaw('ingredients.id = alert_log.ingredient_id');
    })
    .update({ ingredient_id: null });
  await knex('risk_alerts')
    .whereNotNull('acknowledged_by')
    .whereNotExists(function () {
      this.select(knex.raw('1'))
        .from('users')
        .whereRaw('users.id = risk_alerts.acknowledged_by');
    })
    .update({ acknowledged_by: null });
  await addForeignKeyIfMissing('alert_log', 'ingredient_id', 'ingredients.id', 'SET NULL');
  await addForeignKeyIfMissing('risk_alerts', 'acknowledged_by', 'users.id', 'SET NULL');

  // ── 공지사항 (본사 → 가맹점) ───────────────────────────
  await createIfMissing('notices', t => {
    t.increments('id');
    t.integer('brand_id').references('brands.id').onDelete('CASCADE');
    t.integer('store_id').references('stores.id').onDelete('CASCADE').nullable(); // null이면 전체 가맹점 대상
    t.string('title').notNullable();
    t.text('content').notNullable();
    t.integer('created_by').references('users.id').onDelete('SET NULL').nullable();
    t.boolean('is_active').defaultTo(true);
    t.datetime('created_at').defaultTo(knex.fn.now());
  });

  await createIfMissing('notice_reads', t => {
    t.increments('id');
    t.integer('notice_id').references('notices.id').onDelete('CASCADE');
    t.integer('user_id').references('users.id').onDelete('CASCADE');
    t.integer('store_id').references('stores.id').onDelete('CASCADE').nullable();
    t.datetime('read_at').defaultTo(knex.fn.now());
    t.unique(['notice_id', 'user_id']);
  });

  // ── 재고 수불부 (재고가 바뀌는 모든 경로를 기록) ───────
  await createIfMissing('stock_ledger', t => {
    t.increments('id');
    t.integer('brand_id').references('brands.id').onDelete('CASCADE');
    t.integer('store_id').references('stores.id').onDelete('CASCADE');
    t.integer('ingredient_id').references('ingredients.id').onDelete('CASCADE');
    t.string('type').notNullable(); // DELIVERY, REFUND, SALE, SALE_CANCEL, WASTE, WASTE_CANCEL, ADJUSTMENT
    t.float('quantity_delta').notNullable(); // +면 입고, -면 출고
    t.float('before_stock').nullable();
    t.float('after_stock').nullable();
    t.text('memo').nullable();
    t.string('ref_type').nullable();
    t.integer('ref_id').nullable();
    t.integer('created_by').references('users.id').onDelete('SET NULL').nullable();
    t.datetime('created_at').defaultTo(knex.fn.now());
  });

  // ── 실사 재고 조정 ────────────────────────────────────
  await createIfMissing('stock_adjustments', t => {
    t.increments('id');
    t.integer('brand_id').references('brands.id').onDelete('CASCADE');
    t.integer('store_id').references('stores.id').onDelete('CASCADE');
    t.integer('ingredient_id').references('ingredients.id').onDelete('CASCADE');
    t.float('before_stock').notNullable();
    t.float('counted_stock').notNullable(); // 실사로 직접 센 수량
    t.float('diff').notNullable(); // counted_stock - before_stock
    t.text('memo').nullable();
    t.integer('created_by').references('users.id').onDelete('SET NULL').nullable();
    t.datetime('created_at').defaultTo(knex.fn.now());
  });

  await addIndexIfMissing('orders', ['store_id', 'processed_at'], 'idx_orders_store_processed_at');
  await addIndexIfMissing('sales_items', ['store_id', 'sold_at'], 'idx_sales_items_store_sold_at');
  await addIndexIfMissing('purchase_orders', ['store_id', 'status'], 'idx_purchase_orders_store_status');
  await addIndexIfMissing('risk_alerts', ['brand_id', 'status'], 'idx_risk_alerts_brand_status');

  // ── 버전 관리되는 마이그레이션 실행 ──────────────────────
  // 반드시 위의 레거시 스키마 작업이 전부 끝난 뒤에 실행한다 — 앞으로의 마이그레이션은 initDb()가 만든
  // 스키마 위에 얹히는 것을 전제로 작성되므로, 순서가 바뀌면 대상 테이블/컬럼이 아직 없는 상태에서 실행될
  // 수 있다. 여기서 던진 예외는 그대로 initDb()의 반환 Promise를 reject시키고, server/src/index.js의
  // initDb().catch(...)가 받아 서버 기동을 중단한다 — 깨진 스키마 위에서 서버가 계속 도는 것보다 안전하다.
  const [, appliedMigrations] = await knex.migrate.latest();
  if (appliedMigrations.length > 0) {
    console.log(`[마이그레이션] 적용됨: ${appliedMigrations.join(', ')}`);
  }
}

module.exports = { knex, initDb, isProduction, dropColumnIfExists };
