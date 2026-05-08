import type { Metadata } from 'next';
import { Geist, JetBrains_Mono, Instrument_Serif, Cinzel, IM_Fell_English } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { Sidebar } from '@/components/Sidebar';
import { Topbar } from '@/components/Topbar';
import { BottomNav } from '@/components/BottomNav';
import { Mascots } from '@/theme/fun/Mascots';
import { ToastProvider } from '@/components/Toast';

// Fonts wired as CSS variables. The serious-mode token CSS pulls these
// via var(--font-geist) etc. Cinzel + IM Fell English are loaded for
// fun-mode but always available so the toggle is instant.

const geist = Geist({
  subsets: ['latin'],
  variable: '--font-geist',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-instrument-serif',
  display: 'swap',
});

const cinzel = Cinzel({
  subsets: ['latin'],
  variable: '--font-cinzel',
  display: 'swap',
});

const imFellEnglish = IM_Fell_English({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-im-fell-english',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Sentinel — Flight Delay Protocol',
  description:
    'Decentralised flight delay insurance on Solana. Parametric coverage, instant payouts.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const fontClass = [
    geist.variable,
    jetbrainsMono.variable,
    instrumentSerif.variable,
    cinzel.variable,
    imFellEnglish.variable,
  ].join(' ');

  return (
    <html lang="en" className={fontClass}>
      <body>
        <Providers>
          <ThemeProvider>
            <ToastProvider>
              <div className="app">
                <Sidebar />
                <main
                  style={{
                    minHeight: '100vh',
                    background: 'var(--bg)',
                    display: 'flex',
                    flexDirection: 'column',
                  }}
                >
                  <Topbar />
                  <div style={{ flex: 1 }}>{children}</div>
                  <BottomNav />
                </main>
              </div>
              <Mascots />
            </ToastProvider>
          </ThemeProvider>
        </Providers>
      </body>
    </html>
  );
}
