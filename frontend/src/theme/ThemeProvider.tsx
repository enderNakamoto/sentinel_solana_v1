'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

/**
 * Theme provider — exposes serious↔fun mode + persists in localStorage.
 *
 * Per Phase 12 M1 (modularity rule): the mode flips a single class on the
 * <body>. Fun-mode CSS lives entirely under src/theme/fun/ and is purely
 * additive — serious mode is unaffected when fun-mode files change.
 *
 * Pages read `useTheme().mode` and conditionally render fun-mode
 * decorations (e.g. <Mascots />); they NEVER inline fun-specific JSX.
 */

export type ThemeMode = 'serious' | 'fun';

interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'sentinel.theme.mode';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('serious');

  // Hydrate from localStorage on mount.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === 'serious' || stored === 'fun') {
        setModeState(stored);
      }
    } catch {
      /* ignore — SSR / private mode */
    }
  }, []);

  // Sync class on <body> whenever mode changes.
  useEffect(() => {
    const body = document.body;
    if (mode === 'fun') {
      body.classList.add('mode-fun');
    } else {
      body.classList.remove('mode-fun');
    }
  }, [mode]);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    try {
      window.localStorage.setItem(STORAGE_KEY, m);
    } catch {
      /* ignore */
    }
  }, []);

  const toggle = useCallback(() => {
    setMode(mode === 'fun' ? 'serious' : 'fun');
  }, [mode, setMode]);

  return (
    <ThemeContext.Provider value={{ mode, setMode, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme() must be inside <ThemeProvider>');
  }
  return ctx;
}
