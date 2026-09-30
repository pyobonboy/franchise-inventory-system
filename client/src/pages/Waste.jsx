import { toast } from '../toast';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../AuthContext';
import { useStore } from '../StoreContext';
import { exportCsv } from '../exportCsv';
import {
  Button, Badge, Card, EmptyState, Field, FieldRow, Input, Select,
  Modal, confirmDialog, Table, THead, TBody, TR, TH, TD,
} from '../components/ui';

const REASONS = ['유통기한 경과', '품질 저하', '보관 문제', '조리 실수', '오배송 또는 파손', '기타'];

export default function Waste() {
  const { user, isHQ } = useAuth();
  const storeCtx = useStore();
  const currentStore = storeCtx?.currentStore || (user?.store_id ? { id: user.store_id } : null);
  const [logs, setLogs] = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [modal, setModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    waste_date: new Date().toISOString().slice(0, 10),
    ingredient_id: '', ingredient_name: '', quantity: '', unit: 'g',
    reason: REASONS[0], memo: '',
  });

  const load = () => {
    const params = currentStore ? { store_id: currentStore.id } : {};
    api.getWaste(params).then(setLogs).catch(() => {});
  };

  useEffect(() => {
    load();
    const sid = currentStore?.id;
    if (sid) api.getIngredients(sid).then(setIngredients).catch(() => {});
  }, [currentStore?.id]);

  const handleIngredientSelect = (id) => {
    const ing = ingredients.find(i => i.id === Number(id));
    if (ing) setForm(f => ({ ...f, ingredient_id: ing.id, ingredient_name: ing.name, unit: ing.unit }));
  };

  const handleSave = async () => {
    if (!form.ingredient_id) { toast('식자재를 선택해주세요', 'error'); return; }
    if (!form.quantity) { toast('수량을 입력해주세요', 'error'); return; }
    if (saving) return; // 연속 클릭 시 폐기 기록과 재고 차감이 중복으로 들어가는 것을 방지
    setSaving(true);
    try {
      await api.createWaste({ ...form, quantity: Number(form.quantity) });
      setModal(false);
      setForm({ waste_date: new Date().toISOString().slice(0, 10), ingredient_id: '', ingredient_name: '', quantity: '', unit: 'g', reason: REASONS[0], memo: '' });
      load();
    } catch (e) {
      toast(e.message || '폐기 등록에 실패했습니다', 'error');
    } finally {
      setSaving(false);
    }
  };

  const openModal = () => {
    const first = ingredients[0];
    if (first) setForm(f => ({ ...f, ingredient_id: first.id, ingredient_name: first.name, unit: first.unit }));
    setModal(true);
  };

  const handleDelete = async (id) => {
    const ok = await confirmDialog({ title: '삭제하시겠습니까?' });
    if (!ok) return;
    try { await api.deleteWaste(id); load(); }
    catch (e) { toast(e.message || '삭제에 실패했습니다', 'error'); }
  };

  const exportLogs = () => {
    const rows = [
      ['폐기일', ...(isHQ ? ['가맹점'] : []), '식자재', '수량', '단위', '사유', '메모'],
      ...logs.map(l => [
        l.waste_date, ...(isHQ ? [l.store_name] : []),
        l.ingredient_name, l.quantity, l.unit, l.reason, l.memo || '',
      ]),
    ];
    exportCsv(`폐기내역_${new Date().toISOString().slice(0, 10)}.csv`, rows);
  };

  return (
    <div>
      <div className="top-bar">
        <h2>폐기 관리{currentStore?.name ? ` — ${currentStore.name}` : ''}</h2>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={exportLogs} disabled={logs.length === 0}>⬇ 엑셀 다운로드</Button>
          {!isHQ && <Button variant="primary" onClick={openModal}>+ 폐기 입력</Button>}
        </div>
      </div>

      <Card>
        {logs.length === 0 ? <EmptyState>폐기 내역 없음</EmptyState> : (
          <Table>
            <THead>
              <TR>
                <TH>폐기일</TH>
                {isHQ && <TH>가맹점</TH>}
                <TH>식자재</TH>
                <TH>수량</TH>
                <TH>사유</TH>
                <TH>메모</TH>
                {!isHQ && <TH></TH>}
              </TR>
            </THead>
            <TBody>
              {logs.map(l => (
                <TR key={l.id}>
                  <TD>{l.waste_date}</TD>
                  {isHQ && <TD>{l.store_name}</TD>}
                  <TD><b>{l.ingredient_name}</b></TD>
                  <TD>{l.quantity} {l.unit}</TD>
                  <TD><Badge tone="yellow">{l.reason}</Badge></TD>
                  <TD className="text-muted text-xs">{l.memo || '-'}</TD>
                  {!isHQ && (
                    <TD>
                      <Button variant="danger" size="sm" onClick={() => handleDelete(l.id)}>삭제</Button>
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Modal
        open={modal}
        onOpenChange={setModal}
        title="폐기 입력"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setModal(false)}>취소</Button>
            <Button variant="primary" onClick={handleSave} disabled={saving}>{saving ? '저장 중...' : '저장'}</Button>
          </>
        )}
      >
        <Field label="폐기일" className="mb-3">
          <Input type="date" value={form.waste_date}
            onChange={e => setForm(f => ({ ...f, waste_date: e.target.value }))} />
        </Field>

        <Field label="식자재" className="mb-3">
          {ingredients.length === 0
            ? <EmptyState className="p-3">등록된 재고가 없습니다 (납품 완료 후 자동 등록)</EmptyState>
            : <Select
                value={String(form.ingredient_id)}
                onValueChange={handleIngredientSelect}
                options={ingredients.map(i => ({ value: String(i.id), label: `${i.name} (현재 재고: ${i.stock}${i.unit})` }))}
              />
          }
        </Field>

        <FieldRow>
          <Field label="폐기 수량">
            <Input type="number" value={form.quantity}
              onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))}
              placeholder="0" autoFocus />
          </Field>
          <Field label="단위" className="max-w-[80px]">
            <Input value={form.unit} readOnly />
          </Field>
        </FieldRow>

        <Field label="폐기 사유" className="mb-3">
          <Select
            value={form.reason}
            onValueChange={r => setForm(f => ({ ...f, reason: r }))}
            options={REASONS.map(r => ({ value: r, label: r }))}
          />
        </Field>

        <Field label="메모">
          <Input value={form.memo}
            onChange={e => setForm(f => ({ ...f, memo: e.target.value }))}
            placeholder="메모 (선택)" />
        </Field>
      </Modal>
    </div>
  );
}
