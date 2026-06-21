'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * Theme provider — serious mode only.
 *
 * The original codebase shipped a serious↔fun toggle. This reference strips
 * the fun side entirely: the provider is a no-op shim that hard-codes serious
 * so existing pages calling `useTheme().mode` keep compiling without branching.
 * Once your codebase has no `mode === 'fun'` checks left, delete this file
 * and the `useTheme()` call sites too.
 */

export type ThemeMode = 'serious';

interface ThemeContextValue {
  mode: ThemeMode;
}

const ThemeContext = createContext<ThemeContextValue>({ mode: 'serious' });

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <ThemeContext.Provider value={{ mode: 'serious' }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
