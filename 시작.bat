@echo off
echo 재고 알림 시스템 시작 중...

rem 하드코딩된 사용자 경로(C:\Users\user\...)는 이 PC가 아니면 항상 실패한다. PATH에 등록되어
rem 있으면 where로 찾고, 없으면 winget 기본 설치 경로로 폴백한다.
set CF=
for /f "delims=" %%i in ('where cloudflared 2^>nul') do set CF="%%i"
if not defined CF (
  if exist "%LOCALAPPDATA%\Microsoft\WinGet\Packages\Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe\cloudflared.exe" (
    set CF="%LOCALAPPDATA%\Microsoft\WinGet\Packages\Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe\cloudflared.exe"
  )
)

start "백엔드 서버" cmd /k "cd /d %~dp0server && node src/index.js"
timeout /t 2 /nobreak > nul

start "프론트엔드" cmd /k "cd /d %~dp0client && npm run dev -- --host"
timeout /t 2 /nobreak > nul

if not defined CF (
  echo.
  echo cloudflared를 찾을 수 없습니다 — 터널 없이 로컬 주소로만 접속하세요.
  echo   백엔드:   http://localhost:3001
  echo   프론트엔드: http://localhost:5173
  goto :end
)

start "터널-백엔드" cmd /k "%CF% tunnel --url http://localhost:3001"
timeout /t 2 /nobreak > nul

start "터널-프론트" cmd /k "%CF% tunnel --url http://localhost:5173"

echo.
echo 완료! 터널 창에서 trycloudflare.com 주소 확인하세요.

:end
