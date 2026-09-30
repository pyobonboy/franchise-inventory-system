import { createContext, useContext, useState, useEffect } from 'react';
import { api } from './api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) { setLoading(false); return; }
    api.me().then(setUser).catch(() => localStorage.removeItem('token')).finally(() => setLoading(false));
  }, []);

  const login = async (email, password) => {
    const { token, user } = await api.login(email, password);
    localStorage.setItem('token', token);
    setUser(user);
    return user;
  };

  const logout = () => {
    localStorage.removeItem('token');
    setUser(null);
  };

  const isHQ = user && ['SUPER_ADMIN', 'HQ_ADMIN', 'HQ_LOGISTICS', 'HQ_ACCOUNTING'].includes(user.role);
  const isStore = user && ['STORE_OWNER', 'STORE_STAFF'].includes(user.role);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, isHQ, isStore }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
