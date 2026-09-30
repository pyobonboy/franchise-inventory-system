const path = require('path');

const isProduction = !!process.env.DATABASE_URL;

// ssl은 connection 객체 안에 있어야 knex/pg가 인식한다 — 예전처럼 최상위에 두면 조용히 무시되어
// (에러도 안 남) SSL 없이 접속한다. 제자리로 옮기고 나니 이번엔 반대로 SSL이 **강제**되어, SSL을
// 켜지 않은 Postgres(로컬 docker, 자체 호스팅 등)에는 "The server does not support SSL connections"로
// 아예 못 붙는다 — 실제로 로컬 검증 중에 걸렸다. Render의 Postgres는 SSL을 지원하므로 운영 기본값은
// SSL 사용으로 두되, 그런 환경에서 끌 수 있도록 DATABASE_SSL=disable 탈출구를 둔다.
// (기본값을 SSL 켜짐으로 유지하는 이유: 실수로 평문 연결이 되는 것보다 명시적으로 끄게 하는 편이 안전)
const useSsl = String(process.env.DATABASE_SSL || '').toLowerCase() !== 'disable';

const config = isProduction
  ? {
    client: 'pg',
    connection: {
      connectionString: process.env.DATABASE_URL,
      // rejectUnauthorized: false — Render 등 관리형 Postgres가 자체 서명 인증서를 쓰기 때문
      ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
    },
  }
  : {
    client: 'sqlite3',
    // DATABASE_FILE로 덮어쓸 수 있게 해서, 테스트 스위트가 각자 자기만의 임시 sqlite 파일을 쓰고
    // 실제 개발 DB(server/data.db)를 절대 건드리지 않도록 한다 (server/test/helpers.js 참고).
    connection: { filename: process.env.DATABASE_FILE || path.join(__dirname, 'data.db') },
    useNullAsDefault: true,
    pool: {
      afterCreate: (connection, done) => connection.run('PRAGMA foreign_keys = ON', done),
    },
  };

config.migrations = {
  directory: path.join(__dirname, 'migrations'),
};

module.exports = config;
