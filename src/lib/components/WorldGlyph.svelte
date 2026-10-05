<script module lang="ts">
	import { nativePoint } from '#lib/model/nonorientable-reference';
	// A small, static projected illustration of the actual figure-eight immersion.
	// Depth-sorted ribbon patches keep its crossing readable without a renderer.
	const kleinFaces = (() => {
		const nu = 28,
			nv = 12;
		function point(u: number, v: number) {
			const [x, y, z] = nativePoint(
				{ shape: 'klein', majorRadius: 1, sectionScale: 0.28 },
				{ u, v }
			);
			const yaw = 0.55,
				tilt = 0.57;
			const across = x * Math.cos(yaw) - z * Math.sin(yaw);
			const away = x * Math.sin(yaw) + z * Math.cos(yaw);
			return [
				32 + across * 20,
				32 - (y * Math.cos(tilt) + away * Math.sin(tilt)) * 20,
				away * Math.cos(tilt) - y * Math.sin(tilt)
			];
		}
		return Array.from({ length: nu * nv }, (_, id) => {
			const i = Math.floor(id / nv),
				j = id % nv;
			const u = (i * Math.PI * 2) / nu,
				v = (j * Math.PI * 2) / nv;
			const du = (Math.PI * 2) / nu,
				dv = (Math.PI * 2) / nv;
			const points = [point(u, v), point(u + du, v), point(u + du, v + dv), point(u, v + dv)];
			const horizontal = points[1].map((n, axis) => n - points[0][axis]);
			const vertical = points[3].map((n, axis) => n - points[0][axis]);
			const normal = [
				horizontal[1] * vertical[2] - horizontal[2] * vertical[1],
				horizontal[2] * vertical[0] - horizontal[0] * vertical[2],
				horizontal[0] * vertical[1] - horizontal[1] * vertical[0]
			];
			const side = normal[2] < 0 ? -1 : 1;
			const light = Math.max(
				0,
				(side * (-normal[0] * 0.4 - normal[1] * 0.6 + normal[2] * 0.7)) / Math.hypot(...normal)
			);
			return {
				id,
				d:
					points
						.map((p, index) => `${index ? 'L' : 'M'}${p[0].toFixed(2)} ${p[1].toFixed(2)}`)
						.join('') + 'Z',
				depth: points.reduce((sum, p) => sum + p[2], 0) / 4,
				fill:
					light > 0.6
						? `color-mix(in srgb, currentColor ${Math.round(100 - (light - 0.6) * 105)}%, #e2ffff)`
						: `color-mix(in srgb, currentColor ${Math.round(28 + light * 95)}%, #353052)`
			};
		}).sort((a, b) => a.depth - b.depth);
	})();
</script>

<script lang="ts">
	import type { WorldDefinition } from '#lib/model';
	let {
		shape,
		size = 42,
		active = false,
		domain = 'surface'
	}: {
		shape: WorldDefinition['shape'];
		size?: number;
		active?: boolean;
		domain?: 'volume' | 'surface';
	} = $props();
	const uid = $props.id();
	const volumeAgents: Partial<Record<WorldDefinition['shape'], number[][]>> = {
		box: [
			[24, 26, 20],
			[37, 31, 75],
			[23, 40, -40],
			[41, 44, 130]
		],
		sphere: [
			[22, 23, -30],
			[39, 23, 80],
			[28, 35, 20],
			[42, 41, 110]
		],
		plane: [],
		cylinder: [
			[24, 23, -20],
			[41, 28, 80],
			[25, 40, 15],
			[37, 48, 150]
		],
		torus: [
			[14, 28, -30],
			[29, 16, 70],
			[46, 23, 125],
			[43, 44, -80],
			[21, 47, 150]
		]
	};
</script>

<svg
	class="world-glyph"
	class:active
	width={size}
	height={size}
	viewBox="0 0 64 64"
	fill="none"
	aria-hidden="true"
>
	<defs>
		<linearGradient
			id={`${uid}-wash`}
			x1="15"
			y1="10"
			x2="50"
			y2="57"
			gradientUnits="userSpaceOnUse"
		>
			<stop stop-color="#c8fcff" stop-opacity="0.85" /><stop
				offset="0.3"
				stop-color="currentColor"
				stop-opacity="0.66"
			/><stop offset="0.72" stop-color="#827bcd" stop-opacity="0.6" /><stop
				offset="1"
				stop-color="#352c60"
				stop-opacity="0.8"
			/>
		</linearGradient>
		<linearGradient
			id={`${uid}-side`}
			x1="12"
			y1="30"
			x2="49"
			y2="54"
			gradientUnits="userSpaceOnUse"
		>
			<stop stop-color="currentColor" stop-opacity="0.34" /><stop
				offset="1"
				stop-color="#65528e"
				stop-opacity="0.7"
			/>
		</linearGradient>
		<linearGradient
			id={`${uid}-cylinder`}
			x1="15"
			y1="32"
			x2="49"
			y2="32"
			gradientUnits="userSpaceOnUse"
		>
			<stop stop-color="#384668" stop-opacity="0.9" /><stop
				offset="0.3"
				stop-color="currentColor"
				stop-opacity="0.8"
			/><stop offset="0.54" stop-color="#9bb0ea" stop-opacity="0.6" /><stop
				offset="1"
				stop-color="#38305e"
				stop-opacity="0.9"
			/>
		</linearGradient>
		<linearGradient
			id={`${uid}-rim`}
			x1="10"
			y1="12"
			x2="52"
			y2="54"
			gradientUnits="userSpaceOnUse"
		>
			<stop stop-color="#dcffff" /><stop
				offset="0.5"
				stop-color="currentColor"
				stop-opacity="0.9"
			/><stop offset="1" stop-color="#ba9aed" stop-opacity="0.8" />
		</linearGradient>
		<radialGradient
			id={`${uid}-sphere`}
			cx="0"
			cy="0"
			r="1"
			gradientTransform="translate(25 21) rotate(50) scale(39)"
		>
			<stop stop-color="#d9ffff" stop-opacity="0.9" /><stop
				offset="0.24"
				stop-color="currentColor"
				stop-opacity="0.78"
			/><stop offset="0.58" stop-color="#7987c8" stop-opacity="0.8" /><stop
				offset="1"
				stop-color="#2d254c"
				stop-opacity="0.95"
			/>
		</radialGradient>
	</defs>
	<g class="form" stroke="currentColor" stroke-width="0.85" stroke-linejoin="round">
		{#if shape === 'box'}
			<path d="m12 21 22-10 19 12-21 12Z" fill={`url(#${uid}-wash)`} />
			<path d="M12 21v25l20 10V35Z" fill={`url(#${uid}-side)`} />
			<path d="m32 35 21-12v23L32 56Z" fill="#655294" fill-opacity="0.38" />
			<path d="m12 34 20 10 21-10M22 16l20 12v23M42 17 22 28v23" opacity="0.26" />
			<path d="M34 11v25l-22 10m22-10 19 10" stroke-dasharray="2 2" opacity="0.2" />
			<path
				d="m12 21 22-10 19 12-21 12-20-14m20 14v21"
				stroke={`url(#${uid}-rim)`}
				stroke-width="1.15"
			/>
		{:else if shape === 'sphere'}
			<circle cx="32" cy="32" r="23" fill={`url(#${uid}-sphere)`} stroke={`url(#${uid}-rim)`} />
			<ellipse cx="32" cy="32" rx="10" ry="23" opacity="0.48" transform="rotate(-24 32 32)" />
			<ellipse cx="32" cy="32" rx="23" ry="9" opacity="0.5" transform="rotate(-24 32 32)" />
			<path d="M12 21c11 3 26 0 38-6M14 47c12-1 27-5 37-11" opacity="0.24" />
			<path d="M12 27A23 23 0 0 1 35 9" stroke="#e1ffff" stroke-width="1.25" opacity="0.8" />
			<path d="M36 54a23 23 0 0 0 18-21" stroke="#b69ae5" stroke-width="1.25" opacity="0.7" />
		{:else if shape === 'plane'}
			<path d="m7 28 18 27 33-17v-3L25 52Z" fill={`url(#${uid}-side)`} stroke-opacity="0.6" />
			<path d="m7 28 32-15 19 22-33 17Z" fill={`url(#${uid}-wash)`} />
			<path
				d="m15 24 19 24m-11-28 19 24m-11-28 19 24M12 34l32-16M17 40l33-16M21 46l34-17"
				opacity="0.4"
			/>
			<path d="m7 28 32-15 19 22" stroke={`url(#${uid}-rim)`} stroke-width="1.25" />
			<path d="m9 44 8 8m-6-1 6 1-1-6" opacity="0.75" />
		{:else if shape === 'cylinder'}
			<path d="M15 17v30c0 12 34 12 34 0V17" fill={`url(#${uid}-cylinder)`} />
			<ellipse
				cx="32"
				cy="17"
				rx="17"
				ry="8"
				fill="#262743"
				fill-opacity="0.9"
				stroke={`url(#${uid}-rim)`}
				stroke-width="1.2"
			/>
			<ellipse cx="32" cy="17" rx="12" ry="5" stroke="#a4b3e5" stroke-opacity="0.27" />
			<path d="M15 47c0-11 34-11 34 0" stroke-dasharray="2 2" opacity="0.3" />
			<path d="M15 31c0 11 34 11 34 0M23 23v31M41 23v31" opacity="0.32" />
			<path d="M15 19v28c0 5 7 8 15 9" stroke={`url(#${uid}-rim)`} stroke-width="1.2" />
			<path d="M49 20v27c0 5-7 8-15 9" stroke="#b89ddf" stroke-width="1.2" opacity="0.7" />
		{:else if shape === 'torus'}
			<path
				d="M6 32c0-12 12-21 26-21s26 9 26 21-12 21-26 21S6 44 6 32Zm13-3c0 5 6 9 13 9s13-4 13-9-6-8-13-8-13 3-13 8Z"
				fill={`url(#${uid}-sphere)`}
				fill-rule="evenodd"
				stroke={`url(#${uid}-rim)`}
			/>
			<path d="M19 29c0 5 6 9 13 9s13-4 13-9" stroke="#d4fdff" stroke-width="1.15" opacity="0.8" />
			<path d="M19 29c0-5 6-8 13-8s13 3 13 8" stroke="#41345f" stroke-width="1.8" />
			<ellipse cx="32" cy="32" rx="20" ry="15" opacity="0.34" />
			<path
				d="M8 25c4-9 13-14 24-14M32 53c13 0 24-8 26-18"
				stroke={`url(#${uid}-rim)`}
				stroke-width="1.3"
			/>
			<path
				d="M9 24c-4 8 6 15 10 5M26 12c-6 2-6 8-1 10M50 18c-9-4-13 5-6 12M51 45c4-7-5-13-11-8M25 52c7-3 7-11 3-14M9 42c7 0 10-5 11-9"
				opacity="0.3"
			/>
		{:else if shape === 'mobius'}
			<path
				d="M9 27C10 13 35 9 49 20C60 28 55 44 42 49C30 54 12 46 9 36L19 31C22 40 35 44 43 39C51 34 48 25 39 23C30 21 24 30 20 38Z"
				fill={`url(#${uid}-sphere)`}
				stroke={`url(#${uid}-rim)`}
			/>
			<path
				d="M9 27C11 38 31 43 43 39L42 49C31 49 22 43 20 38C16 31 20 22 29 18"
				fill={`url(#${uid}-side)`}
				stroke-opacity=".6"
			/>
			<path
				d="M9 27C13 22 17 26 20 38M39 23C44 23 47 21 49 20"
				fill="none"
				stroke={`url(#${uid}-rim)`}
				stroke-width="1.2"
			/>
			<path
				d="M13 22C16 20 25 31 25 41M25 14C32 15 33 26 29 29M45 18C48 24 50 27 50 33M45 44l-2-5M26 48l4-6"
				opacity=".28"
			/>
		{:else if shape === 'klein'}
			<g stroke-width=".22">
				{#each kleinFaces as face (face.id)}
					<path d={face.d} fill={face.fill} stroke={face.fill} />
				{/each}
			</g>
		{:else if shape === 'projective'}
			<path
				d="M31 9C43 7 52 22 49 32C57 40 49 53 37 54C27 61 13 50 14 39C5 30 14 17 25 17C25 12 28 10 31 9Z"
				fill={`url(#${uid}-sphere)`}
				stroke={`url(#${uid}-rim)`}
			/>
			<path
				d="M25 17C41 16 47 40 37 54C34 34 26 31 14 39C28 37 36 26 31 9"
				fill={`url(#${uid}-side)`}
				stroke-opacity=".5"
			/>
			<path
				d="M25 17C40 21 45 37 37 54M14 39C29 34 40 37 49 32M31 9C28 21 23 34 14 39"
				fill="none"
				stroke={`url(#${uid}-rim)`}
				stroke-width="1.1"
			/>
			<path
				d="M17 23C27 25 35 18 41 13M13 31C19 36 39 29 47 25M21 51C27 48 39 44 50 43"
				fill="none"
				opacity=".26"
			/>
		{:else if shape === 'genus2'}
			<path
				d="M4 30C4 18 13 12 24 14C29 15 31 20 34 18C47 10 60 17 60 30C60 43 52 53 40 50C35 49 34 45 30 47C17 55 4 45 4 30ZM14 29C14 34 19 37 23 35C29 32 25 24 21 24C17 24 14 26 14 29ZM39 28C35 32 38 38 43 38C48 38 52 35 51 30C50 26 43 24 39 28Z"
				fill={`url(#${uid}-sphere)`}
				fill-rule="evenodd"
				stroke={`url(#${uid}-rim)`}
			/>
			<path
				d="M14 29C14 34 19 37 23 35M39 28C35 32 38 38 43 38C48 38 52 35 51 30"
				fill="none"
				stroke="#d4fdff"
				stroke-width="1.1"
				opacity=".8"
			/>
			<path
				d="M14 29C14 25 23 21 26 29M39 28C44 24 51 26 51 30"
				fill="none"
				stroke="#41345f"
				stroke-width="1.6"
			/>
			<path
				d="M5 27C9 17 23 13 29 24C33 32 28 37 24 45M31 20C35 29 29 34 30 47M39 16C36 19 36 23 39 28M52 46C47 44 45 41 45 38M12 44C13 40 14 35 16 34"
				fill="none"
				opacity=".32"
			/>
			<path
				d="M5 27C6 21 11 16 17 15M40 50C51 52 58 43 60 34"
				fill="none"
				stroke={`url(#${uid}-rim)`}
				stroke-width="1.25"
			/>
		{/if}
	</g>
	{#if domain === 'volume'}
		<g fill="var(--pearl)" opacity=".9">
			{#each volumeAgents[shape] ?? [] as agent (agent.join(','))}
				<path
					d="m0-2.3 1.7 4.3L0 1.2-1.7 2Z"
					transform={`translate(${agent[0]} ${agent[1]}) rotate(${agent[2]})`}
				/>
			{/each}
		</g>
	{/if}
</svg>

<style>
	.world-glyph {
		display: block;
		overflow: visible;
		color: var(--world-accent, #85d8dd);
	}
	.form {
		transform-origin: 32px 32px;
		transition:
			transform 220ms ease,
			opacity 220ms ease;
		opacity: 0.87;
	}
	.active .form {
		opacity: 1;
	}
	:global(button:hover) .form {
		transform: rotate(-5deg) translateY(-1px);
		opacity: 1;
	}
	@media (prefers-reduced-motion: reduce) {
		.form {
			transition: none;
		}
		:global(button:hover) .form {
			transform: none;
		}
	}
</style>
