import { defineConfig } from '@playwright/test';

export default defineConfig({
	webServer: {
		command: 'pnpm build && pnpm preview --host 127.0.0.1',
		port: 4173,
		reuseExistingServer: !process.env.CI
	},
	use: {
		channel: 'chromium',
		baseURL: 'http://127.0.0.1:4173',
		viewport: { width: 1440, height: 1000 },
		launchOptions: { args: ['--enable-gpu', '--enable-unsafe-webgpu'] },
		trace: 'retain-on-failure'
	},
	workers: 1,
	testDir: 'e2e',
	testMatch: '**/*.e2e.{ts,js}',
	timeout: 60000
});
