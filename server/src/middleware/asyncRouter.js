const express = require('express');

// 비동기 라우트 핸들러에서 발생한 에러(reject)를 자동으로 next(err)에 전달하는 라우터.
// 기존 라우트 코드(try/catch 없이 작성된 핸들러 다수)를 그대로 두고
// 처리되지 않은 에러가 요청을 멈추거나(hang) 서버를 죽이는 것을 방지한다.
function createAsyncRouter() {
  const router = express.Router();
  for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
    const original = router[method].bind(router);
    router[method] = (path, ...handlers) => {
      const wrapped = handlers.map(h => {
        if (typeof h !== 'function') return h;
        return (req, res, next) => {
          try {
            const result = h(req, res, next);
            if (result && typeof result.catch === 'function') result.catch(next);
          } catch (err) {
            next(err);
          }
        };
      });
      return original(path, ...wrapped);
    };
  }
  return router;
}

module.exports = createAsyncRouter;
