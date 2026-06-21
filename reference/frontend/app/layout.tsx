import type { Metadata } from 'next';
import { Geist, JetBrains_Mono, Instrument_Serif } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { Chrome } from './Chrome';
import { ToastProvider } from '@/components/Toast';

// Serious-mode fonts only. Cinzel + IM Fell English (fun mode) removed.

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

export const metadata: Metadata = {
  title: 'Sentinel — Flight Delay Protocol',
  description:
    'Decentralised flight delay insurance. Parametric coverage, instant payouts.',
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
  ].join(' ');

  return (
    <html lang="en" className={fontClass}>
      <body>
        <Providers>
          <ThemeProvider>
            <ToastProvider>
              <Chrome>{children}</Chrome>
            </ToastProvider>
          </ThemeProvider>
        </Providers>
      </body>
    </html>
  );
}
