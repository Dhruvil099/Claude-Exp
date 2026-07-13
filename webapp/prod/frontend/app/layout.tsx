import type { Metadata } from "next";
import { ConvexAuthNextjsServerProvider } from "@convex-dev/auth/nextjs/server";
import { ConvexClientProvider } from "./ConvexClientProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "VideoHub",
  description: "Free video courses — stream protected HLS, no downloads.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // Server provider handles auth cookies/SSR; client provider wires React hooks.
    <ConvexAuthNextjsServerProvider>
      <html lang="en">
        <body>
          <ConvexClientProvider>{children}</ConvexClientProvider>
        </body>
      </html>
    </ConvexAuthNextjsServerProvider>
  );
}
