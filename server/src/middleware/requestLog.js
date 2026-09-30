// 요청 1건당 한 줄 로그: 메서드, 경로, 상태코드, 소요시간.
// 운영 중 장애가 나면 "무슨 요청이 언제 얼마나 걸려서 실패했는지"가 유일한 단서인 경우가 많은데
// 지금은 그걸 남길 방법이 전혀 없었다.
//
// 절대 하지 않는 것:
// - 요청 바디를 남기지 않는다: 로그인 비밀번호(auth.js), 토스 자격증명, 웹훅 서명 원문이
//   그대로 로그에 찍히게 된다.
// - 쿼리스트링을 남기지 않는다: routes/sse.js는 EventSource가 커스텀 헤더를 못 보내는 제약 때문에
//   JWT를 ?token=으로 받는다. 쿼리스트링까지 그대로 로그에 남기면 로그를 보는 사람 누구나 그 토큰으로
//   그 사용자 행세를 할 수 있게 된다 — req.originalUrl에서 '?' 뒤를 통째로 잘라낸다.
const SLOW_MS = 1000;

function requestLog(req, res, next) {
  const startedAt = process.hrtime.bigint();
  const path = req.originalUrl.split('?')[0];
  const isHealthCheck = path === '/health';

  res.on('finish', () => {
    const status = res.statusCode;
    // 헬스체크는 배포 플랫폼이 수 초~수십 초 간격으로 계속 호출한다 — 성공한 호출까지 매번 남기면
    // 정작 봐야 할 요청 로그가 그 사이에 파묻힌다. 실패했을 때만 남긴다.
    if (isHealthCheck && status < 400) return;

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const isSlow = durationMs > SLOW_MS;
    const isFailure = status >= 500;
    const line = `${req.method} ${path} ${status} ${durationMs.toFixed(0)}ms`;

    if (isFailure || isSlow) {
      // 5xx/느린 요청은 눈에 띄어야 원인 추적이 빨라지므로 표시를 붙이고 stderr(console.warn)로 남긴다
      const tag = `${isFailure ? '[오류]' : ''}${isSlow ? '[느림]' : ''}`;
      console.warn(`[요청]${tag} ${line}`);
    } else {
      console.log(`[요청] ${line}`);
    }
  });

  next();
}

module.exports = requestLog;
