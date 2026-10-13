import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // React ships in its own file: the app file stays under Vite's 500 kB warning, and a browser keeps the
        // unchanged React file across app updates.
        manualChunks: id => /[\\/]node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?(?:react|react-dom|scheduler)[\\/]/.test(id)
          ? "react" : undefined
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 4317,
    proxy: {
      "/api": "http://127.0.0.1:4318",
      "/product-images": "http://127.0.0.1:4318"
    }
  }
});
