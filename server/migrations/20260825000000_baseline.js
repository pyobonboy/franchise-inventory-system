/**
 * 베이스라인 마이그레이션 — 스키마를 변경하지 않는 no-op 파일.
 *
 * - 이 시점(2026-08-25) 이전의 스키마는 전부 server/src/db/schema.js의 initDb()가 담당한다
 *   (createIfMissing / addColumnIfMissing / addIndexIfMissing / addForeignKeyIfMissing로 누적된 것).
 *   이 파일은 그 스키마를 다시 만들거나 건드리지 않는다.
 * - 이 파일 이후의 모든 스키마 변경(테이블/컬럼 추가·삭제, 인덱스, FK 등)은 initDb()를 더 건드리지 않고
 *   `npm run migrate:make -- <이름>`으로 새 마이그레이션 파일을 만들어 작성한다.
 * - 이 마이그레이션이 최초로 적용되면서 knex의 `knex_migrations` 이력 테이블이 이 시점 기준으로 생성된다 —
 *   이후 서버 기동 시 initDb()가 끝난 뒤 knex.migrate.latest()가 이 테이블을 보고 적용 여부를 판단한다.
 */

exports.up = async function up() {
  // no-op — 베이스라인 지점을 표시하기 위한 파일이라 실제 스키마 변경이 없다.
};

exports.down = async function down() {
  // no-op
};
