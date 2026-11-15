// Shrink a heavy GLB so it exports to a phone-friendly USDZ.
//
//   node worker/meshtools/shrink.mjs in.glb out.glb [--max-tris 150000] [--max-tex 2048]
//
// Hand-made exports from the Tripo / Meshy websites are often 1-2 million triangles with 4K textures
// (60-150 MB). AR Quick Look gets slow above a few hundred thousand triangles and our USDZ limit is 15 MB.
// Steps: decode Draco/meshopt if present, weld, simplify with meshoptimizer to the triangle budget
// (UV seams and borders are kept), resize textures, drop unused data. Prints one JSON line of stats.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { compactPrimitive, dedup, prune, weld, simplify, textureCompress } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptDecoder } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : def; };
const [inPath, outPath] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!inPath || !outPath) { console.error('usage: shrink.mjs in.glb out.glb [--max-tris N] [--max-tex PX]'); process.exit(2); }
const maxTris = opt('--max-tris', 150000);
const maxTex = opt('--max-tex', 2048);

const triangles = (doc) => {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
    if (p.getMode() !== 4) continue;   // TRIANGLES
    const idx = p.getIndices();
    n += (idx ? idx.getCount() : p.getAttribute('POSITION').getCount()) / 3;
  }
  return Math.round(n);
};

await MeshoptDecoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'meshopt.decoder': MeshoptDecoder,
});
const doc = await io.read(inPath);
// we write plain (uncompressed) GLB: three.js in the exporter page has no Draco decoder loaded
for (const name of ['KHR_draco_mesh_compression', 'EXT_meshopt_compression']) {
  doc.getRoot().listExtensionsUsed().filter((e) => e.extensionName === name).forEach((e) => e.dispose());
}
const before = triangles(doc);
const transforms = [dedup(), weld()];
if (before > maxTris) {
  // simplify() takes a ratio; error is a cap in model units (relative), kept loose so the ratio wins
  transforms.push(simplify({ simplifier: MeshoptSimplifier, ratio: Math.max(0.01, maxTris / before), error: 0.01 }));
}
transforms.push(textureCompress({ encoder: sharp, resize: [maxTex, maxTex], targetFormat: undefined }), prune());
await doc.transform(...transforms);
let after = triangles(doc);
if (after > maxTris * 1.15) {      // simplify stops early on very noisy scans: allow more error once
  await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: maxTris / after, error: 0.05 }), prune());
  after = triangles(doc);
}
if (after > maxTris * 1.15) {
  // Many UV seams (a woven wicker texture split into thousands of islands) block normal edge collapses.
  // Permissive mode may collapse across seams but still weighs texture coordinates, so the texture survives.
  const ratio = maxTris / after;
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== 4) continue;
    const posAcc = prim.getAttribute('POSITION');
    const n = posAcc.getCount();
    const positions = new Float32Array(n * 3);
    const el = [0, 0, 0];
    for (let i = 0; i < n; i++) { posAcc.getElement(i, el); positions.set(el, i * 3); }
    let idx = prim.getIndices();
    const indices = idx ? Uint32Array.from(idx.getArray()) : Uint32Array.from({ length: n }, (_, i) => i);
    const target = Math.max(3, Math.floor((indices.length * ratio) / 3) * 3);
    const [out] = MeshoptSimplifier.simplify(indices, positions, 3, target, 0.05, ['Permissive']);
    if (!out.length) continue;
    if (!idx) { idx = doc.createAccessor().setType('SCALAR').setBuffer(doc.getRoot().listBuffers()[0]); prim.setIndices(idx); }
    idx.setArray(n > 65535 ? out : Uint16Array.from(out));
    compactPrimitive(prim);
  }
  await doc.transform(prune());
  after = triangles(doc);
}
let sloppy = false;
if (after > maxTris * 1.15) {
  // Still over budget: the mesh is cut into many UV islands / flat-shaded faces, so edge collapses are blocked
  // at every seam. Sloppy simplification ignores topology (it clusters vertices) and keeps the shape, but on a
  // textured part it merges vertices from different UV islands and smears the texture (tested on a Meshy model).
  // A smeared texture looks worse in AR than a heavy mesh, so only untextured parts get it.
  const ratio = maxTris / after;
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== 4) continue;
    const mat = prim.getMaterial();
    if (mat && (mat.getBaseColorTexture() || mat.getNormalTexture())) continue;
    const posAcc = prim.getAttribute('POSITION');
    const n = posAcc.getCount();
    const positions = new Float32Array(n * 3);
    const el = [0, 0, 0];
    for (let i = 0; i < n; i++) { posAcc.getElement(i, el); positions.set(el, i * 3); }
    let idx = prim.getIndices();
    const indices = idx ? Uint32Array.from(idx.getArray()) : Uint32Array.from({ length: n }, (_, i) => i);
    const target = Math.max(3, Math.floor((indices.length * ratio) / 3) * 3);
    const [out] = MeshoptSimplifier.simplifySloppy(indices, positions, 3, null, target, 0.05);
    if (!out.length) continue;   // would erase the part: leave it as is
    if (!idx) { idx = doc.createAccessor().setType('SCALAR').setBuffer(doc.getRoot().listBuffers()[0]); prim.setIndices(idx); }
    idx.setArray(n > 65535 ? out : Uint16Array.from(out));
    compactPrimitive(prim);
    sloppy = true;
  }
  await doc.transform(prune());
  after = triangles(doc);
}
await io.write(outPath, doc);
console.log(JSON.stringify({ triangles_before: before, triangles_after: after, max_tex: maxTex, sloppy }));
