/**
 * Human-like mouse-path geometry. Pure (no deps beyond Math) so it stays
 * inside sjs-browser/src/ — the NAS image is built with `COPY sjs-browser/src/`
 * and run via tsx, so this tree can't import anything outside its own src.
 *
 * MIRROR WARNING: this same math lives in the cloud server tree at
 * src/server/browser/stealth-path.ts (the two trees ship separately and can't
 * share a module across the boundary). The copies MUST stay identical so
 * anti-detection tuning applies to both tunnel and server-side movement.
 * src/server/browser/__tests__/bezier-drift.test.ts fails if they diverge.
 */

export interface BezierPoint {
  x: number;
  y: number;
  delayMs: number;
}

/**
 * Compute a curved, human-like mouse path from (fromX,fromY) to (toX,toY):
 * a random bezier arc, ease-in-out speed (smoothstep), and micro-tremor that
 * fades near the target. Returns per-step points with inter-step delays.
 */
export function computeBezierPath(
  fromX: number, fromY: number, toX: number, toY: number,
): BezierPoint[] {
  const steps = 15 + Math.floor(Math.random() * 15);
  const dx = toX - fromX;
  const dy = toY - fromY;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 5) return [{ x: toX, y: toY, delayMs: 0 }];

  const arcAmount = dist * (0.1 + Math.random() * 0.2) * (Math.random() < 0.5 ? 1 : -1);
  const perpX = -dy / dist;
  const perpY = dx / dist;
  const cpX = (fromX + toX) / 2 + perpX * arcAmount;
  const cpY = (fromY + toY) / 2 + perpY * arcAmount;

  const points: BezierPoint[] = [];
  for (let i = 1; i <= steps; i++) {
    const linear = i / steps;
    const t = linear * linear * (3 - 2 * linear);
    const oneMinusT = 1 - t;
    let x = oneMinusT * oneMinusT * fromX + 2 * oneMinusT * t * cpX + t * t * toX;
    let y = oneMinusT * oneMinusT * fromY + 2 * oneMinusT * t * cpY + t * t * toY;

    if (i < steps) {
      const tremorFade = Math.max(0, 1 - Math.max(0, (linear - 0.8) / 0.2));
      const tremorAmount = 2 * tremorFade;
      x += (Math.random() - 0.5) * tremorAmount;
      y += (Math.random() - 0.5) * tremorAmount;
    }

    const delayMs = i < steps
      ? Math.round((4 + Math.random() * 6) * (1 - 0.6 * Math.sin(linear * Math.PI)))
      : 0;

    points.push({ x, y, delayMs });
  }
  return points;
}
