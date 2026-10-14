import type { ReactNode } from 'react';

export const metadata = { title: 'karaoke-dokie', description: 'Find karaoke songs that fit your voice.' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
