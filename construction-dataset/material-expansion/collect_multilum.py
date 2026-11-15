"""Import one original Multi-Illumination image per training scene."""
import argparse
from collections import Counter
import hashlib
import io
import json
from pathlib import Path
import re
from urllib.request import urlopen
from zipfile import BadZipFile, ZipFile

import numpy as np
from PIL import Image
from scipy.fft import dctn

from collect_opensurfaces import package

SITE = "https://projects.csail.mit.edu/illumination/"
BASE = "https://data.csail.mit.edu/multilum"
AUTHORS = "Lukas Murmann, Michael Gharbi, Miika Aittala, and Fredo Durand"
# Source palette IDs as used by the authors' SDK and documented in the
# locuslab/perturbation_learning dataset loader. Unmapped pixels are ignored.
LABELS = {4: 7, 5: 10, 6: 11, 8: 13, 12: 20, 17: 26, 18: 27,
          20: 29, 22: 33, 23: 34, 24: 35, 27: 46, 29: 47,
          32: 52, 35: 5, 36: 3}
LUT = np.zeros(256, np.uint8)
for source, target in LABELS.items():
    LUT[source] = target


def fetch(url):
    with urlopen(url, timeout=40) as stream:
        content = stream.read(25000001)
    if not 0 < len(content) <= 25000000:
        raise ValueError("unexpected download size")
    return content


def collect(scene):
    key = scene["name"]
    image_id = "mitmi-" + key
    base = f"{BASE}/{key}"
    archive_url = f"{base}/{key}_mip2_jpg.zip"
    mask_url = f"{base}/materials_mip2.png"
    try:
        with Image.open(io.BytesIO(fetch(mask_url))) as original_mask:
            if original_mask.mode != "P" or original_mask.size != (1500, 1000):
                raise ValueError("unexpected source mask encoding or dimensions")
            raw_mask = np.asarray(original_mask)
            if raw_mask.max() > 40:
                raise ValueError("unexpected source material ID")
            mask = Image.fromarray(LUT[raw_mask])
        if not np.any(np.asarray(mask.resize((64, 64), Image.Resampling.NEAREST))):
            raise ValueError("no compatible pixels at 64×64")
        with ZipFile(io.BytesIO(fetch(archive_url))) as archive:
            photo_bytes = archive.read(f"{key}/dir_14_mip2.jpg")
        with Image.open(io.BytesIO(photo_bytes)) as photo:
            if photo.size != mask.size or photo.getexif().get(274, 1) != 1:
                raise ValueError("source photo dimensions or orientation mismatch")
            luminance = np.asarray(photo.convert("L").resize((32, 32)), dtype=float)
        low_freq = dctn(luminance, norm="ortho")[:8, :8].flatten()[1:]
        phash = sum(int(v) << i for i, v in enumerate(low_freq > np.median(low_freq)))
        encoded_mask = io.BytesIO()
        mask.save(encoded_mask, format="PNG")
        mask_bytes = encoded_mask.getvalue()
        row = {
            "id": image_id, "source_image_id": image_id,
            "source": "Multi-Illumination Dataset", "scene": key,
            "room": scene["room"], "building": scene["building"], "room_type": scene["room_type"],
            "split": "train", "training_eligible": True, "evaluation_eligible": False,
            "image_path": f"photos/{image_id}.jpg", "mask_path": f"masks/{image_id}.png",
            "width": 1500, "height": 1000, "phash63": str(phash),
            "image_sha256": hashlib.sha256(photo_bytes).hexdigest(),
            "mask_sha256": hashlib.sha256(mask_bytes).hexdigest(),
            "download_url": archive_url, "original_mask_url": mask_url,
            "original_page": SITE, "author": AUTHORS,
            "image_license": "CC BY (version unspecified by source)",
            "annotation_license": "CC BY (version unspecified by source)",
            "license_evidence": SITE,
            "changes": "Original JPEG; separate material mask remapped to compatible DMS classes."
        }
        return {"id": image_id, "status": "verified_pair"}, row, photo_bytes, mask_bytes
    except (OSError, ValueError, KeyError, BadZipFile) as error:
        return {"id": image_id, "status": "download_or_alignment_failed", "reason": str(error)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scenes", type=Path)
    parser.add_argument("--prior-manifest", type=Path, action="append", required=True)
    args = parser.parse_args()
    rows = json.loads(args.scenes.read_text())
    candidates, excluded = [], Counter()
    names = set()
    for scene in rows:
        name = scene["name"]
        if not re.fullmatch(r"[A-Za-z0-9_-]+", name) or name in names:
            raise ValueError(f"invalid or duplicate scene name: {name}")
        names.add(name)
        if name.startswith("everett"):
            excluded["source_test_split"] += 1
        elif "revisit" in name.casefold():
            excluded["explicit_revisit"] += 1
        else:
            candidates.append(scene)
    package(candidates, excluded, args.prior_manifest, worker=collect,
            source="Multi-Illumination Dataset", slug="multilum", mapping=LABELS,
            limitations=["One original lighting capture per scene. Official test scenes and named revisits excluded.",
                         "Only compatible material categories are used. Unmapped categories are ignored."],
            attribution=f"A Dataset of Multi-Illumination Images in the Wild (ICCV 2019) by {AUTHORS}.\n"
                        f"Photos and source masks: CC BY per dataset site. {SITE}\n"
                        "The separate masks were remapped to compatible DMS IDs.\n")


if __name__ == "__main__":
    main()
