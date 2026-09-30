import { createContext, useContext, useState, useEffect } from 'react';
import { api } from './api';

const StoreContext = createContext(null);

export function StoreProvider({ children }) {
  const [stores, setStores] = useState([]);
  const [currentStore, setCurrentStore] = useState(null);
  const [loaded, setLoaded] = useState(false);

  const loadStores = async () => {
    try {
      const list = await api.getStores();
      setStores(list);
      if (!currentStore && list.length > 0) {
        const saved = localStorage.getItem('currentStoreId');
        if (saved) {
          const found = list.find(s => s.id === Number(saved));
          if (found) setCurrentStore(found);
        }
      }
    } catch {} finally {
      setLoaded(true);
    }
  };

  useEffect(() => { loadStores(); }, []);

  const clearStore = () => {
    setCurrentStore(null);
    localStorage.removeItem('currentStoreId');
  };

  return (
    <StoreContext.Provider value={{ stores, currentStore, reloadStores: loadStores, clearStore, loaded }}>
      {children}
    </StoreContext.Provider>
  );
}

export const useStore = () => useContext(StoreContext);
