"""Collect COCO-Stuff photo/mask pairs with original Flickr credits."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from functools import partial
import hashlib
import io
import json
from pathlib import Path
import random
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from zipfile import ZipFile

import numpy as np
from PIL import Image, ImageOps
from scipy.fft import dctn

from audit_cocostuff_credits import original_credit
from collect_opensurfaces import package
from inventory_cocostuff import INDOOR_CUES, LUT, MATERIALS, OUTDOOR_CUES

SOURCE = "COCO-Stuff 2017"
ANNOTATIONS = "https://github.com/nightrome/cocostuff"


def validated_mask(row, archive):
    source = archive.read(row["source_mask"])
    if hashlib.sha256(source).hexdigest() != row["source_mask_sha256"]:
        raise ValueError("original mask checksum mismatch")
    with Image.open(io.BytesIO(source)) as mask:
        if mask.size != (row["width"], row["height"]):
            raise ValueError("source mask dimension mismatch")
        pixels = np.asarray(mask)
        if pixels.ndim != 2 or pixels.dtype != np.uint8:
            raise ValueError("unexpected COCO-Stuff mask encoding")
        small = np.asarray(mask.resize((64, 64), Image.Resampling.NEAREST))
    # Verify the interior inference uses structural clues, not merely one movable
    # object. Exterior labels veto a candidate.
    counts = np.bincount(small.reshape(-1), minlength=256)
    strong = {category for category in INDOOR_CUES if counts[category - 1] >= 32}
    ceiling = int(counts[101]) + int(counts[102])
    if (ceiling < 64 and len(strong) < 2) or any(counts[c-1] for c in OUTDOOR_CUES):
        raise ValueError("insufficient interior scene evidence in original labels")
    if np.count_nonzero(LUT[small]) < 32:
        raise ValueError("insufficient compatible pixels on evaluation grid")
    return Image.fromarray(LUT[pixels]), strong


def fetch_photo(row):
    errors = []
    for field in ("flickr_image_url", "image_url"):
        url = row[field].replace("http:", "https:", 1)
        host = urlsplit(url).hostname or ""
        if not (host == "images.cocodataset.org" or host.endswith(".staticflickr.com")):
            continue
        try:
            request = Request(url, headers={"User-Agent": "InteriorDatasetResearch/1.0"})
            with urlopen(request, timeout=15) as response:
                raw = response.read(12_000_001)
            if len(raw) > 12_000_000:
                raise ValueError("photo too large")
            with Image.open(io.BytesIO(raw)) as photo:
                if photo.format != "JPEG" or photo.size != (row["width"], row["height"]):
                    raise ValueError("source photo and COCO mask dimensions or format differ")
                if photo.getexif().get(274, 1) != 1:
                    raise ValueError("source orientation requires manual verification")
                luminance = np.asarray(photo.convert("L").resize((32, 32)), dtype=float)
            return raw, url, luminance
        except (OSError, ValueError) as error:
            errors.append(f"{field}: {error}")
    raise ValueError("; ".join(errors) or "no trusted original photo URL")


def collect(row, archive):
    image_id = row["id"]
    try:
        mask, cues = validated_mask(row, archive)
    except (OSError, ValueError, KeyError) as error:
        return {"id": image_id, "status": "mask_or_scene_excluded", "reason": str(error)}
    rights = original_credit(row)
    if rights["status"] != "original_credit_verified":
        return rights
    try:
        raw, url, luminance = fetch_photo(row)
        freq = dctn(luminance, norm="ortho")[:8, :8].flatten()[1:]
        phash = sum(int(bit) << i for i, bit in enumerate(freq > np.median(freq)))
        buffer = io.BytesIO()
        mask.save(buffer, format="PNG")
        encoded = buffer.getvalue()
        output = {
            "id": image_id, "source_image_id": "flickr:" + row["flickr_photo_id"],
            "source": SOURCE, "coco_image_id": row["coco_image_id"],
            "split": "train", "training_eligible": True, "evaluation_eligible": False,
            "scene_status": "interior inferred from original COCO-Stuff labels",
            "scene_cue_category_ids": sorted(cues),
            "image_path": f"photos/{image_id}.jpg", "mask_path": f"masks/{image_id}.png",
            "width": mask.width, "height": mask.height, "phash63": str(phash),
            "image_sha256": hashlib.sha256(raw).hexdigest(),
            "mask_sha256": hashlib.sha256(encoded).hexdigest(),
            "source_mask_sha256": row["source_mask_sha256"],
            "download_url": url, "original_page": rights["original_page"],
            "author": rights["author"], "author_url": rights["author_url"],
            "image_license": rights["license"], "annotation_license": "CC-BY-4.0",
            "changes": "JPEG bytes unchanged; separate original annotation remapped to compatible material IDs."
        }
        return {"id": image_id, "status": "verified_pair"}, output, raw, encoded
    except (OSError, ValueError) as error:
        return {"id": image_id, "status": "photo_alignment_excluded", "reason": str(error)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("candidates", type=Path)
    parser.add_argument("masks", type=Path)
    parser.add_argument("--prior-manifest", type=Path, action="append", default=[])
    parser.add_argument("--pilot", type=int, default=0)
    args = parser.parse_args()
    candidates = [json.loads(line) for line in args.candidates.read_text().splitlines()]
    with ZipFile(args.masks) as archive:
        worker = partial(collect, archive=archive)
        if args.pilot:
            sample = random.Random(42).sample(candidates, min(args.pilot, len(candidates)))
            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(worker, sample))
            states = Counter(r["status"] if isinstance(r, dict) else r[0]["status"] for r in results)
            print(json.dumps(states), flush=True)
            previews = [r for r in results if not isinstance(r, dict)]
            if previews:
                sheet = Image.new("RGB", (300 * 4, 210 * ((len(previews)+3)//4)), "white")
                for i, (_, _, photo, _) in enumerate(previews):
                    with Image.open(io.BytesIO(photo)) as image:
                        sheet.paste(ImageOps.contain(image, (295, 205)), ((i%4)*300, (i//4)*210))
                sheet.save("coco-interior-pilot.jpg")
            return
        package(candidates, Counter(), args.prior_manifest, worker=worker,
                source=SOURCE, slug="cocostuff", mapping=MATERIALS,
                worker_count=4, embed_attribution=True,
                limitations=["Interior scene inferred from original indoor structure and object labels.",
                             "Only explicit compatible material labels used; all other pixels ignored.",
                             "Photo license confirmed against the original Flickr page; NC photos for noncommercial research only."],
                attribution=f"COCO-Stuff by Holger Caesar, Jasper Uijlings and Vittorio Ferrari. {ANNOTATIONS}\n"
                            "Original source annotations CC BY 4.0. Separate masks remapped to DMS source IDs.\n"
                            "Unchanged photo bytes, with original authors and licenses for each image in the archive.\n")


if __name__ == "__main__":
    main()
