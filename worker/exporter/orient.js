// Pure orientation / pivot / scale math. No three.js imports, so it is mirrored 1:1 by worker/orient.py
// and both are tested against the same fixtures.

export const IN_TO_M = 0.0254;

// The 6 candidate orientations (spec 6.5 step 3): name, rotation axis, degrees.
export const ORIENTATIONS = [
  ['identity', null, 0],
  ['x+90', 'x', 90],
  ['x-90', 'x', -90],
  ['z+90', 'z', 90],
  ['z-90', 'z', -90],
  ['x180', 'x', 180],
];

// A 90 degree turn swaps two bounding-box extents; a 180 degree turn swaps none.
export function rotatedSize(size, name) {
  const [sx, sy, sz] = size;
  if (name === 'x+90' || name === 'x-90') return [sx, sz, sy];
  if (name === 'z+90' || name === 'z-90') return [sy, sx, sz];
  return [sx, sy, sz];
}

// Width and depth are interchangeable (the user can spin the item in AR), so compare the
// larger and the smaller horizontal extent, each relative to height, on a log scale.
export function ratioScore(size, target) {
  const [w, h, d] = size;
  const [tw, td, th] = target;
  if (!(w > 0 && h > 0 && d > 0 && tw > 0 && td > 0 && th > 0)) return Infinity;
  const ma = Math.max(w, d) / h, mb = Math.min(w, d) / h;
  const ta = Math.max(tw, td) / th, tb = Math.min(tw, td) / th;
  return Math.abs(Math.log(ma / ta)) + Math.abs(Math.log(mb / tb));
}

// Generators almost always return upright models, and a real item's proportions can differ a lot
// from a category prior (a tall slim side table is still a side table). So the model is only turned
// when "as generated" is clearly implausible: another orientation must beat it by a margin AND
// at least halve the mismatch. The margin is larger when the target ratio is only a category prior.
export const IDENTITY_BIAS = 0.35;
export const IDENTITY_BIAS_PRIOR = 0.6;

export function targetDims({ w_in, d_in, h_in, category, dims_source }, priors) {
  const prior = priors[category] || priors.other;
  const have = w_in > 0 && d_in > 0 && h_in > 0;
  // estimated dimensions -> category prior for the ratio (spec 6.5 step 3)
  const ratio = have && dims_source === 'listing_text' ? [w_in, d_in, h_in] : prior;
  const height = h_in > 0 ? h_in : prior[2];
  return { ratio, height_in: height, used_prior: !(have && dims_source === 'listing_text') };
}

export function chooseOrientation(size, ratio, override, usedPrior = false) {
  const scores = {};
  for (const [name] of ORIENTATIONS) scores[name] = ratioScore(rotatedSize(size, name), ratio);
  if (override && scores[override] !== undefined) return { name: override, scores, overridden: true };
  const bias = usedPrior ? IDENTITY_BIAS_PRIOR : IDENTITY_BIAS;
  let best = 'identity';
  let bestScore = scores.identity;
  for (const [name] of ORIENTATIONS) {
    if (name === 'identity' || name === 'x180') continue; // upside-down cannot be told apart by ratios: override only
    if (scores[name] < bestScore - 1e-9) { best = name; bestScore = scores[name]; }
  }
  if (best !== 'identity' && !(scores.identity - bestScore > bias && bestScore < 0.5 * scores.identity)) best = 'identity';
  return { name: best, scores, overridden: false };
}

// Re-pivot + uniform scale by height. box = {min:[x,y,z], max:[x,y,z]} after orientation.
// Returns the translation that puts the footprint centre at the origin with the base at y = 0,
// the uniform scale, and the final size in inches.
export function pivotAndScale(box, height_in) {
  const size = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  if (!(size[1] > 0)) throw new Error('model has zero height');
  const translate = [-(box.min[0] + box.max[0]) / 2, -box.min[1], -(box.min[2] + box.max[2]) / 2];
  const scale = (height_in * IN_TO_M) / size[1];
  const final_in = size.map((s) => (s * scale) / IN_TO_M);
  return { translate, scale, final_in: { w: final_in[0], h: final_in[1], d: final_in[2] } };
}
