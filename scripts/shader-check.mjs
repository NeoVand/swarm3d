import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const folder = 'src/lib/gpu/shaders';
const files = (await readdir(folder)).filter((file) => file.endsWith('.wgsl')).sort();
for (const file of files) {
	const result = spawnSync(
		process.execPath,
		['node_modules/vgpu/bin/vgpu.js', 'check', `${folder}/${file}`, '--require-validation'],
		{ encoding: 'utf8' }
	);
	if (result.status !== 0) {
		process.stderr.write(result.stdout + result.stderr);
		process.exit(result.status ?? 1);
	}
	process.stdout.write(`Validated ${file}\n`);
}
if (files.length === 0) throw new Error('No shaders were checked.');
