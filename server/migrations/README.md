# Schema migrations

이 디렉터리는 이 시점(2026-08-25, `20260825000000_baseline.js`) 이후의 스키마 변경부터
사용하는 Knex 공식 migration 디렉터리입니다.

## 자동 실행

서버가 기동할 때(`server/src/index.js` → `initDb()`) `server/src/db/schema.js`의
`initDb()`가 기존 레거시 스키마 작업을 전부 마친 **뒤에** `knex.migrate.latest()`가
자동으로 실행되어 이 디렉터리의 미적용 마이그레이션을 적용합니다. 순서를 지키는 이유는,
앞으로 작성하는 마이그레이션은 initDb()가 만든 스키마가 이미 있다는 걸 전제로 하기 때문입니다.

- 적용된 마이그레이션이 있으면 `[마이그레이션] 적용됨: ...` 로그가 남습니다. 없으면 조용히 넘어갑니다.
- 마이그레이션이 실패하면 예외가 `initDb()`까지 전파되어 `index.js`의
  `initDb().catch(err => { ...; process.exit(1); })`가 서버 기동을 중단시킵니다. 깨진 스키마
  위에서 서버가 계속 도는 것보다 안전하다는 판단입니다.
- 적용 이력은 knex가 자동으로 만드는 `knex_migrations` 테이블에 기록됩니다.

## 새 스키마 변경을 추가하는 방법

```
npm run migrate:make -- <migration-name>
```

로 `YYYYMMDDHHMMSS_<migration-name>.js` 파일을 생성하고, `up`/`down`에 변경 내용을 작성합니다.
서버를 다시 기동하면(또는 `npm run migrate:latest`) 자동 적용됩니다. 컬럼/테이블 정의는
`server/src/db/schema.js`가 export하는 `knex` 인스턴스와 `dropColumnIfExists(table, column)`
헬퍼(SQLite에서 컬럼 삭제 시 테이블이 재생성되므로 실데이터가 있는 테이블에서는 신중히 사용)를
가져다 쓸 수 있습니다.

## initDb()와의 역할 분담

- **`server/src/db/schema.js`의 `initDb()`**: 이 디렉터리 도입 이전부터 있던 레거시 스키마
  전체를 계속 담당합니다. 이번 도입으로 기존 로직을 수정하거나 대체하지 않았습니다. 앞으로도
  기존 테이블 정의는 여기서 손대지 않는 것이 원칙입니다 — 새 테이블/컬럼/인덱스/FK는 전부
  마이그레이션 파일로 추가합니다.
- **이 디렉터리(`server/migrations/`)**: 베이스라인(`20260825000000_baseline.js`) 이후의
  모든 스키마 변경. 버전 관리되고, 적용 여부가 `knex_migrations` 테이블에 기록되며, 여러
  인스턴스가 동시에 떠도(Render 재배포 등) knex가 마이그레이션 단위로 락을 잡아 레이스 컨디션을
  방지합니다.

## `transaction: false`를 언제 붙이는가

**컬럼 추가/삭제/변경, FK 추가/삭제를 하는 마이그레이션은 sqlite에서 테이블 재생성을 유발하므로
반드시 `exports.config = { transaction: false };`를 붙인다.** 붙이지 않으면 knex가
`PRAGMA foreign_keys=OFF`를 걸지 못해 자식 테이블이 CASCADE로 전멸한다
(`20260825030000_menu_recipe_extensibility.js`에서 실제 발생). 순수 인덱스만 추가하는 경우는
필요 없지만, 판단이 애매하면 붙이는 쪽이 안전하다.

## 설정 공유

`server/knexfile.js`가 connection/migrations 디렉터리 설정의 유일한 소스입니다.
`schema.js`는 자체 knex 인스턴스를 만들 때 이 파일을 그대로 require해서 쓰므로, CLI
(`npm run migrate:make`/`migrate:latest`)와 서버 기동 시 자동 실행이 항상 같은 DB/같은
디렉터리를 보도록 되어 있습니다.
