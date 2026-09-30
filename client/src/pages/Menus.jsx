import { toast } from '../toast';
import { useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import { useStore } from '../StoreContext';
import { useAuth } from '../AuthContext';
import {
  Button, Card, EmptyState, Badge, Modal, Field, FieldRow, Input, Select,
  Table, THead, TBody, TR, TH, TD, confirmDialog,
} from '../components/ui';

const LOGISTICS_ROLES = ['SUPER_ADMIN', 'HQ_ADMIN', 'HQ_LOGISTICS'];

function MenuModal({ item, onClose, onSave }) {
  const [form, setForm] = useState(item ? { name: item.name, toss_menu_id: item.toss_menu_id || '' } : { name: '', toss_menu_id: '' });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={item ? '메뉴 수정' : '메뉴 추가'}
      footer={
        <>
          <Button onClick={onClose}>취소</Button>
          <Button variant="primary" onClick={() => onSave(form)}>저장</Button>
        </>
      }
    >
      <Field label="메뉴명 (토스플레이스 메뉴명과 동일하게)" className="mb-3">
        <Input value={form.name} onChange={e => set('name', e.target.value)} placeholder="예: 아메리카노" />
      </Field>
      <Field label="토스플레이스 메뉴 ID (선택)">
        <Input value={form.toss_menu_id} onChange={e => set('toss_menu_id', e.target.value)} placeholder="menu_xxx" />
      </Field>
    </Modal>
  );
}

function RecipeModal({ menu, ingredients, onClose, onRefresh }) {
  const [form, setForm] = useState({ ingredient_id: '', amount: '' });

  // Radix Select는 value="" 를 허용하지 않으므로 '선택' 상태를 'NONE' sentinel로 표현하고
  // 핸들러에서 빈 문자열로 되돌린다 (원본 <option value="">선택</option> 과 동일한 동작).
  const INGREDIENT_OPTIONS = [
    { value: 'NONE', label: '선택' },
    ...ingredients.map(i => ({ value: String(i.id), label: `${i.name} (${i.unit})` })),
  ];

  const addRecipe = async () => {
    if (!form.ingredient_id || !form.amount) return;
    try {
      await api.addRecipe(menu.id, { ingredient_id: Number(form.ingredient_id), amount: Number(form.amount) });
      setForm({ ingredient_id: '', amount: '' });
      onRefresh();
    } catch (e) {
      toast(e.message || '레시피 추가에 실패했습니다', 'error');
    }
  };

  const removeRecipe = async (ingId) => {
    try {
      await api.deleteRecipe(menu.id, ingId);
      onRefresh();
    } catch (e) {
      toast(e.message || '레시피 삭제에 실패했습니다', 'error');
    }
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`레시피 관리 — ${menu.name}`}
      footer={<Button onClick={onClose}>닫기</Button>}
    >
      <div className="mb-4">
        {menu.recipes.length === 0 ? (
          <EmptyState className="p-4">레시피 없음</EmptyState>
        ) : (
          <Table>
            <THead><TR><TH>재료</TH><TH>소모량</TH><TH></TH></TR></THead>
            <TBody>
              {menu.recipes.map(r => (
                <TR key={r.ingredient_id}>
                  <TD>{r.ingredient_name}</TD>
                  <TD>{r.amount} {r.unit}</TD>
                  <TD><Button variant="danger" size="sm" onClick={() => removeRecipe(r.ingredient_id)}>삭제</Button></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </div>

      <div className="font-semibold mb-2">재료 추가</div>
      <FieldRow>
        <Field label="재료">
          <Select
            value={form.ingredient_id ? String(form.ingredient_id) : 'NONE'}
            onValueChange={v => setForm(f => ({ ...f, ingredient_id: v === 'NONE' ? '' : v }))}
            options={INGREDIENT_OPTIONS}
          />
        </Field>
        <Field label="1개당 소모량" className="max-w-[120px]">
          <Input type="number" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="0" />
        </Field>
        <Button variant="primary" className="mt-5" onClick={addRecipe}>추가</Button>
      </FieldRow>
    </Modal>
  );
}

function RecipeHistoryModal({ menu, onClose }) {
  const [history, setHistory] = useState([]);
  useEffect(() => {
    api.getRecipeHistory(menu.id).then(setHistory).catch(() => {});
  }, [menu.id]);

  const ACTION_LABEL = { ADDED: '추가', UPDATED: '수정', DELETED: '삭제' };
  const ACTION_COLOR = { ADDED: '#16a34a', UPDATED: '#f59e0b', DELETED: '#ef4444' };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`레시피 변경 이력 — ${menu.name}`}
      maxWidth={560}
      footer={<Button onClick={onClose}>닫기</Button>}
    >
      {history.length === 0 ? (
        <EmptyState>변경 이력이 없습니다</EmptyState>
      ) : (
        <Table>
          <THead><TR><TH>일시</TH><TH>재료</TH><TH>변경</TH><TH>수량</TH><TH>처리자</TH></TR></THead>
          <TBody>
            {history.map(h => (
              <TR key={h.id}>
                <TD className="text-fg-2 tracking-[0.1px] text-[12px]">{new Date(h.created_at).toLocaleString('ko-KR')}</TD>
                <TD>{h.ingredient_name || '-'}</TD>
                <TD><span className="font-semibold" style={{ color: ACTION_COLOR[h.action] }}>{ACTION_LABEL[h.action]}</span></TD>
                <TD className="text-fg-2 tracking-[0.1px] text-[12px]">
                  {h.old_amount != null && `${h.old_amount} → `}{h.new_amount != null ? h.new_amount : '-'}
                </TD>
                <TD className="text-fg-2 tracking-[0.1px] text-[12px]">{h.changed_by_name || '-'}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Modal>
  );
}

export default function Menus() {
  const { user } = useAuth();
  const canEdit = LOGISTICS_ROLES.includes(user?.role);
  const { currentStore } = useStore();
  const [menus, setMenus] = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [modal, setModal] = useState(null);

  const loadMenus = () => {
    if (!currentStore) return;
    api.getMenus(currentStore.id).then(setMenus).catch(() => {});
  };

  useEffect(() => {
    loadMenus();
    if (currentStore) api.getIngredients(currentStore.id).then(setIngredients).catch(() => {});
  }, [currentStore?.id]);

  const handleSave = async (form) => {
    if (!form.name?.trim()) { toast('메뉴명을 입력해주세요', 'error'); return; }
    try {
      if (modal?.edit) await api.updateMenu(modal.edit.id, form);
      else await api.createMenu({ ...form, store_id: currentStore.id });
      setModal(null);
      loadMenus();
    } catch (e) {
      toast(e.message || '저장에 실패했습니다', 'error');
    }
  };

  const handleDelete = async (id) => {
    if (!(await confirmDialog({ title: '메뉴를 삭제하시겠습니까? 레시피도 함께 삭제됩니다.' }))) return;
    try {
      await api.deleteMenu(id);
      loadMenus();
    } catch (e) {
      toast(e.message || '삭제에 실패했습니다', 'error');
    }
  };

  const getMenuWithLatest = (id) => menus.find(m => m.id === id);

  if (!currentStore) return <EmptyState>가맹점을 선택해주세요</EmptyState>;

  return (
    <div>
      <div className="top-bar">
        <h2>메뉴 & 레시피 관리 — {currentStore.name}</h2>
        {canEdit && <Button variant="primary" onClick={() => setModal('add')}>+ 메뉴 추가</Button>}
      </div>

      <Card>
        {menus.length === 0 ? (
          <EmptyState>메뉴를 추가해주세요</EmptyState>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>메뉴명</TH>
                <TH>토스 메뉴 ID</TH>
                <TH>핵심메뉴</TH>
                <TH>레시피 재료 수</TH>
                <TH>관리</TH>
              </TR>
            </THead>
            <TBody>
              {menus.map(m => (
                <TR key={m.id}>
                  <TD><b>{m.name}</b></TD>
                  <TD className="text-fg-2 tracking-[0.1px] text-[13px]">{m.toss_menu_id || '-'}</TD>
                  <TD>
                    {canEdit ? (
                      <Button
                        variant={m.is_key ? 'primary' : 'secondary'}
                        size="sm"
                        onClick={async () => {
                          try {
                            await api.updateMenu(m.id, { ...m, is_key: !m.is_key });
                            loadMenus();
                          } catch (e) {
                            toast(e.message || '수정에 실패했습니다', 'error');
                          }
                        }}
                      >
                        {m.is_key ? '핵심' : '일반'}
                      </Button>
                    ) : (m.is_key ? '핵심' : '일반')}
                  </TD>
                  <TD>
                    {m.recipes.length === 0
                      ? <Badge tone="yellow">레시피 없음</Badge>
                      : <Badge tone="green">{m.recipes.length}가지</Badge>}
                  </TD>
                  <TD className="flex gap-1.5">
                    <Button size="sm" onClick={() => setModal({ history: m })}>이력</Button>
                    {canEdit && (
                      <>
                        <Button size="sm" onClick={() => setModal({ recipe: m })}>레시피</Button>
                        <Button size="sm" onClick={() => setModal({ edit: m })}>수정</Button>
                        <Button variant="danger" size="sm" onClick={() => handleDelete(m.id)}>삭제</Button>
                      </>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {(modal === 'add' || modal?.edit) && (
        <MenuModal
          item={modal?.edit}
          onClose={() => setModal(null)}
          onSave={handleSave}
        />
      )}
      {modal?.recipe && (
        <RecipeModal
          menu={getMenuWithLatest(modal.recipe.id)}
          ingredients={ingredients}
          onClose={() => { setModal(null); loadMenus(); }}
          onRefresh={loadMenus}
        />
      )}
      {modal?.history && (
        <RecipeHistoryModal
          menu={modal.history}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
