import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:3001',
      '/auth': 'http://localhost:3001',
      '/webhook': 'http://localhost:3001',
      '/sse': { target: 'http://localhost:3001', ws: false, changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // 벤더 청크 분리 — 메인 청크 크기를 줄이기 위함. 라우트 코드 스플리팅(React.lazy)은 하지 않는다.
        // 패키지명 기준으로 분류한다 (경로 정규식만으로는 radix의 보조 패키지들
        // — react-remove-scroll 등 — 이 react와 서로를 참조하는 순환 청크가 생겼음).
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          const normalized = id.replace(/\\/g, '/');
          const match = normalized.match(/node_modules\/(.*)/);
          const pkgPath = match ? match[1] : normalized;
          const pkgName = pkgPath.startsWith('@')
            ? pkgPath.split('/').slice(0, 2).join('/')
            : pkgPath.split('/')[0];

          const REACT_CORE = ['react', 'react-dom', 'react-router-dom', 'react-router', 'scheduler'];
          // radix-ui / @radix-ui 가 내부적으로 쓰는 보조 패키지들 — react를 참조하므로 react와
          // 별도 vendor 청크에 두면 순환이 생긴다. radix 청크로 함께 묶는다.
          const RADIX_HELPERS = [
            'radix-ui', '@radix-ui', '@floating-ui', 'aria-hidden', 'get-nonce',
            'react-remove-scroll', 'react-remove-scroll-bar', 'react-style-singleton',
            'use-callback-ref', 'use-sidecar',
          ];

          if (REACT_CORE.includes(pkgName)) return 'vendor-react';
          if (RADIX_HELPERS.some((p) => pkgName === p || pkgName.startsWith(p + '/'))) return 'vendor-radix';
          // @tosspayments SDK는 CDN 스크립트를 주입하는 얇은 로더라 번들될 코드가 사실상 없다.
          // 전용 청크로 빼면 0바이트 빈 청크가 생겨 빌드 경고가 나므로 vendor에 함께 둔다.
          return 'vendor';
        },
      },
    },
  },
});
