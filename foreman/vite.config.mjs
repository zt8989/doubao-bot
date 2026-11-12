// 控制台前端构建：Vite 把 Lit 组件打包成静态产物 → console/dist，
// 由常驻服务直接从本地下发（不再依赖任何 CDN 或手放的 vendor 文件）。
import { defineConfig } from "vite"

export default defineConfig({
  root: "console",
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
})
