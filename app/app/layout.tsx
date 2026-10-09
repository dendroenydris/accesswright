import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "AccessWright | Operator runs",
  description: "Private, read-only accessibility repair run metadata",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <header className="masthead">
          <Link href="/" className="brand">AccessWright <span>operator</span></Link>
          <span className="header-note">Private · read-only</span>
        </header>
        {children}
        <footer>Run metadata only. A ready-for-review status is not a published pull request or compliance certificate.</footer>
      </body>
    </html>
  );
}
