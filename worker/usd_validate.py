"""Validate an exported USDZ with usd-core before it is uploaded (spec 6.5).

Checks: pxr.UsdValidation validators (USDZ package, encapsulation, root package, missing
references, stage metadata, composition, shader/material rules) report 0 errors; the bounding box
matches the expected size within 0.5 in; the base sits at y = 0; metallic is 0 on every material;
textures referenced by materials are really in the package.
"""
from __future__ import annotations

import os
import tempfile
import zipfile
from dataclasses import dataclass, field

M_TO_IN = 39.37007874

VALIDATORS = [
    "usdUtilsValidators:UsdzPackageValidator",
    "usdUtilsValidators:PackageEncapsulationValidator",
    "usdUtilsValidators:RootPackageValidator",
    "usdUtilsValidators:MissingReferenceValidator",
    "usdUtilsValidators:FileExtensionValidator",
    "usdGeomValidators:StageMetadataChecker",
    "usdValidation:CompositionErrorTest",
    "usdShadeValidators:MaterialBindingRelationships",
    "usdShadeValidators:EncapsulationRulesValidator",
    "usdShadeValidators:NormalMapTextureValidator",
]


@dataclass
class UsdReport:
    ok: bool
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    size_in: tuple[float, float, float] = (0.0, 0.0, 0.0)   # W (x), H (y), D (z)
    base_y_in: float = 0.0
    center_xz_in: tuple[float, float] = (0.0, 0.0)
    textures: list[str] = field(default_factory=list)
    metallic_values: list[float] = field(default_factory=list)
    materials: int = 0
    meshes: int = 0
    bytes: int = 0


def validate_usdz(data: bytes, *, expect_w_in: float | None = None, expect_d_in: float | None = None,
                  expect_h_in: float | None = None, tol_in: float = 0.5, max_mb: float = 15.0,
                  require_texture: bool = False) -> UsdReport:
    from pxr import Usd, UsdGeom, UsdShade, UsdValidation

    rep = UsdReport(ok=False, bytes=len(data))
    if len(data) > max_mb * 1024 * 1024:
        rep.errors.append(f"file is {len(data) / 1048576:.1f} MB, over the {max_mb:.0f} MB limit")

    fd, path = tempfile.mkstemp(suffix=".usdz")
    os.close(fd)
    stage = None
    try:
        with open(path, "wb") as f:
            f.write(data)
        try:
            with zipfile.ZipFile(path) as z:
                names = z.namelist()
                if not names or not names[0].lower().endswith((".usda", ".usdc", ".usd")):
                    rep.errors.append("first file in the package is not a USD layer")
                rep.textures = [n for n in names if n.lower().endswith((".png", ".jpg", ".jpeg"))]
                for info in z.infolist():
                    if info.compress_type != zipfile.ZIP_STORED:
                        rep.errors.append(f"{info.filename} is compressed (USDZ must be stored, not deflated)")
        except zipfile.BadZipFile:
            rep.errors.append("not a zip package")
            return rep

        try:
            stage = Usd.Stage.Open(path)
        except Exception as e:  # noqa: BLE001 - pxr raises Tf.ErrorException on unreadable packages
            rep.errors.append(f"usd-core could not open the stage: {str(e).strip().splitlines()[-1][:160]}")
            return rep
        if not stage:
            rep.errors.append("usd-core could not open the stage")
            return rep
        if not stage.GetDefaultPrim():
            rep.errors.append("stage has no defaultPrim")

        # --- pxr.UsdValidation
        reg = UsdValidation.ValidationRegistry()
        validators = [v for v in (reg.GetOrLoadValidatorByName(n) for n in VALIDATORS) if v]
        if not validators:
            rep.errors.append("no USD validators could be loaded")
        else:
            ctx = UsdValidation.ValidationContext(validators)
            for err in ctx.Validate(stage):
                msg = f"{err.GetName() if hasattr(err, 'GetName') else ''}: {err.GetMessage()}".strip(": ")
                if err.GetType() == UsdValidation.ValidationErrorType.Error:
                    rep.errors.append(msg)
                else:
                    rep.warnings.append(msg)

        # --- geometry
        mpu = UsdGeom.GetStageMetersPerUnit(stage) or 1.0
        if UsdGeom.GetStageUpAxis(stage) != UsdGeom.Tokens.y:
            rep.errors.append(f"upAxis is {UsdGeom.GetStageUpAxis(stage)}, expected Y")
        cache = UsdGeom.BBoxCache(Usd.TimeCode.Default(), [UsdGeom.Tokens.default_, UsdGeom.Tokens.render])
        rng = cache.ComputeWorldBound(stage.GetPseudoRoot()).ComputeAlignedRange()
        if rng.IsEmpty():
            rep.errors.append("stage has an empty bounding box (no geometry)")
        else:
            mn, mx = rng.GetMin(), rng.GetMax()
            k = mpu * M_TO_IN
            rep.size_in = ((mx[0] - mn[0]) * k, (mx[1] - mn[1]) * k, (mx[2] - mn[2]) * k)
            rep.base_y_in = mn[1] * k
            rep.center_xz_in = ((mn[0] + mx[0]) / 2 * k, (mn[2] + mx[2]) / 2 * k)
            for label, got, want in (("W", rep.size_in[0], expect_w_in), ("H", rep.size_in[1], expect_h_in),
                                     ("D", rep.size_in[2], expect_d_in)):
                if want is not None and abs(got - want) > tol_in:
                    rep.errors.append(f"{label} is {got:.2f} in, expected {want:.2f} in (tolerance {tol_in} in)")
            if expect_h_in is not None:   # single items only: sets are checked by their own caller
                if abs(rep.base_y_in) > 0.05:
                    rep.errors.append(f"base is at y = {rep.base_y_in:.2f} in, expected 0")

        # --- materials
        used_textures: set[str] = set()
        for prim in stage.Traverse():
            if prim.IsA(UsdGeom.Mesh):
                rep.meshes += 1
            if prim.IsA(UsdShade.Material):
                rep.materials += 1
            if prim.IsA(UsdShade.Shader):
                sh = UsdShade.Shader(prim)
                inp = sh.GetInput("metallic")
                if inp and inp.Get() is not None and not inp.HasConnectedSource():
                    rep.metallic_values.append(float(inp.Get()))
                elif inp and inp.HasConnectedSource():
                    rep.errors.append(f"{prim.GetPath()}: metallic is driven by a texture (must be 0)")
                f_in = sh.GetInput("file")
                if f_in and f_in.Get() is not None:
                    used_textures.add(os.path.basename(str(f_in.Get().path)))
        if rep.meshes == 0:
            rep.errors.append("no meshes in the stage")
        for v in rep.metallic_values:
            if v > 1e-6:
                rep.errors.append(f"metallic = {v} (must be 0: glTF's default of 1 renders black in AR)")
                break
        packaged = {os.path.basename(t) for t in rep.textures}
        for t in used_textures - packaged:
            rep.errors.append(f"material references texture {t} that is not in the package")
        if require_texture and not rep.textures:
            rep.errors.append("no texture in the package")
    finally:
        stage = None
        try:
            os.remove(path)
        except OSError:
            pass  # Windows can keep the file mapped for a moment; the temp dir gets cleaned later
    rep.ok = not rep.errors
    return rep
