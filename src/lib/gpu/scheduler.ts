/** The simulation clock advances only when a complete physical tick is encoded. */
export class FixedScheduler {
	private debt = 0;
	reset() {
		this.debt = 0;
	}
	advance(wallSeconds: number, dt: number, maxSteps: number, timeScale: number) {
		this.record(wallSeconds, dt, maxSteps, timeScale);
		return this.take(dt, maxSteps);
	}
	/** Remember bounded wall time while the GPU queue is occupied. */
	record(wallSeconds: number, dt: number, maxSteps: number, timeScale: number) {
		this.debt = Math.min(
			this.debt + Math.min(Math.max(wallSeconds, 0), 0.1) * timeScale,
			dt * maxSteps
		);
	}
	take(dt: number, maxSteps: number) {
		const steps = Math.min(maxSteps, Math.floor((this.debt + 1e-9) / dt));
		this.debt -= steps * dt;
		return steps;
	}
}
