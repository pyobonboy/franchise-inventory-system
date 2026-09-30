import { toast } from '../toast';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../AuthContext';
import { useStore } from '../StoreContext';
import {
  Button, Badge, Card, EmptyState, Field, Input, Select,
  Modal, Table, THead, TBody, TR, TH, TD,
} from '../components/ui';

const LOGISTICS_ROLES = ['SUPER_ADMIN', 'HQ_ADMIN', 'HQ_LOGISTICS'];
const STORE_ROLES = ['STORE_OWNER', 'STORE_STAFF'];

export default function StockAdjustment() {
  const { user } = useAuth();
  // 서버(A7)가 회계 등 조회 전용 역할에는 403을 주므로, 화면도 그 역할에서는 버튼/모달을 숨겨 일치시킨다.
  const canEdit = LOGISTICS_ROLES.includes(user?.role) || STORE_ROLES.includes(user?.role);
  const storeCtx = useStore();
  const currentStore = storeCtx?.currentStore || (user?.store_id ? { id: user.store_id } : null);
  const [ingredients, setIngredients] = useState([]);
  const [history, setHistory] = useState([]);
  const [modal, setModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ ingredient_id: '', counted_stock: '', memo: '' });

  const load = () => {
    if (!currentStore) return;
    api.getIngredients(currentStore.id).then(setIngredients).catch(() => {});
    api.getStockAdjustments(currentStore.id).then(setHistory).catch(() => {});
  };

  useEffect(() => { load(); }, [currentStore?.id]);

  const selected = ingredients.find(i => i.id === Number(form.ingredient_id));
  const diff = selected && form.counted_stock !== '' ? Number(form.counted_stock) - selected.stock : null;

  const openModal = () => {
    const first = ingredients[0];
    setForm({ ingredient_id: first?.id || '', counted_stock: '', memo: '' });
    setModal(true);
  };

  const save = async () => {
    if (!form.ingredient_id) { toast('재료를 선택해주세요', 'error'); return; }
    if (form.counted_stock === '') { toast('실사 수량을 입력해주세요', 'error'); return; }
    if (saving) return;
    setSaving(true);
    try {
      const result = await api.createStockAdjustment({
        ingredient_id: form.ingredient_id, counted_stock: Number(form.counted_stock), memo: form.memo,
        store_id: currentStore?.id,
      });
      toast(result.diff === 0 ? '재고가 일치합니다' : `재고가 ${result.diff > 0 ? '+' : ''}${result.diff} 조정되었습니다`, 'success');
      setModal(false);
      load();
    } catch (e) {
      toast(e.message || '저장에 실패했습니다', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!currentStore) return <EmptyState>가맹점을 선택해주세요</EmptyState>;

  return (
    <div>
      <div className="top-bar">
        <h2>실사 재고 조정</h2>
        {canEdit && (
          <Button variant="primary" onClick={openModal} disabled={ingredients.length === 0}>+ 실사 등록</Button>
        )}
      </div>

      <Card>
        {history.length === 0 ? <EmptyState>실사 조정 내역이 없습니다</EmptyState> : (
          <Table>
            <THead><TR><TH>재료</TH><TH>조정 전</TH><TH>실사 수량</TH><TH>차이</TH><TH>메모</TH><TH>처리자</TH><TH>일시</TH></TR></THead>
            <TBody>
              {history.map(h => (
                <TR key={h.id}>
                  <TD><b>{h.ingredient_name}</b></TD>
                  <TD>{h.before_stock} {h.unit}</TD>
                  <TD>{h.counted_stock} {h.unit}</TD>
                  <TD>
                    <Badge tone={h.diff > 0 ? 'green' : h.diff < 0 ? 'red' : 'yellow'}>
                      {h.diff > 0 ? '+' : ''}{h.diff} {h.unit}
                    </Badge>
                  </TD>
                  <TD className="text-muted text-xs">{h.memo || '-'}</TD>
                  <TD className="text-muted text-xs">{h.created_by_name || '-'}</TD>
                  <TD className="text-muted text-[12px]">{new Date(h.created_at).toLocaleString('ko-KR')}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {canEdit && (
      <Modal
        open={modal}
        onOpenChange={setModal}
        title="실사 재고 조정"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setModal(false)}>취소</Button>
            <Button variant="primary" onClick={save} disabled={saving}>{saving ? '저장 중...' : '저장'}</Button>
          </>
        )}
      >
        <Field label="재료" className="mb-3">
          <Select
            value={String(form.ingredient_id)}
            onValueChange={v => setForm(f => ({ ...f, ingredient_id: v }))}
            options={ingredients.map(i => ({ value: String(i.id), label: `${i.name} (시스템 재고: ${i.stock}${i.unit})` }))}
          />
        </Field>

        <Field label={`실사로 직접 센 수량${selected ? ` (${selected.unit})` : ''}`} className="mb-3">
          <Input type="number" value={form.counted_stock}
            onChange={e => setForm(f => ({ ...f, counted_stock: e.target.value }))}
            placeholder="0" autoFocus />
          {diff !== null && diff !== 0 && (
            <div className="text-muted text-[12.5px] mt-1" style={{ color: diff > 0 ? '#16a34a' : '#dc2626', fontWeight: 600 }}>
              시스템 재고 대비 {diff > 0 ? '+' : ''}{diff}{selected.unit} 조정됩니다
            </div>
          )}
        </Field>

        <Field label="메모">
          <Input value={form.memo} onChange={e => setForm(f => ({ ...f, memo: e.target.value }))} placeholder="메모 (선택)" />
        </Field>
      </Modal>
      )}
    </div>
  );
}
