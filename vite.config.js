import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "/night-report-dashboard/",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      workbox: { globPatterns: ["**/*.{js,css,html,svg,png}"] },
      manifest: {
        name: "Night Report Dashboard",
        short_name: "NightReport",
        start_url: "/night-report-dashboard/",
        display: "standalone",
        background_color: "#ffffff",
        theme_color: "#0ea5e9",
        icons: [
          { src: "/night-report-dashboard/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/night-report-dashboard/icon-512.png", sizes: "512x512", type: "image/png" }
        ]
      }
    })
  ],
});
