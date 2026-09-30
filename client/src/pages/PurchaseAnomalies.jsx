import { toast } from '../toast';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button, Card, Badge, EmptyState, Table, THead, TBody, TR, TH, TD } from '../components/ui';

const QUICK_RANGES = [
  { label: '1주일', days: 7 },
  { label: '1개월', days: 30 },
  { label: '3개월', days: 90 },
];

export default function PurchaseAnomalies() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [fromDate, setFromDate] = useState(() => new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]);
  const [toDate, setToDate] = useState(() => new Date().toISOString().split('T')[0]);

  const load = async () => {
    setLoading(true);
    try {
      const result = await api.getPurchaseAnomalies({ from: fromDate, to: new Date(toDate + 'T23:59:59').toISOString() });
      setData(result);
    } catch (e) {
      // 조회 실패 시 catch가 없어 서버 400/403이 unhandled rejection으로 사라지고 화면은 '데이터 없음'만 보여줬다 — 사용자는 기간을 잘못 넣은 건지 권한이 없는지 알 수 없었다.
      toast(e.message || '조회에 실패했습니다', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const applyQuickRange = (days) => {
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    setFromDate(start.toISOString().split('T')[0]);
    setToDate(end.toISOString().split('T')[0]);
  };

  const registerRisk = async (a) => {
    // `UNDER_PURCHASE` 상수가 서버에 있는데도 화면에서 한 번도 쓰이지 않아, 사입 의심 건이 전부 '과다 사입'으로 등록됐다.
    const type = a.worst_over ? 'OVER_PURCHASE' : (a.worst_under ? 'UNDER_PURCHASE' : 'OVER_PURCHASE');
    const description = a.worst_over
      ? `사입 이상 모니터링: ${a.worst_over.name} 발주량이 예상 소진량의 ${a.worst_over.ratio}배 (과다사입 의심 ${a.over_count}건)`
      : a.worst_under
        ? `사입 이상 모니터링: ${a.worst_under.name} 발주량이 예상 소진량의 ${a.worst_under.ratio}배에 그침 (발주부족 의심 ${a.under_count}건)`
        : `사입 이상 모니터링: 과다사입 의심 ${a.over_count}건, 발주부족 의심 ${a.under_count}건`;
    try {
      const result = await api.createRisk({ store_id: a.store_id, type, severity: 'MEDIUM', description });
      toast(result.created ? '리스크 알림에 등록되었습니다' : '이미 등록된 동일 알림이 있습니다', result.created ? 'success' : 'info');
    } catch (e) {
      toast(e.message || '등록에 실패했습니다', 'error');
    }
  };

  return (
    <div>
      <h2 className="mb-4">사입 이상 모니터링</h2>
      <p className="text-muted mb-4 text-xs">
        매출 기준 예상 식자재 소진량 대비 실제 발주량을 가맹점별로 비교해서, 본사 외 경로로 사입했을 가능성이 있는 가맹점을 찾아냅니다.
      </p>

      <div className="card kicc-search-panel">
        <div className="kicc-search-row">
          <div className="filter-field">
            <label>조회 기간</label>
            <div className="flex items-center gap-[6px]">
              <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} />
              <span className="text-sub">~</span>
              <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} />
            </div>
          </div>
          <div className="filter-field">
            <label>&nbsp;</label>
            <div className="flex gap-[6px]">
              {QUICK_RANGES.map(r => (
                <Button key={r.label} type="button" variant="secondary" size="sm" onClick={() => applyQuickRange(r.days)}>{r.label}</Button>
              ))}
            </div>
          </div>
          <Button variant="primary" className="kicc-search-btn" onClick={load} disabled={loading}>
            {loading ? '조회 중...' : '조회'}
          </Button>
        </div>
      </div>

      <Card>
        <div className="font-bold mb-1">가맹점별 사입 이상 현황</div>
        <div className="text-muted text-[12px] mb-3">
          {/* 서버의 PURCHASE_RATIOS를 바꿔도 이 문구만 옛 값을 말하고 있었다. 이제 서버가 응답에 실어 보낸다. */}
          과다사입 의심 식자재 = 발주량이 예상 소진량의 {data?.thresholds?.over ?? 2}배 초과 &nbsp;|&nbsp; 발주부족 의심 = {data?.thresholds?.under ?? 0.7}배 미만
        </div>
        {!data || data.anomalies.length === 0 ? (
          <EmptyState>데이터 없음</EmptyState>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>가맹점</TH>
                <TH>과다사입 의심 식자재</TH>
                <TH>발주부족 의심 식자재</TH>
                {/* 서버가 worst_under를 새로 내려주는데 표가 안 쓰고 있었다 — 이 화면의 존재 이유가 사입 감시(발주부족)인데 정작 어떤 재료인지는 클릭해 들어가야만 보였다. */}
                <TH>과다사입 최심</TH>
                <TH>발주부족 최심</TH>
                <TH>리스크 알림 발생</TH>
                <TH></TH>
              </TR>
            </THead>
            <TBody>
              {data.anomalies.map(a => (
                <TR key={a.store_id}>
                  <TD><b>{a.store_name}</b></TD>
                  <TD>
                    {a.over_count > 0
                      ? <Badge tone="red">{a.over_count}건</Badge>
                      : <span className="text-sub">0건</span>}
                  </TD>
                  <TD>
                    {a.under_count > 0
                      ? <Badge tone="yellow">{a.under_count}건</Badge>
                      : <span className="text-sub">0건</span>}
                  </TD>
                  <TD className="text-sub text-xs">
                    {a.worst_over ? `${a.worst_over.name} (${a.worst_over.ratio}배)` : '-'}
                  </TD>
                  <TD className="text-sub text-xs">
                    {a.worst_under ? `${a.worst_under.name} (${a.worst_under.ratio}배)` : '-'}
                  </TD>
                  <TD>
                    {a.risk_alert_count > 0
                      ? <Badge tone="red">{a.risk_alert_count}회</Badge>
                      : <span className="text-sub">0회</span>}
                  </TD>
                  <TD>
                    {(a.over_count > 0 || a.under_count > 0) && (
                      <Button variant="secondary" size="sm" onClick={() => registerRisk(a)}>리스크에 등록</Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
