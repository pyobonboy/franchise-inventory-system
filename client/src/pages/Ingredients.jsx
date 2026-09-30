import { toast } from '../toast';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../StoreContext';
import { useAuth } from '../AuthContext';
import {
  Button, Card, EmptyState, Badge, Modal, Field, FieldRow, Input, Select,
  Table, THead, TBody, TR, TH, TD, ProgressBar, confirmDialog,
} from '../components/ui';

const LOGISTICS_ROLES = ['SUPER_ADMIN', 'HQ_ADMIN', 'HQ_LOGISTICS'];

const UNIT_OPTIONS = ['g', 'kg', 'ml', 'L', '개', '팩', '봉'].map(u => ({ value: u, label: u }));

function IngredientModal({ item, onClose, onSave }) {
  const [form, setForm] = useState(item || { name: '', unit: 'g', stock: '', threshold: '' });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={item ? '재료 수정' : '재료 추가'}
      footer={
        <>
          <Button onClick={onClose}>취소</Button>
          <Button variant="primary" onClick={() => onSave(form)}>저장</Button>
        </>
      }
    >
      <FieldRow>
        <Field label="재료명">
          <Input value={form.name} onChange={e => set('name', e.target.value)} placeholder="예: 밀가루" />
        </Field>
        <Field label="단위" className="max-w-[80px]">
          <Select value={form.unit} onValueChange={v => set('unit', v)} options={UNIT_OPTIONS} />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label="현재 재고">
          <Input type="number" value={form.stock} onChange={e => set('stock', e.target.value)} placeholder="0" />
        </Field>
        <Field label="알림 기준량 (이하 시 알림)">
          <Input type="number" value={form.threshold} onChange={e => set('threshold', e.target.value)} placeholder="0" />
        </Field>
      </FieldRow>
    </Modal>
  );
}

function RestockModal({ item, onClose, onSave }) {
  const [amount, setAmount] = useState('');
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${item.name} 입고`}
      footer={
        <>
          <Button onClick={onClose}>취소</Button>
          <Button variant="primary" onClick={() => onSave(Number(amount))}>입고</Button>
        </>
      }
    >
      <Field label={`입고량 (${item.unit})`}>
        <Input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" autoFocus />
      </Field>
    </Modal>
  );
}

export default function Ingredients() {
  const { user } = useAuth();
  const canEdit = LOGISTICS_ROLES.includes(user?.role);
  const { currentStore } = useStore();
  const [list, setList] = useState([]);
  const [modal, setModal] = useState(null);

  const load = () => {
    if (!currentStore) return;
    api.getIngredients(currentStore.id).then(setList).catch(() => {});
  };
  useEffect(() => { load(); }, [currentStore?.id]);

  const handleSave = async (form) => {
    if (!form.name?.trim()) { toast('재료명을 입력해주세요', 'error'); return; }
    const data = { ...form, stock: Number(form.stock), threshold: Number(form.threshold), store_id: currentStore.id };
    try {
      if (modal?.edit) await api.updateIngredient(modal.edit.id, data);
      else await api.createIngredient(data);
      setModal(null);
      load();
    } catch (e) {
      toast(e.message || '저장에 실패했습니다', 'error');
    }
  };

  const handleRestock = async (amount) => {
    try {
      await api.restock(modal.restock.id, amount);
      setModal(null);
      load();
    } catch (e) {
      toast(e.message || '입고 처리에 실패했습니다', 'error');
    }
  };

  const handleDelete = async (id) => {
    if (!(await confirmDialog({ title: '삭제하시겠습니까?' }))) return;
    try {
      await api.deleteIngredient(id);
      load();
    } catch (e) {
      toast(e.message || '삭제에 실패했습니다', 'error');
    }
  };

  if (!currentStore) return <EmptyState>가맹점을 선택해주세요</EmptyState>;

  return (
    <div>
      <div className="top-bar">
        <h2>재료 관리 — {currentStore.name}</h2>
        {canEdit && <Button variant="primary" onClick={() => setModal('add')}>+ 재료 추가</Button>}
      </div>

      <Card>
        {list.length === 0 ? (
          <EmptyState>재료를 추가해주세요</EmptyState>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>재료명</TH>
                <TH>단위</TH>
                <TH>현재 재고</TH>
                <TH>알림 기준</TH>
                <TH>핵심재료</TH>
                <TH>상태</TH>
                {canEdit && <TH>관리</TH>}
              </TR>
            </THead>
            <TBody>
              {list.map(i => {
                const low = i.stock <= i.threshold;
                const pct = i.threshold > 0 ? Math.min((i.stock / (i.threshold * 2)) * 100, 100) : 50;
                return (
                  <TR key={i.id}>
                    <TD><b>{i.name}</b></TD>
                    <TD>{i.unit}</TD>
                    <TD>
                      {i.stock}
                      <ProgressBar pct={pct} color={low ? '#dc2626' : '#16a34a'} />
                    </TD>
                    <TD>{i.threshold} {i.unit}</TD>
                    <TD>
                      {canEdit ? (
                        <Button
                          variant={i.is_key ? 'primary' : 'secondary'}
                          size="sm"
                          onClick={async () => {
                            try {
                              await api.updateIngredient(i.id, { ...i, is_key: !i.is_key });
                              load();
                            } catch (e) {
                              toast(e.message || '수정에 실패했습니다', 'error');
                            }
                          }}
                        >
                          {i.is_key ? '핵심' : '일반'}
                        </Button>
                      ) : (i.is_key ? '핵심' : '일반')}
                    </TD>
                    <TD><Badge tone={low ? 'red' : 'green'}>{low ? '부족' : '정상'}</Badge></TD>
                    {canEdit && (
                      <TD className="flex gap-1.5">
                        <Button size="sm" onClick={() => setModal({ restock: i })}>입고</Button>
                        <Button size="sm" onClick={() => setModal({ edit: i })}>수정</Button>
                        <Button variant="danger" size="sm" onClick={() => handleDelete(i.id)}>삭제</Button>
                      </TD>
                    )}
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>

      {(modal === 'add' || modal?.edit) && (
        <IngredientModal
          item={modal?.edit}
          onClose={() => setModal(null)}
          onSave={handleSave}
        />
      )}
      {modal?.restock && (
        <RestockModal
          item={modal.restock}
          onClose={() => setModal(null)}
          onSave={handleRestock}
        />
      )}
    </div>
  );
}
