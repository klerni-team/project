"""Audit OpenSurfaces photo candidates and test rasterization on a sample."""
import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
import io
import hashlib
import os
import subprocess
import tarfile
import tempfile
import json
from pathlib import Path
from urllib.parse import quote
from urllib.request import urlopen
from zipfile import ZipFile

import numpy as np
from PIL import Image, ImageDraw, ImageOps
from scipy.fft import dctn


# Values use the DMS source IDs consumed by train_dms.py.
MATERIALS = {
    "Brick": 3, "Carpet/rug": 5, "Ceramic": 7, "Concrete": 10,
    "Cork/corkboard": 11, "Fabric/cloth": 13, "Glass": 20,
    "Metal": 26, "Mirror": 27, "Painted": 29, "Plaster": 29,
    "Plastic - clear": 33, "Plastic - opaque": 34, "Rubber/latex": 35,
    "Tile": 46, "Wallpaper": 47, "Wood": 52, "Wood - natural color": 52,
}
BASE = "https://labelmaterial.s3.amazonaws.com/"
BY_LICENSES = {f"http://creativecommons.org/licenses/by/{v}/" for v in ("2.0", "3.0", "4.0")}


def read_table(archive, name):
    with archive.open(f"opensurfaces/{name}.json") as stream:
        return {row["pk"]: row["fields"] for row in json.load(stream)}


BY_SA_LICENSES = {f"http://creativecommons.org/licenses/by-sa/{v}/" for v in ("2.0", "3.0")}


NC_LICENSES = {
    "http://creativecommons.org/licenses/by-nc/2.0/",
    "http://creativecommons.org/licenses/by-nc-sa/2.0/",
    "http://creativecommons.org/licenses/by-nc-sa/3.0/",
}


def audit(archive, prior_manifests, allowed_licenses=BY_LICENSES):
    prior_flickr = set()
    for manifest in prior_manifests:
        for line in manifest.read_text().splitlines():
            page = json.loads(line).get("original_page", "")
            if "flickr.com/photos/" in page:
                prior_flickr.add(page.rstrip("/").split("/")[-1])
    with ZipFile(archive) as source:
        scenes = read_table(source, "photos.photoscenecategory")
        users = read_table(source, "photos.flickruser")
        licenses = read_table(source, "licenses.license")
        substances = read_table(source, "shapes.shapesubstance")
        shapes = defaultdict(list)
        for key, row in read_table(source, "shapes.materialshape").items():
            substance = substances.get(row["substance"], {})
            material = MATERIALS.get(substance.get("name"))
            if material and not substance["fail"] and row["high_quality"] and not row["special"]:
                shapes[row["photo"]].append((key, material, row["vertices"], row["triangles"]))
        reasons = Counter()
        candidates = []
        for key, photo in sorted(read_table(source, "photos.photo").items()):
            if key not in shapes:
                reasons["no_compatible_material_polygon"] += 1
                continue
            if not photo["scene_category_correct"] or photo["scene_category"] not in scenes or photo["special"] or photo["inappropriate"]:
                reasons["scene_not_eligible"] += 1
                continue
            license_url = licenses.get(photo["license"], {}).get("url")
            username = users.get(photo["flickr_user"], {}).get("username")
            flickr_id = photo["flickr_id"]
            if license_url not in allowed_licenses or not username or not flickr_id:
                reasons["photo_license_or_author"] += 1
                continue
            if flickr_id in prior_flickr:
                reasons["duplicate_flickr_id"] += 1
                continue
            prior_flickr.add(flickr_id)
            if not photo["image_orig"].startswith("photos/"):
                reasons["missing_photo_path"] += 1
                continue
            candidates.append({
                "id": f"os-{key}", "flickr_id": flickr_id, "author": username,
                "source_record": f"https://opensurfaces.cs.cornell.edu/photos/{key}/",
                "image_license": license_url.replace("http:", "https:", 1),
                "annotation_license": "CC-BY-4.0", "scene": scenes[photo["scene_category"]]["name"],
                "original_page": f"https://www.flickr.com/photos/{quote(username, safe='')}/{flickr_id}/",
                "download_url": BASE + quote(photo["image_orig"]), "aspect_ratio": photo["aspect_ratio"],
                "polygons": shapes[key],
            })
    return candidates, reasons


def sample(candidate, include_files=False):
    try:
        with urlopen(candidate["download_url"], timeout=20) as response:
            raw = response.read(25000001)
        if len(raw) > 25000000:
            raise ValueError("photo exceeds 25 MB")
        preserve_original = any(marker in candidate["image_license"] for marker in ("/by-sa/", "/by-nc",))
        with Image.open(io.BytesIO(raw)) as original:
            if preserve_original and (original.format != "JPEG" or original.getexif().get(274, 1) != 1):
                raise ValueError("Licensed original is not a directly usable JPEG")
            photo = ImageOps.exif_transpose(original).convert("RGB")
        w, h = photo.size
        if min(w, h) < 256 or abs(w / h / candidate["aspect_ratio"] - 1) > .01:
            raise ValueError("size or aspect ratio mismatch")
        # Zero is ignored by the DMS trainer. Pixels where labels disagree are ignored as well.
        layers = {}
        for _, label, coordinates, indices in candidate["polygons"]:
            values = [float(v) for v in coordinates.split(",")]
            points = [(int(x * w), int(y * h)) for x, y in zip(values[::2], values[1::2])]
            triangles = [int(i) for i in indices.split(",")]
            layer = layers.setdefault(label, Image.new("1", (w, h)))
            draw = ImageDraw.Draw(layer)
            for offset in range(0, len(triangles), 3):
                draw.polygon([points[i] for i in triangles[offset:offset+3]], fill=1)
        mask = np.zeros((h, w), dtype=np.uint8)
        conflict = np.zeros((h, w), dtype=bool)
        for label, layer in layers.items():
            region = np.asarray(layer)
            conflict |= region & (mask != 0)
            mask[region] = label
        mask[conflict] = 0
        if not np.any(np.asarray(Image.fromarray(mask).resize((64, 64), Image.Resampling.NEAREST))):
            raise ValueError("no compatible pixels at 64×64")
        result = {"id": candidate["id"], "status": "sample_passed", "labeled_pixels": int(np.count_nonzero(mask))}
        if not include_files:
            return result
        jpeg, png = io.BytesIO(), io.BytesIO()
        if preserve_original:
            jpeg.write(raw)
        else:
            photo.save(jpeg, format="JPEG", quality=95)
        Image.fromarray(mask).save(png, format="PNG")
        luminance = np.asarray(photo.convert("L").resize((32, 32)), dtype=float)
        values = dctn(luminance, norm="ortho")[:8, :8].flatten()[1:]
        phash = sum(int(value) << i for i, value in enumerate(values > np.median(values)))
        row = {k: v for k, v in candidate.items() if k not in ("polygons", "aspect_ratio")}
        image_id = row["id"]
        row.update({
            "source": "OpenSurfaces Release 0", "source_image_id": "flickr:" + row["flickr_id"],
            "polygon_ids": [p[0] for p in candidate["polygons"]],
            "split": "train", "training_eligible": True, "evaluation_eligible": False,
            "image_path": f"photos/{image_id}.jpg", "mask_path": f"masks/{image_id}.png",
            "image_sha256": hashlib.sha256(jpeg.getbuffer()).hexdigest(),
            "mask_sha256": hashlib.sha256(png.getbuffer()).hexdigest(),
            "width": w, "height": h, "phash63": str(phash),
            "license_evidence": "Photo license and author from OpenSurfaces Release 0.",
            "changes": ("Original JPEG bytes preserved; annotation triangles rasterized into a separate mask."
                        if preserve_original else
                        "EXIF orientation applied; JPEG re-encoded; material triangles rasterized into a separate mask.")
        })
        return result, row, jpeg.getvalue(), png.getvalue()
    except (OSError, ValueError, IndexError, TypeError) as exc:
        return {"id": candidate["id"], "status": "sample_failed", "reason": str(exc)}


def package(candidates, reasons, manifests, *, worker=None, source="OpenSurfaces Release 0",
            slug="opensurfaces", mapping=MATERIALS, limitations=None, attribution=None, embed_attribution=False, worker_count=12):
    if worker is None:
        worker = lambda row: sample(row, include_files=True)
    if limitations is None:
        limitations = ["Sparse annotated polygons only. Unmapped, conflicting and unlabeled pixels are ignored.",
                       "Image licenses and authors obtained from the official release metadata."]
    tag = os.environ["DATA_RELEASE"]
    bands = defaultdict(list)
    seen_sha = set()

    def index(h):
        for i in range(7):
            bands[i, (h >> (9*i)) & 511].append(h)

    def is_duplicate(h):
        return any((h ^ old).bit_count() <= 6
                   for i in range(7) for old in bands[i, (h >> (9*i)) & 511])

    for path in manifests:
        for line in path.read_text().splitlines():
            row = json.loads(line)
            index(int(row["phash63"]))
            seen_sha.add(row["image_sha256"])
    audit_rows = []
    root = Path(f"{slug}-output")
    root.mkdir()
    shards = []
    with (root / "manifest.jsonl").open("w") as manifest, ThreadPoolExecutor(max_workers=worker_count) as pool:
        for offset in range(0, len(candidates), 128):
            with tempfile.TemporaryDirectory() as tmp:
                pack = Path(tmp) / f"materials-{slug}-{offset // 128 + 1:03d}.tar.gz"
                count = 0
                credits = []
                with tarfile.open(pack, "w:gz", compresslevel=1) as bundle:
                    for outcome in pool.map(worker, candidates[offset:offset+128]):
                        if isinstance(outcome, dict):
                            audit_rows.append(outcome)
                            continue
                        result, row, photo, mask = outcome
                        h = int(row["phash63"])
                        if row["image_sha256"] in seen_sha or is_duplicate(h):
                            audit_rows.append(dict(result, status="excluded_duplicate"))
                            continue
                        seen_sha.add(row["image_sha256"])
                        index(h)
                        for name, data in [(row["image_path"], photo), (row["mask_path"], mask)]:
                            entry = tarfile.TarInfo(name)
                            entry.size = len(data)
                            bundle.addfile(entry, io.BytesIO(data))
                        manifest.write(json.dumps(row) + "\n")
                        audit_rows.append(dict(result, status="accepted_train"))
                        count += 1
                        if embed_attribution:
                            credits.append(row)
                    if credits:
                        data = ("\n".join(json.dumps(row) for row in credits) + "\n").encode()
                        entry = tarfile.TarInfo(f"attribution/{pack.name}.jsonl")
                        entry.size = len(data)
                        bundle.addfile(entry, io.BytesIO(data))
                if count:
                    with pack.open("rb") as stream:
                        checksum = hashlib.file_digest(stream, "sha256").hexdigest()
                    subprocess.run(["gh", "release", "upload", tag, str(pack)], check=True)
                    shards.append({"name": pack.name, "sha256": checksum, "pairs": count})
            print(f"Processed {len(audit_rows)} of {len(candidates)} {source} photos", flush=True)
    status = Counter(r["status"] for r in audit_rows)
    (root / "collection-audit.json").write_text(json.dumps(audit_rows, indent=2))
    report = {
        "source": source, "metadata_candidates": len(candidates),
        "metadata_exclusions": reasons, "status_counts": status, "training_eligible": status["accepted_train"],
        "material_mapping_to_dms_source_ids": mapping, "shards": shards,
        "limitations": limitations
    }
    (root / "collection-report.json").write_text(json.dumps(report, indent=2))
    (root / "ATTRIBUTION.md").write_text(
        attribution or (
        "OpenSurfaces by Sean Bell, Paul Upchurch, Noah Snavely and Kavita Bala. "
        "https://opensurfaces.cs.cornell.edu/publications/opensurfaces/\n"
        "Annotations CC BY 4.0. The manifest records each photo author, original page, license and changes.\n"
        )
    )
    lines = [f'{shard["sha256"]}  {shard["name"]}\n' for shard in shards]
    for path in sorted(root.iterdir()):
        lines.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n")
    (root / "SHA256SUMS").write_text("".join(lines))
    if not status["accepted_train"]:
        raise RuntimeError(f"No {source} photos passed collection")
    print(json.dumps(report), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--prior-manifest", type=Path, action="append", default=[])
    parser.add_argument("--publish", action="store_true")
    license_group = parser.add_mutually_exclusive_group()
    license_group.add_argument("--by-sa", action="store_true", help="Select BY-SA photos and preserve original JPEG bytes.")
    license_group.add_argument("--noncommercial", action="store_true",
                               help="Select BY-NC and BY-NC-SA photos for noncommercial research.")
    parser.add_argument("--sample-size", type=int, default=24)
    parser.add_argument("--output", type=Path, default=Path("opensurfaces-inventory.json"))
    args = parser.parse_args()
    licenses = NC_LICENSES if args.noncommercial else BY_SA_LICENSES if args.by_sa else BY_LICENSES
    candidates, reasons = audit(args.archive, args.prior_manifest, allowed_licenses=licenses)
    print(f"Found {len(candidates)} metadata candidates", flush=True)
    if args.publish:
        if args.noncommercial:
            package(candidates, reasons, args.prior_manifest, source="OpenSurfaces Release 0 (noncommercial photos)",
                    slug="opensurfaces-nc", embed_attribution=True,
                    limitations=["Noncommercial research photos. Each photo retains its own CC license.",
                                 "Unmapped, conflicting and unlabeled pixels are ignored.",
                                 "Image license and author come from the official release metadata."],
                    attribution="OpenSurfaces by Sean Bell, Paul Upchurch, Noah Snavely and Kavita Bala.\n"
                                "https://opensurfaces.cs.cornell.edu/publications/opensurfaces/\n"
                                "Original JPEGs retain individual CC BY-NC or CC BY-NC-SA licenses.\n"
                                "Noncommercial research only. Each archive includes credits and license links.\n"
                                "Separate annotations: CC BY 4.0.\n")
        elif args.by_sa:
            package(candidates, reasons, args.prior_manifest, source="OpenSurfaces Release 0 (CC BY-SA photos)",
                    slug="opensurfaces-sa", embed_attribution=True,
                    attribution="OpenSurfaces by Sean Bell, Paul Upchurch, Noah Snavely and Kavita Bala.\n"
                                "https://opensurfaces.cs.cornell.edu/publications/opensurfaces/\n"
                                "Photo files are unchanged and retain their individual CC BY-SA licenses.\n"
                                "Each archive includes photo credits and license links. Separate annotations: CC BY 4.0.\n")
        else:
            package(candidates, reasons, args.prior_manifest)
        return
    import random
    subset = random.Random(42).sample(candidates, min(args.sample_size, len(candidates)))
    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(sample, subset))
    report = {
        "source": "OpenSurfaces Release 0", "unique_metadata_candidates": len(candidates),
        "metadata_exclusions": reasons, "sample_status": Counter(r["status"] for r in results),
        "sample_results": results, "material_mapping_to_dms_source_ids": MATERIALS,
        "training_eligible_count": None,
        "remaining_checks": "Full download, perceptual deduplication against all splits, mask and rights audit."
    }
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "sample_results"}, indent=2))


if __name__ == "__main__":
    main()
