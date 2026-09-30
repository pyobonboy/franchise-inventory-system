import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Button, Card, Badge, EmptyState, LoadingState, Table, THead, TBody, TR, TH, TD } from '../components/ui';

// 가맹점마다 담당 본사 직원이 지정되는데, 브랜드 전체 화면(발주관리/리스크/가맹점조회)만 있어서
// "내가 담당하는 가맹점 중 처리할 게 있는 것"만 빠르게 훑어볼 방법이 없었던 문제를 해소
export default function MyTasks() {
  const [data, setData] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.getMyTasks().then(setData).catch(() => {});
  }, []);

  if (!data) return <LoadingState>불러오는 중...</LoadingState>;

  const stores = data.stores || [];
  const totalTasks = stores.reduce((s, st) => s + st.pendingReview + st.needsAttention + st.openRisks + (st.receiptIssues || 0), 0);

  return (
    <div>
      <h2>내 업무</h2>
      <div className="text-sub text-xs mb-4">
        담당 가맹점에서 처리가 필요한 항목만 모아서 보여줍니다.
      </div>

      {/* 빈 상태도 Card로 감싼다 — 다른 화면(Notices/Users/Risks/Products/Settlement)이 전부
          Card+EmptyState 패턴이라, 여기만 배경 위에 텍스트가 떠 있으면 페이지가 미완성처럼 보인다 */}
      {stores.length === 0 ? (
        <Card><EmptyState>담당으로 지정된 가맹점이 없습니다</EmptyState></Card>
      ) : totalTasks === 0 ? (
        <Card><EmptyState>처리할 업무가 없습니다 🎉</EmptyState></Card>
      ) : (
        <Card>
          <Table>
            <THead>
              <TR><TH>가맹점</TH><TH>검토대기 발주</TH><TH>미확인 변경알림</TH><TH>검수 이상신고</TH><TH>미처리 리스크</TH><TH></TH></TR>
            </THead>
            <TBody>
              {stores.filter(s => s.pendingReview + s.needsAttention + s.openRisks + (s.receiptIssues || 0) > 0).map(s => (
                <TR key={s.store_id}>
                  <TD><b>{s.store_name}</b></TD>
                  <TD>{s.pendingReview > 0 ? <Badge tone="yellow">{s.pendingReview}건</Badge> : '-'}</TD>
                  <TD>{s.needsAttention > 0 ? <Badge tone="red">{s.needsAttention}건</Badge> : '-'}</TD>
                  <TD>{s.receiptIssues > 0 ? <Badge tone="red">{s.receiptIssues}건</Badge> : '-'}</TD>
                  <TD>{s.openRisks > 0 ? <Badge tone="red">{s.openRisks}건</Badge> : '-'}</TD>
                  <TD>
                    <Button variant="secondary" size="sm" onClick={() => navigate('/orders')}>발주관리로 이동</Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
