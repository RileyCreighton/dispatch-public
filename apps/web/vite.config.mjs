import { defineConfig } from 'vite';
export default defineConfig({ envDir: false, build: { sourcemap: false, target: 'es2023' }, server: { host: '127.0.0.1' } });
