import { toast } from '../toast';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../AuthContext';
import { Button, Card, Badge, EmptyState, Field, Input, Table, THead, TBody, TR, TH, TD, promptDialog } from '../components/ui';
import { riskTypeLabel, RISK_SEVERITY_COLOR } from '../constants/riskTypes';

const STATUS_LABEL = {
  OPEN: '미확인', ACKNOWLEDGED: '확인완료', IN_PROGRESS: '조치중', RESOLVED: '조치완료', DISMISSED: '제외처리',
};

const SETTING_FIELDS = [
  { key: 'salesDropRatio', label: '매출 감소 기준', suffix: '배 (예: 0.8 = 최근 7일 판매가 이전 7일의 80% 미만)', step: 0.05 },
  { key: 'orderSpikeRatio', label: '발주 증가 기준', suffix: '배 (예: 1.2 = 최근 7일 발주금액이 이전 7일의 120% 초과)', step: 0.05 },
  { key: 'overPurchaseRatio', label: '과다 사입 기준', suffix: '배 (예상 소진량 대비 발주량)', step: 0.1 },
  { key: 'highWasteThreshold', label: '폐기 과다 기준', suffix: '(재료 단위, 7일 합계)', step: 100 },
  { key: 'paymentOverdueDays', label: '결제 미완료 기준', suffix: '일 (확정 후 경과일)', step: 1 },
];

function RiskSettingsPanel() {
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = () => api.getRiskSettings().then(setSettings).catch(() => {});
  useEffect(() => { load(); }, []);

  const save = async () => {
    setSaving(true);
    try {
      const next = await api.updateRiskSettings(settings);
      setSettings(next);
      toast('저장되었습니다', 'success');
    } catch (e) {
      toast(e.message || '저장에 실패했습니다', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!settings) return null;

  return (
    <Card className="mb-5">
      <div className="font-bold mb-1">리스크 감지 기준 설정</div>
      <div className="text-muted text-[12px] mb-4">
        아래 기준값을 넘으면 자동으로 리스크 알림이 생성됩니다. 가맹점 특성에 맞게 본사에서 직접 조정하세요.
      </div>
      <div className="grid gap-4 mb-4 [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
        {SETTING_FIELDS.map(f => (
          <Field label={f.label} key={f.key}>
            <Input type="number" step={f.step} value={settings[f.key]}
              onChange={e => setSettings(s => ({ ...s, [f.key]: Number(e.target.value) }))} />
            <div className="text-muted text-2xs mt-1">{f.suffix}</div>
          </Field>
        ))}
      </div>
      <Button variant="primary" onClick={save} disabled={saving}>{saving ? '저장 중...' : '저장'}</Button>
    </Card>
  );
}

export default function Risks() {
  const { user } = useAuth();
  const canEditSettings = ['SUPER_ADMIN', 'HQ_ADMIN'].includes(user?.role);
  const [risks, setRisks] = useState([]);
  const [filter, setFilter] = useState('OPEN');
  const [showSettings, setShowSettings] = useState(false);

  const load = () => api.getRisks({ status: filter }).then(setRisks).catch(() => {});
  useEffect(() => { load(); }, [filter]);

  const updateStatus = async (id, status) => {
    const memo = ['RESOLVED', 'DISMISSED'].includes(status)
      ? await promptDialog({ title: '메모 (선택)' })
      : null;
    try {
      await api.updateRiskStatus(id, status, memo || undefined);
      load();
    } catch (e) {
      toast(e.message || '처리에 실패했습니다', 'error');
    }
  };

  return (
    <div>
      <div className="top-bar">
        <h2>리스크 알림</h2>
        {canEditSettings && (
          <Button variant="secondary" onClick={() => setShowSettings(s => !s)}>
            {showSettings ? '기준 설정 닫기' : '기준 설정'}
          </Button>
        )}
      </div>

      {showSettings && canEditSettings && <RiskSettingsPanel />}

      <div className="flex gap-2 mb-5 flex-wrap">
        {Object.entries(STATUS_LABEL).map(([k, v]) => (
          <Button key={k} variant={filter === k ? 'primary' : 'secondary'} onClick={() => setFilter(k)}>{v}</Button>
        ))}
        <Button variant={!filter ? 'primary' : 'secondary'} onClick={() => setFilter('')}>전체</Button>
      </div>

      <Card>
        {risks.length === 0 ? <EmptyState>알림 없음</EmptyState> : (
          <Table>
            <THead><TR><TH>심각도</TH><TH>유형</TH><TH>가맹점</TH><TH>내용</TH><TH>재발</TH><TH>상태</TH><TH>발생일</TH><TH>조치</TH></TR></THead>
            <TBody>
              {risks.map(r => (
                <TR key={r.id}>
                  <TD><span className="font-bold text-xs" style={{ color: RISK_SEVERITY_COLOR[r.severity] }}>{r.severity}</span></TD>
                  <TD><Badge tone="yellow">{riskTypeLabel(r.type)}</Badge></TD>
                  <TD>{r.store_name || '-'}</TD>
                  <TD className="text-xs max-w-[240px]">{r.description}</TD>
                  <TD>
                    {r.occurrence_count > 1
                      ? <Badge tone="red">{r.occurrence_count}회</Badge>
                      : <span className="text-muted text-[12px]">1회</span>}
                  </TD>
                  <TD><Badge tone="green">{STATUS_LABEL[r.status]}</Badge></TD>
                  <TD className="text-[12px] text-[#94a3b8]">
                    {new Date(r.created_at).toLocaleDateString('ko-KR')}
                    {r.last_occurred_at && r.occurrence_count > 1 && (
                      <div>최근: {new Date(r.last_occurred_at).toLocaleDateString('ko-KR')}</div>
                    )}
                  </TD>
                  <TD>
                    <div className="flex gap-1">
                      {r.status === 'OPEN' && <Button variant="secondary" size="sm" onClick={() => updateStatus(r.id, 'ACKNOWLEDGED')}>확인</Button>}
                      {r.status === 'ACKNOWLEDGED' && <Button variant="secondary" size="sm" onClick={() => updateStatus(r.id, 'IN_PROGRESS')}>조치중</Button>}
                      {r.status === 'IN_PROGRESS' && <Button variant="primary" size="sm" onClick={() => updateStatus(r.id, 'RESOLVED')}>완료</Button>}
                      {!['RESOLVED', 'DISMISSED'].includes(r.status) && <Button variant="danger" size="sm" onClick={() => updateStatus(r.id, 'DISMISSED')}>제외</Button>}
                    </div>
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
