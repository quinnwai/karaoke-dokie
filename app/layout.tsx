import type { ReactNode } from 'react';
import type { Viewport } from 'next';
import './globals.css';

export const metadata = { title: 'karaoke-dokie', description: 'Find karaoke songs that fit your voice.' };

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#07060a',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
