import { toast } from '../toast';
import { useEffect, useState } from 'react';
import { api } from '../api';
import {
  Button, Card, Badge, EmptyState, Field, Input, Select,
  Table, THead, TBody, TR, TH, TD, Modal, confirmDialog,
} from '../components/ui';

const ROLE_LABEL = {
  SUPER_ADMIN: '최고관리자', HQ_ADMIN: '본사 관리자',
  HQ_LOGISTICS: '본사 물류', HQ_ACCOUNTING: '본사 경리',
  STORE_OWNER: '가맹점 점주', STORE_STAFF: '가맹점 직원',
};
const ROLE_OPTIONS = Object.entries(ROLE_LABEL).map(([k, v]) => ({ value: k, label: v }));

export default function Users() {
  const [users, setUsers] = useState([]);
  const [stores, setStores] = useState([]);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'STORE_OWNER', store_id: 'NONE', is_active: true });

  const load = () => { api.getUsers().then(setUsers).catch(() => {}); };
  useEffect(() => {
    load();
    api.getStores().then(setStores).catch(() => {});
  }, []);

  const handleSave = async () => {
    if (!form.name?.trim()) { toast('이름을 입력해주세요', 'error'); return; }
    if (!form.email?.trim()) { toast('이메일을 입력해주세요', 'error'); return; }
    if (!modal?.edit && !form.password) { toast('비밀번호를 입력해주세요', 'error'); return; }
    if (['STORE_OWNER', 'STORE_STAFF'].includes(form.role) && (!form.store_id || form.store_id === 'NONE')) {
      toast('가맹점을 선택해주세요', 'error'); return;
    }
    try {
      const payload = { ...form, store_id: form.store_id === 'NONE' ? '' : form.store_id };
      if (modal?.edit) await api.updateUser(modal.edit.id, payload);
      else await api.createUser(payload);
      setModal(null);
      load();
    } catch (e) {
      toast(e.message || '저장에 실패했습니다', 'error');
    }
  };

  const openEdit = (u) => {
    setForm({ name: u.name, email: u.email, password: '', role: u.role, store_id: u.store_id ? String(u.store_id) : 'NONE', is_active: u.is_active });
    setModal({ edit: u });
  };

  const removeUser = async (u) => {
    if (!await confirmDialog({ title: '삭제?' })) return;
    try { await api.deleteUser(u.id); load(); }
    catch (e) { toast(e.message || '삭제에 실패했습니다', 'error'); }
  };

  return (
    <div>
      <div className="top-bar">
        <h2>사용자 관리</h2>
        <Button variant="primary" onClick={() => { setForm({ name: '', email: '', password: '', role: 'STORE_OWNER', store_id: 'NONE', is_active: true }); setModal('add'); }}>+ 사용자 추가</Button>
      </div>
      <Card>
        {users.length === 0 ? <EmptyState>사용자 없음</EmptyState> : (
          <Table>
            <THead><TR><TH>이름</TH><TH>이메일</TH><TH>역할</TH><TH>가맹점</TH><TH>활성</TH><TH>관리</TH></TR></THead>
            <TBody>
              {users.map(u => (
                <TR key={u.id} className="fade-stagger">
                  <TD>
                    <div className="flex items-center gap-2">
                      <div className={`avatar-ring c${u.id % 6} w-[26px] h-[26px] text-xs`}>{(u.name || '?').charAt(0)}</div>
                      <b>{u.name}</b>
                    </div>
                  </TD>
                  <TD className="text-xs">{u.email}</TD>
                  <TD><Badge tone="green">{ROLE_LABEL[u.role] || u.role}</Badge></TD>
                  <TD className="text-xs text-[#94a3b8]">{stores.find(s => s.id === u.store_id)?.name || '-'}</TD>
                  <TD><Badge tone={u.is_active ? 'green' : 'red'}>{u.is_active ? '활성' : '비활성'}</Badge></TD>
                  <TD className="flex gap-[6px]">
                    <Button variant="secondary" size="sm" onClick={() => openEdit(u)}>수정</Button>
                    <Button variant="danger" size="sm" onClick={() => removeUser(u)}>삭제</Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Modal
        open={modal === 'add' || !!modal?.edit}
        onOpenChange={(open) => { if (!open) setModal(null); }}
        title={modal?.edit ? '사용자 수정' : '사용자 추가'}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setModal(null)}>취소</Button>
            <Button variant="primary" onClick={handleSave}>저장</Button>
          </>
        )}
      >
        <Field label="이름" className="mb-3">
          <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        </Field>
        <Field label="이메일" className="mb-3">
          <Input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
        </Field>
        <Field label={<>비밀번호 {modal?.edit && '(변경 시만 입력)'}</>} className="mb-3">
          <Input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
        </Field>
        <Field label="역할" className="mb-3">
          <Select value={form.role} onValueChange={v => setForm(f => ({ ...f, role: v }))} options={ROLE_OPTIONS} />
        </Field>
        {['STORE_OWNER', 'STORE_STAFF'].includes(form.role) && (
          <Field label="가맹점" className="mb-4">
            <Select
              value={form.store_id}
              onValueChange={v => setForm(f => ({ ...f, store_id: v }))}
              placeholder="선택"
              options={[{ value: 'NONE', label: '선택' }, ...stores.map(s => ({ value: String(s.id), label: s.name }))]}
            />
          </Field>
        )}
        {/* 비활성화가 API에만 있고 화면에 없어, 퇴사자 계정을 끄려면 삭제밖에 방법이 없었다. */}
        {modal?.edit && (
          <Field label="계정 상태">
            {/* sqlite가 is_active를 1/0으로 돌려줘 String(1)==='1'이 되고, 옵션 값('true'/'false') 어디에도 없어 계정 상태 드롭다운이 빈 칸으로 떴다. */}
            <Select
              value={form.is_active ? 'true' : 'false'}
              onValueChange={v => setForm(f => ({ ...f, is_active: v === 'true' }))}
              options={[{ value: 'true', label: '활성' }, { value: 'false', label: '비활성' }]}
            />
          </Field>
        )}
      </Modal>
    </div>
  );
}
