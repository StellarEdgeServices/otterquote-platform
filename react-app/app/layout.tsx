import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'OtterQuote App',
  description: 'D-211 React parallel track for OtterQuote',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  )
}
