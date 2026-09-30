import { useEffect, useState, useRef } from 'react';
import { api } from '../api';

const CHECK_INTERVAL_MS = 3 * 60000; // 같은 항목은 3분에 한 번씩만 재확인
const REALERT_COOLDOWN_MS = 3 * 60000; // 같은 항목은 3분 동안 재알림 안 함 (새로고침·새 탭에도 동일 적용)

// localStorage 사용 — sessionStorage는 탭마다 따로 저장되어 새 탭을 열면 쿨다운이 풀려서
// 같은 알림이 또 뜨는 문제가 있었음. localStorage는 같은 브라우저의 모든 탭이 공유하므로
// 새로고침·새 탭 여부와 관계없이 3분 주기가 그대로 유지됨
function loadCooldown(storeId) {
  try {
    const raw = localStorage.getItem(`stock_alert_${storeId}`);
    return raw ? new Map(JSON.parse(raw)) : new Map();
  } catch { return new Map(); }
}
function saveCooldown(storeId, map) {
  try { localStorage.setItem(`stock_alert_${storeId}`, JSON.stringify([...map])); } catch {}
}

// 가맹점 수만큼 stock_alert_<id> 키가 무한히 쌓였다. 24시간 이상 갱신 없는 키는 지운다.
function pruneCooldownKeys() {
  try {
    const cutoff = Date.now() - 24 * 3600000;
    for (let idx = localStorage.length - 1; idx >= 0; idx--) {
      const key = localStorage.key(idx);
      if (!key || !key.startsWith('stock_alert_')) continue;
      try {
        const entries = JSON.parse(localStorage.getItem(key));
        const maxTs = Array.isArray(entries) ? entries.reduce((m, [, ts]) => Math.max(m, ts), 0) : 0;
        if (maxTs < cutoff) localStorage.removeItem(key);
      } catch { localStorage.removeItem(key); }
    }
  } catch {}
}

export default function StockAlert({ storeId, storeName }) {
  const [alerts, setAlerts] = useState([]);
  const alertsRef = useRef([]); // check() 클로저 안에서 항상 최신 alerts를 읽기 위한 ref
  const lastAlertedAt = useRef(new Map());

  useEffect(() => { alertsRef.current = alerts; }, [alerts]);

  useEffect(() => {
    if (!storeId) return;
    pruneCooldownKeys();
    lastAlertedAt.current = loadCooldown(storeId);
    setAlerts([]);
  }, [storeId]);

  useEffect(() => {
    const check = async () => {
      if (!storeId) return;
      const now = Date.now();
      let newLow = [];
      let newRisks = [];

      // 아직 닫지 않은(확인 안 누른) 팝업에 이미 떠 있는 항목은, 쿨다운과 무관하게
      // 절대 또 새로 띄우지 않는다 — 닫기 전에 옆에 하나 더 생기는 걸 막기 위함
      const shownIngIds = new Set();
      const shownRiskIds = new Set();
      for (const a of alertsRef.current) {
        for (const i of a.ingredients) shownIngIds.add(i.id);
        for (const r of a.risks) shownRiskIds.add(r.id);
      }

      // 두 요청을 순차로 기다리면 팝업이 그만큼 늦게 뜨므로 병렬로 조회
      const [dashboardResult, risksResult] = await Promise.allSettled([
        api.getDashboard(storeId),
        // 본사 권한이 없는 가맹점 계정에서는 403이 날 수 있음 — allSettled로 묶어서 그 경우만 조용히 무시
        api.getRisks({ status: 'OPEN', store_id: storeId }),
      ]);

      if (dashboardResult.status === 'fulfilled') {
        // 한 번도 안 알렸거나, 쿨다운이 지난 재료만 새로 알림
        newLow = dashboardResult.value.lowStock.filter(i => {
          if (shownIngIds.has(i.id)) return false;
          const last = lastAlertedAt.current.get(`ing_${i.id}`);
          return !last || now - last > REALERT_COOLDOWN_MS;
        });
      } else {
        console.error('StockAlert error:', dashboardResult.reason);
      }

      if (risksResult.status === 'fulfilled') {
        newRisks = risksResult.value.filter(r => {
          if (shownRiskIds.has(r.id)) return false;
          const key = `risk_${r.id}`;
          const last = lastAlertedAt.current.get(key);
          // last_occurred_at이 쿨다운 기록 이후로 갱신됐으면(재발생) 다시 알림
          const occurredAt = new Date(r.last_occurred_at || r.created_at).getTime();
          return !last || (now - last > REALERT_COOLDOWN_MS) || occurredAt > last;
        });
      }

      if (newLow.length === 0 && newRisks.length === 0) return;

      for (const i of newLow) lastAlertedAt.current.set(`ing_${i.id}`, now);
      for (const r of newRisks) lastAlertedAt.current.set(`risk_${r.id}`, now);
      saveCooldown(storeId, lastAlertedAt.current);

      const id = now;
      setAlerts(prev => [...prev, { id, ingredients: newLow, risks: newRisks }]);
    };

    check();
    const interval = setInterval(check, CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [storeId]);

  if (!storeId) return null;
  if (alerts.length === 0) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-[8px] flex items-center justify-center z-[9999]">
      {alerts.map(alert => {
        const hasStock = alert.ingredients.length > 0;
        const hasRisks = alert.risks.length > 0;
        return (
          <div key={alert.id} className="bg-card rounded-[20px] px-12 py-10 text-center shadow-[0_30px_90px_rgba(0,0,0,0.28),0_8px_32px_rgba(0,0,0,0.12),inset_0_1px_0_rgba(255,255,255,0.4)] border border-line border-t-2 border-t-[rgba(220,38,38,0.25)] animate-[popIn_0.3s_ease] max-w-[420px] w-[90vw]">
            <div className="text-[28px] font-extrabold text-alert mb-1">
              {hasStock && hasRisks ? '리스크 알림!' : hasStock ? '재고 부족!' : '리스크 알림!'}
            </div>
            {storeName && (
              <div className="text-[14px] font-bold text-brand mb-4">
                {storeName}
              </div>
            )}
            <div className="text-sm text-fg-2 leading-[1.8] text-left">
              {hasStock && (
                <div className={hasRisks ? 'mb-[14px]' : 'mb-0'}>
                  {hasRisks && <div className="text-[12px] font-bold text-[#94a3b8] mb-1">재고 부족</div>}
                  {alert.ingredients.map(i => (
                    <div key={`ing-${i.id}`}>
                      <b>{i.name}</b> — 현재 {i.stock}{i.unit} (기준: {i.threshold}{i.unit})
                      {!storeName && i.store_name && (
                        <span className="text-brand font-bold"> [{i.store_name}]</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {hasRisks && (
                <div>
                  {hasStock && <div className="text-[12px] font-bold text-[#94a3b8] mb-1">기타 리스크</div>}
                  {alert.risks.map(r => (
                    <div key={`risk-${r.id}`}>
                      <b>{r.description || r.type}</b>
                      {!storeName && r.store_name && (
                        <span className="text-brand font-bold"> [{r.store_name}]</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={() => setAlerts(prev => prev.filter(a => a.id !== alert.id))}
              className="mt-6 px-8 py-2.5 bg-alert text-white border-none rounded-md text-sm font-semibold cursor-pointer"
            >
              확인
            </button>
          </div>
        );
      })}
      <style>{`
        @keyframes popIn {
          from { transform: scale(0.8); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
