// Pure geometry for the floating bubble window. No Electron imports: rectangles are {x, y, width, height}.

const COLLAPSED = { width: 72, height: 72 };
const EXPANDED = { width: 340, height: 300 };
const MARGIN = 16;

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** Moves `bounds` so it lies inside `area`. A window larger than the area is anchored at its top-left. */
function clampToWorkArea(bounds, area) {
  const maxX = area.x + area.width - bounds.width;
  const maxY = area.y + area.height - bounds.height;
  return {
    ...bounds,
    x: Math.round(Math.max(area.x, Math.min(bounds.x, Math.max(area.x, maxX)))),
    y: Math.round(Math.max(area.y, Math.min(bounds.y, Math.max(area.y, maxY)))),
  };
}

/** Bottom-right corner of the work area, away from the edge. */
function defaultBounds(area, size = COLLAPSED) {
  return {
    width: size.width,
    height: size.height,
    x: area.x + area.width - size.width - MARGIN,
    y: area.y + area.height - size.height - MARGIN,
  };
}

/** The work area that contains the centre of `bounds`; otherwise the primary one (a screen may be unplugged). */
function pickWorkArea(bounds, displays, primary) {
  const centreX = bounds.x + bounds.width / 2;
  const centreY = bounds.y + bounds.height / 2;
  const match = displays.find(({ workArea: a }) => (
    centreX >= a.x && centreX < a.x + a.width && centreY >= a.y && centreY < a.y + a.height
  ));
  return (match ?? primary).workArea;
}

/**
 * Changes the window size while keeping the bubble where the user put it: the corner nearest to a screen edge
 * stays fixed (a bubble in the bottom-right grows up and to the left), then the result is clamped on screen.
 */
function resizeAnchored(bounds, size, area) {
  const centreX = bounds.x + bounds.width / 2;
  const centreY = bounds.y + bounds.height / 2;
  const anchorRight = centreX > area.x + area.width / 2;
  const anchorBottom = centreY > area.y + area.height / 2;
  const x = anchorRight ? bounds.x + bounds.width - size.width : bounds.x;
  const y = anchorBottom ? bounds.y + bounds.height - size.height : bounds.y;
  return clampToWorkArea({ x, y, width: size.width, height: size.height }, area);
}

/** Position saved from a previous run: only a plain {x, y} of finite numbers is trusted. */
function parseSavedPosition(raw) {
  let value;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!value || !isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return null;
  return { x: Math.round(value.x), y: Math.round(value.y) };
}

module.exports = {
  COLLAPSED, EXPANDED, MARGIN, clampToWorkArea, defaultBounds, pickWorkArea, resizeAnchored, parseSavedPosition,
};
