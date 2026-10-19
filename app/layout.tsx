import type { Metadata } from "next";
export const metadata: Metadata = { title: "Health Informatics Atlas", description: "Personal learning with private account-based progress." };
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) { return <html lang="en"><body>{children}</body></html>; }
