import { describe, it, expect } from 'vitest';
import { FixedScheduler } from './scheduler';
describe('fixed physical scheduling', () => {
	it('produces equal ticks at 30, 60 and 120 display frames/second', () => {
		for (const fps of [30, 60, 120]) {
			const clock = new FixedScheduler();
			let ticks = 0;
			for (let i = 0; i < fps; i++) ticks += clock.advance(1 / fps, 1 / 60, 4, 1);
			expect(ticks).toBe(60);
		}
	});
	it('bounds overload and clears pause debt', () => {
		const clock = new FixedScheduler();
		expect(clock.advance(4, 1 / 60, 4, 1)).toBe(4);
		clock.reset();
		expect(clock.advance(0, 1 / 60, 4, 1)).toBe(0);
	});
	it('retains elapsed physics time across skipped GPU frames without accumulating unlimited debt', () => {
		const clock = new FixedScheduler();
		let ticks = 0;
		for (let frame = 0; frame < 60; frame++) {
			clock.record(1 / 60, 1 / 60, 4, 1);
			if (frame % 3 === 2) ticks += clock.take(1 / 60, 4);
		}
		expect(ticks).toBe(60);
		for (let i = 0; i < 600; i++) clock.record(1 / 60, 1 / 60, 4, 1);
		expect(clock.take(1 / 60, 4)).toBe(4);
		expect(clock.take(1 / 60, 4)).toBe(0);
		clock.record(0.05, 1 / 60, 4, 1);
		clock.reset();
		expect(clock.take(1 / 60, 4)).toBe(0);
	});
});
