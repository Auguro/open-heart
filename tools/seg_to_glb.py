"""Turn a labelled whole-heart segmentation (NIfTI) into a GLB with one mesh per structure.

It reads the ImageCAS whole-heart labels (STACOM 2025, cardiac CT), which include the real heart muscle and the
coronary arteries. The model is turned into the textbook anterior pose (base-to-apex axis pointing down and to the
viewer's right).

Usage: python seg_to_glb.py <seg.nii.gz> <out.glb>
"""
import argparse

import nibabel as nib
import numpy as np
import trimesh
from scipy.ndimage import distance_transform_edt, gaussian_filter
from skimage.measure import marching_cubes

FACES = 15000  # max triangles per structure (the wall gets twice as many): detailed, yet light for the glasses
SIGMA = 1.2  # smoothing in voxels before meshing
WALL_SIGMA = 2.0  # the wall is lumpy where grown chambers meet, so it gets more


def srgb(r, g, b):
    """Colour as seen on screen -> glTF baseColorFactor, which is linear (screen values would come out pale)."""
    return tuple(round(255 * (c / 255) ** 2.2) for c in (r, g, b)) + (255,)


# Node name -> (label values, colour). Textbook colours: red where blood is oxygen-rich, blue where it is oxygen-poor,
# and the coronary arteries ivory as in contrast CT renderings. Kept bright, because the glasses' see-through display
# cannot show dark colours: they turn transparent.
PARTS = {
    "LeftAtrium": ((2, 8), srgb(235, 105, 95)),  # 8, the left atrial appendage, belongs to the left atrium
    "LeftVentricle": ((3,), srgb(225, 70, 62)),
    "RightAtrium": ((4,), srgb(100, 145, 235)),
    "RightVentricle": ((5,), srgb(70, 120, 225)),
    "Aorta": ((6,), srgb(230, 60, 55)),
    "PulmonaryArtery": ((7,), srgb(60, 110, 225)),
    "CoronaryArteries": ((9,), srgb(245, 230, 195)),
    "PulmonaryVeins": ((10,), srgb(240, 115, 105)),
}

# The muscle wall: the labelled myocardium around the left ventricle, plus the other chambers grown by a typical
# adult wall thickness (mm). That part is approximate, so the Lens calls the wall approximate.
MUSCLE = 1
WALL_MM = {2: 2.5, 4: 2.5, 5: 3.5, 8: 2.5}
WALL = ("HeartWall", srgb(215, 95, 85))

# NIfTI world space is RAS in mm; glTF is Y-up, +Z towards the viewer, in metres.
# So glTF X = patient's left, Y = superior, Z = anterior (the heart faces the viewer).
RAS_TO_GLTF = np.array([[-1, 0, 0], [0, 0, 1], [0, 1, 0]]) / 1000.0
APEX_DIRECTION = np.array([0.42, -0.85, 0.32])  # textbook anterior view: apex down, to the viewer's right, forward


def surface(mask, voxel_to_model, faces, sigma=SIGMA):
    idx = np.argwhere(mask)
    lo, hi = np.maximum(idx.min(0) - 3, 0), idx.max(0) + 4  # pad so the surface closes
    crop = gaussian_filter(mask[lo[0]:hi[0], lo[1]:hi[1], lo[2]:hi[2]].astype(np.float32), sigma)
    verts, tris, _, _ = marching_cubes(crop, level=0.5)
    mesh = trimesh.Trimesh(nib.affines.apply_affine(voxel_to_model, verts + lo), tris)
    if mesh.volume < 0:  # the scan's axes may be mirrored; faces must point outward for hand-ray hits
        mesh.invert()  # checked while the mesh is still closed, so the sign is reliable
    trimesh.smoothing.filter_taubin(mesh, iterations=50)  # removes voxel ripples without shrinking
    if len(mesh.faces) > faces:
        mesh = mesh.simplify_quadric_decimation(face_count=faces)
    return mesh


def textbook_pose(seg, affine):
    """Rotation (3x3, glTF space) that points the base-to-apex axis along APEX_DIRECTION."""
    to_gltf = lambda vox: nib.affines.apply_affine(affine, vox) @ RAS_TO_GLTF.T
    atria = np.argwhere(np.isin(seg, [2, 4]))
    lv = np.argwhere(seg == 3)
    if not len(atria) or not len(lv):
        return np.eye(3)  # unusual anatomy: keep the scan's own orientation
    base = to_gltf(atria).mean(axis=0)
    lv = to_gltf(lv)
    apex = lv[np.argmax(np.linalg.norm(lv - base, axis=1))]
    return trimesh.geometry.align_vectors(apex - base, APEX_DIRECTION / np.linalg.norm(APEX_DIRECTION))[:3, :3]


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("seg")
    ap.add_argument("out")
    args = ap.parse_args()

    img = nib.load(args.seg)
    seg = np.asarray(img.dataobj).astype(np.int16)
    zooms = img.header.get_zooms()[:3]
    voxel_to_model = np.eye(4)
    voxel_to_model[:3] = textbook_pose(seg, img.affine) @ RAS_TO_GLTF @ img.affine[:3]

    masks = {name: (np.isin(seg, labels), rgba) for name, (labels, rgba) in PARTS.items()}
    masks = {name: (mask, rgba) for name, (mask, rgba) in masks.items() if mask.any()}
    wall = seg == MUSCLE
    for label, mm in WALL_MM.items():
        if (seg == label).any():
            wall |= distance_transform_edt(seg != label, sampling=zooms) <= mm
    if "CoronaryArteries" in masks:
        wall &= ~masks["CoronaryArteries"][0]  # the arteries run in grooves on the surface, not under it
    masks[WALL[0]] = (wall, WALL[1])

    meshes = {}
    for name, (mask, rgba) in masks.items():
        is_wall = name == WALL[0]
        mesh = surface(mask, voxel_to_model, FACES * (2 if is_wall else 1), WALL_SIGMA if is_wall else SIGMA)
        # glTF defaults to fully metallic; double-sided so the inside shows when you step in
        material = trimesh.visual.material.PBRMaterial(
            name=name, baseColorFactor=rgba, metallicFactor=0.0, roughnessFactor=0.6, doubleSided=True
        )
        mesh.visual = trimesh.visual.TextureVisuals(material=material)
        meshes[name] = mesh

    center = trimesh.util.concatenate(list(meshes.values())).bounds.mean(axis=0)
    scene = trimesh.Scene()
    for name, mesh in meshes.items():
        mesh.apply_translation(-center)  # heart centred on the origin
        scene.add_geometry(mesh, node_name=name, geom_name=name)
        print(f"{name}: {len(mesh.faces)} triangles")
    scene.export(args.out, include_normals=True)  # without normals the surface shades blotchy
    total = sum(len(m.faces) for m in meshes.values())
    print(f"total: {total} triangles, size {scene.extents * 100} cm -> {args.out}")


if __name__ == "__main__":
    main()
