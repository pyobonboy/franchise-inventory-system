import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { exportCsv } from '../exportCsv';
import { Button, Card, Badge, EmptyState, Table, THead, TBody, TR, TH, TD } from '../components/ui';

const ENTITY_LABEL = { PRODUCT: '상품', INGREDIENT: '재료', MENU: '메뉴', STORE: '가맹점', USER: '사용자', PAYMENT: '결제' };
const ACTION_LABEL = { CREATE: '생성', UPDATE: '수정', DELETE: '삭제', PAID: '결제완료', REFUND_FULL: '전액환불', REFUND_PARTIAL: '부분환불', REFUND_SYNC: '환불 동기화(토스)' };

function diffSummary(before, after) {
  if (!before && after) return JSON.stringify(after);
  if (before && !after) return '-';
  try {
    const b = JSON.parse(before);
    const a = JSON.parse(after);
    const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
    const parts = [];
    for (const k of keys) {
      if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) parts.push(`${k}: ${b[k]} → ${a[k]}`);
    }
    return parts.join(', ') || '-';
  } catch {
    return '-';
  }
}

export default function AuditLog() {
  const [logs, setLogs] = useState([]);
  const [entityType, setEntityType] = useState('');

  // entityType을 빠르게 바꾸면 이전 요청이 나중에 도착해 최신 결과를 덮어쓸 수 있다 —
  // 세대 카운터로 마지막에 시작한 요청의 응답만 반영한다.
  const loadSeqRef = useRef(0);
  const load = () => {
    const seq = ++loadSeqRef.current;
    api.getAuditLog({ entity_type: entityType || undefined })
      .then(result => { if (seq === loadSeqRef.current) setLogs(result); })
      .catch(() => {});
  };
  useEffect(() => { load(); }, [entityType]);

  const exportLogs = () => {
    const rows = [
      ['일시', '처리자', '대상', 'ID', '작업', '변경 내용'],
      ...logs.map(l => [
        new Date(l.created_at).toLocaleString('ko-KR'), l.user_name || '시스템',
        ENTITY_LABEL[l.entity_type] || l.entity_type, l.entity_id,
        ACTION_LABEL[l.action] || l.action, diffSummary(l.before_value, l.after_value),
      ]),
    ];
    exportCsv(`감사로그_${new Date().toISOString().slice(0, 10)}.csv`, rows);
  };

  return (
    <div>
      <div className="top-bar">
        <h2 className="mb-0">변경 이력 (감사 로그)</h2>
        <Button variant="secondary" onClick={exportLogs} disabled={logs.length === 0}>⬇ 엑셀 다운로드</Button>
      </div>
      <div className="flex gap-2 mb-5 flex-wrap">
        <Button variant={!entityType ? 'primary' : 'secondary'} onClick={() => setEntityType('')}>전체</Button>
        {Object.entries(ENTITY_LABEL).map(([k, v]) => (
          <Button key={k} variant={entityType === k ? 'primary' : 'secondary'} onClick={() => setEntityType(k)}>{v}</Button>
        ))}
      </div>
      <Card>
        {logs.length === 0 ? <EmptyState>변경 이력 없음</EmptyState> : (
          <Table>
            <THead><TR><TH>일시</TH><TH>처리자</TH><TH>대상</TH><TH>작업</TH><TH>변경 내용</TH></TR></THead>
            <TBody>
              {logs.map(l => (
                <TR key={l.id}>
                  <TD className="text-muted text-[12px]">{new Date(l.created_at).toLocaleString('ko-KR')}</TD>
                  <TD>{l.user_name || '시스템'}</TD>
                  <TD><Badge tone="yellow">{ENTITY_LABEL[l.entity_type] || l.entity_type}</Badge> #{l.entity_id}</TD>
                  <TD>{ACTION_LABEL[l.action] || l.action}</TD>
                  <TD className="text-xs">{diffSummary(l.before_value, l.after_value)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
