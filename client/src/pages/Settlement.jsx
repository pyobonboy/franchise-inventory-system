import { useEffect, useState } from 'react';
import { api } from '../api';
import { toast } from '../toast';
import { exportCsv } from '../exportCsv';
import Loading from '../components/Loading';
import { Button, Card, EmptyState, Input, Table, THead, TBody, TR, TH, TD } from '../components/ui';

const QUICK_RANGES = [
  { label: '1주일', days: 7 },
  { label: '1개월', days: 30 },
  { label: '3개월', days: 90 },
];

const won = (v) => `${Math.round(v || 0).toLocaleString()}원`;

export default function Settlement() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [fromDate, setFromDate] = useState(() => new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]);
  const [toDate, setToDate] = useState(() => new Date().toISOString().split('T')[0]);

  const load = async () => {
    setLoading(true);
    try {
      const result = await api.getSettlement({ from: fromDate, to: new Date(toDate + 'T23:59:59').toISOString() });
      setData(result);
    } catch (e) {
      // 조회 실패 시 catch가 없어 서버 400/403이 unhandled rejection으로 사라지고 화면은 '데이터 없음'만 보여줬다 — 사용자는 기간을 잘못 넣은 건지 권한이 없는 건지 알 수 없었다.
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

  const exportSettlement = () => {
    if (!data) return;
    const rows = [
      [`조회기간: ${fromDate} ~ ${toDate}`],
      [],
      ['가맹점', '결제건수', '결제금액', '환불금액', '정산금액(순매출)'],
      ...data.settlement.map(s => [s.store_name, s.order_count, s.gross, s.refunded, s.net]),
      [],
      ['합계', data.totals.order_count, data.totals.gross, data.totals.refunded, data.totals.net],
      [],
      ['상품명', '판매수량', '결제금액', '환불금액', '순매출'],
      ...(data.byProduct || []).map(p => [p.product_name, p.qty, p.gross, p.refunded, p.net]),
    ];
    exportCsv(`정산리포트_${fromDate}_${toDate}.csv`, rows);
  };

  return (
    <div>
      <div className="top-bar">
        <h2 className="mb-0">정산 리포트</h2>
        <Button variant="secondary" onClick={exportSettlement} disabled={!data}>⬇ 엑셀 다운로드</Button>
      </div>

      {/* 레거시 .kicc-search-panel이 자체 padding/border-left 강조바를 갖고 있는데, Card 프리미티브를 쓰면
          Tailwind utilities 레이어가 항상 legacy.css의 components 레이어를 이겨서 그 값이 깨진다.
          StoreRankings.jsx / PurchaseAnomalies.jsx와 동일하게 raw div + .card 레거시 클래스로 되돌린다. */}
      <div className="card kicc-search-panel">
        <div className="kicc-search-row">
          <div className="filter-field">
            <label>조회 기간 (결제일 기준)</label>
            <div className="flex items-center gap-1.5">
              <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} />
              <span className="text-sub">~</span>
              <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} />
            </div>
          </div>
          <div className="filter-field">
            <label>&nbsp;</label>
            <div className="flex gap-1.5">
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

      {loading ? (
        <Loading />
      ) : !data || data.settlement.length === 0 ? (
        <Card><EmptyState>정산 데이터 없음</EmptyState></Card>
      ) : (
        <>
          <Card className="mb-4">
            <Table>
              <THead>
                <TR><TH>가맹점</TH><TH>결제건수</TH><TH>결제금액</TH><TH>환불금액</TH><TH>정산금액</TH></TR>
              </THead>
              <TBody>
                {data.settlement.map(s => (
                  <TR key={s.store_id}>
                    <TD><b>{s.store_name}</b></TD>
                    <TD className="text-sub">{s.order_count.toLocaleString()}건</TD>
                    <TD>{won(s.gross)}</TD>
                    <TD style={{ color: s.refunded > 0 ? '#dc2626' : undefined }}>{s.refunded > 0 ? `-${won(s.refunded)}` : '-'}</TD>
                    <TD><b className="text-brand">{won(s.net)}</b></TD>
                  </TR>
                ))}
              </TBody>
              <tfoot>
                <TR className="font-bold border-t-2 border-line">
                  <TD>합계</TD>
                  <TD>{data.totals.order_count.toLocaleString()}건</TD>
                  <TD>{won(data.totals.gross)}</TD>
                  <TD style={{ color: data.totals.refunded > 0 ? '#dc2626' : undefined }}>
                    {data.totals.refunded > 0 ? `-${won(data.totals.refunded)}` : '-'}
                  </TD>
                  <TD className="text-brand">
                    {won(data.totals.net)}
                    {data.previousPeriod && (() => {
                      const prevNet = data.previousPeriod.totals.net;
                      const diff = data.totals.net - prevNet;
                      const pct = prevNet > 0 ? Math.round((diff / prevNet) * 1000) / 10 : null;
                      const up = diff >= 0;
                      return (
                        <span
                          title={`직전 동일 기간 (${data.previousPeriod.from.slice(0, 10)} ~ ${data.previousPeriod.to.slice(0, 10)}) 순매출 ${won(prevNet)} 대비`}
                          className="inline-block ml-2 text-[12px] font-bold"
                          style={{ color: up ? '#16a34a' : '#dc2626' }}
                        >
                          {up ? '▲' : '▼'} {pct !== null ? `${up ? '+' : ''}${pct}%` : won(Math.abs(diff))}
                        </span>
                      );
                    })()}
                  </TD>
                </TR>
              </tfoot>
            </Table>
          </Card>

          {data.byProduct?.length > 0 && (
            <Card>
              <div className="font-bold mb-3">상품별 매출 분해</div>
              <Table>
                <THead>
                  <TR><TH>상품명</TH><TH>판매수량</TH><TH>매출(결제금액)</TH><TH>환불금액</TH><TH>순매출</TH><TH>비중</TH></TR>
                </THead>
                <TBody>
                  {data.byProduct.map(p => (
                    <TR key={p.product_name}>
                      <TD><b>{p.product_name}</b></TD>
                      <TD className="text-sub">{p.qty.toLocaleString()}</TD>
                      <TD>{won(p.gross)}</TD>
                      <TD style={{ color: p.refunded > 0 ? '#dc2626' : undefined }}>{p.refunded > 0 ? `-${won(p.refunded)}` : '-'}</TD>
                      <TD><b className="text-brand">{won(p.net)}</b></TD>
                      <TD className="text-sub">
                        {data.totals.net > 0 ? `${Math.round((p.net / data.totals.net) * 1000) / 10}%` : '-'}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
