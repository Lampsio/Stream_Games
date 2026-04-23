import { load } from '@tauri-apps/plugin-store';

const STORE_PATH = 'twitch_game_stats.json';
const LOCAL_STORAGE_KEY = 'twitch_game_stats';

// Detect if we are running inside Tauri
const isTauri = !!(window as any).__TAURI_INTERNALS__;

let tauriStore: any = null;

async function getStore() {
  if (!tauriStore) {
    tauriStore = await load(STORE_PATH);
  }
  return tauriStore;
}

/**
 * Persists data to Tauri Store if available, falling back to localStorage.
 */
export async function saveStats(stats: any) {
  if (isTauri) {
    try {
      const store = await getStore();
      await store.set('stats', stats);
      await store.save();
    } catch (e) {
      console.warn('Tauri Store failed, falling back to localStorage:', e);
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(stats));
    }
  } else {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(stats));
  }
}

/**
 * Loads data from Tauri Store if available, falling back to localStorage.
 */
export async function loadStats(): Promise<any> {
  if (isTauri) {
    try {
      const store = await getStore();
      const saved = await store.get('stats');
      if (saved) return saved;
    } catch (e) {
      console.warn('Tauri Store load failed, falling back to localStorage:', e);
    }
  }

  // Browser/Fallback
  const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch (e) {
      return null;
    }
  }
  return null;
}

/**
 * Clears all stats.
 */
export async function clearStats() {
  if (isTauri) {
    try {
      const store = await getStore();
      await store.clear();
      await store.save();
    } catch (e) {
      console.warn('Tauri Store clear failed:', e);
    }
  }
  localStorage.removeItem(LOCAL_STORAGE_KEY);
}
