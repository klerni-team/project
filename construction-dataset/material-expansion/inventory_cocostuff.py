"""Inventory COCO-Stuff train candidates with explicit material labels."""
import argparse
from collections import Counter
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
from zipfile import ZipFile

import numpy as np
from PIL import Image

# COCO-Stuff category IDs (PNG value = ID - 1).
# floor-wood is omitted because the source class includes laminate.
MATERIALS = {101: 5, 103: 6, 117: 46, 133: 27, 171: 3, 172: 10, 176: 46, 177: 52}
INDOOR_CUES = {65, 70, 78, 79, 82, 102, 103, 108, 180}
OUTDOOR_CUES = {113, 124, 126, 128, 149, 157, 158, 169}
FLEXIBLE_LICENSES = {
    "http://creativecommons.org/licenses/by/2.0/",
    "http://creativecommons.org/licenses/by-sa/2.0/",
    "http://creativecommons.org/licenses/by-nc/2.0/",
    "http://creativecommons.org/licenses/by-nc-sa/2.0/",
}
FLICKR_ID = re.compile(r"/(\d+)_")
LUT = np.zeros(256, dtype=np.uint8)
for category, material in MATERIALS.items():
    LUT[category - 1] = material


def inventory(masks, metadata, manifests):
    known_flickr = set()
    for path in manifests:
        for line in path.read_text().splitlines():
            row = json.loads(line)
            page = row.get("original_page", "")
            if "flickr.com/photos/" in page:
                known_flickr.add(page.rstrip("/").split("/")[-1])
    licenses = {x["id"]: x["url"] for x in metadata["licenses"]}
    images = {x["id"]: x for x in metadata["images"]}
    counts = Counter()
    classes = Counter()
    candidates = []
    seen = set()
    with ZipFile(masks) as archive:
        for name in archive.namelist():
            path = PurePosixPath(name)
            if path.parent.name != "train2017" or not re.fullmatch(r"\d{12}\.png", path.name):
                continue
            img = images.get(int(path.stem))
            if img is None:
                counts["missing_coco_metadata"] += 1
                continue
            if img["id"] in seen:
                raise ValueError(f"duplicate mask record {img['id']}")
            seen.add(img["id"])
            license_url = licenses.get(img["license"], "").replace("https:", "http:", 1)
            if license_url not in FLEXIBLE_LICENSES:
                counts["license_not_selected"] += 1
                continue
            flickr = FLICKR_ID.search(img.get("flickr_url", ""))
            if not flickr:
                counts["missing_flickr_id"] += 1
                continue
            flickr_id = flickr.group(1)
            if flickr_id in known_flickr:
                counts["already_in_material_manifest"] += 1
                continue
            mask_bytes = archive.read(name)
            with Image.open(io.BytesIO(mask_bytes)) as mask:
                if mask.size != (img["width"], img["height"]):
                    counts["size_mismatch"] += 1
                    continue
                small = np.asarray(mask.resize((64, 64), Image.Resampling.NEAREST))
            if small.ndim != 2:
                counts["unexpected_mask_encoding"] += 1
                continue
            labels = set(map(int, np.unique(small) + np.uint16(1)))
            if not labels.intersection(INDOOR_CUES) or labels.intersection(OUTDOOR_CUES):
                counts["indoor_heuristic_not_met"] += 1
                continue
            compatible = LUT[small]
            supported = {int(v) for v in np.unique(compatible) if v}
            if np.count_nonzero(compatible) < 32:
                counts["insufficient_material_pixels"] += 1
                continue
            known_flickr.add(flickr_id)
            classes.update(supported)
            candidates.append({
                "id": f"cocostuff-{path.stem}", "coco_image_id": img["id"], "flickr_photo_id": flickr_id,
                "image_url": img["coco_url"], "flickr_image_url": img["flickr_url"],
                "image_license_from_coco": license_url, "annotation_license": "CC-BY-4.0",
                "width": img["width"], "height": img["height"], "source_mask": name,
                "source_mask_sha256": hashlib.sha256(mask_bytes).hexdigest(),
                "material_ids": sorted(supported), "status": "candidate",
                "training_eligible": False,
                "pending": ["confirm interior", "recover original author and rights", "verify photo and deduplicate"]
            })
    return candidates, counts, classes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("masks", type=Path)
    parser.add_argument("metadata", type=Path)
    parser.add_argument("--prior-manifest", type=Path, action="append", default=[])
    args = parser.parse_args()
    with args.metadata.open() as file:
        metadata = json.load(file)
    candidates, exclusions, classes = inventory(args.masks, metadata, args.prior_manifest)
    root = Path("cocostuff-inventory")
    root.mkdir(exist_ok=True)
    report = {"source_masks_examined": len(candidates)+sum(exclusions.values()),
              "candidates": len(candidates), "exclusions": exclusions,
              "candidate_images_by_material_id": classes, "mapping": MATERIALS,
              "training_eligible": 0}
    (root / "report.json").write_text(json.dumps(report, indent=2)+"\n")
    with (root / "candidates.jsonl").open("w") as file:
        for row in candidates:
            file.write(json.dumps(row)+"\n")
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
