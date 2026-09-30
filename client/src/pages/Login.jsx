import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { useTheme } from '../ThemeContext';
import { Button, Card, Field, Input } from '../components/ui';

// 로컬 데모 계정. 서버는 server/src/db/schema.js의 initDb()가 !isProduction일 때만 이 계정들을
// 만든다 — 운영 빌드에서는 계정도 버튼도 존재하지 않는다.
const DEMO_ACCOUNTS = [
  { label: '점주',   email: 'owner@posmos.com', password: 'admin123' },
  { label: '본사',   email: 'hq@posmos.com',    password: 'admin123' },
  { label: '관리자', email: 'admin@posmos.com', password: 'admin1234' },
];
const SHOW_DEMO = import.meta.env.DEV || import.meta.env.VITE_DEMO_LOGIN === 'true';

export default function Login() {
  const { login } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const user = await login(form.email, form.password);
      if (['STORE_OWNER', 'STORE_STAFF'].includes(user.role)) navigate('/store');
      else navigate('/');
    } catch (e) {
      // 잠금(429) 메시지까지 '이메일 또는 비밀번호 오류'로 뭉개져, 15분 잠금에 걸린 사용자가
      // 계속 비밀번호를 다시 입력했다.
      setError(e.status === 429 ? e.message : '이메일 또는 비밀번호가 올바르지 않습니다');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      <div className="absolute top-4 right-4">
        <button className="theme-toggle bg-card border border-line text-fg" onClick={toggle}>
          {theme === 'light' ? '다크 모드' : '라이트 모드'}
        </button>
      </div>
      <Card className="w-full max-w-[400px] px-12 py-10 shadow-[0_20px_60px_rgba(0,0,0,0.12)]">
        <h1 className="text-xl font-extrabold mb-2">포스모스</h1>
        <p className="text-muted mb-8 text-[14px]">오더페이 관리 시스템</p>

        <form onSubmit={handleSubmit}>
          <Field label="이메일" className="mb-4">
            <Input type="email" value={form.email}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              placeholder="admin@posmos.com" />
          </Field>
          <Field label="비밀번호" className="mb-6">
            <Input type="password" value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              placeholder="••••••••" />
          </Field>
          {error && <div className="text-[#ef4444] text-[14px] mb-4">{error}</div>}
          <Button type="submit" variant="primary" className="w-full p-3 text-sm" disabled={loading}>
            {loading ? '로그인 중...' : '로그인'}
          </Button>
        </form>

        {SHOW_DEMO && (
          <div className="mt-6 pt-5 border-t border-line">
            <div className="flex gap-2">
              {DEMO_ACCOUNTS.map(acc => (
                <Button key={acc.email} type="button" variant="secondary" className="flex-1 text-[13px]"
                  onClick={() => { setForm({ email: acc.email, password: acc.password }); setError(''); }}>
                  {acc.label}
                </Button>
              ))}
            </div>
            <p className="text-muted text-[12px] mt-2 text-center">로컬 데모 계정 — 클릭하면 입력칸이 채워집니다</p>
          </div>
        )}
      </Card>
    </div>
  );
}
