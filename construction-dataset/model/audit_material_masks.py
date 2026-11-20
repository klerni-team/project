"""Count training and validation mask support and export train-only review examples."""
from collections import Counter
import csv
import hashlib
import io
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from mixed_release_data import registry, pairs
from train_dms import LABELS, IDS

out = Path("material-review")
out.mkdir()
pilot = set(json.loads(Path("pilot/split.json").read_text())["train"])
assert len(pilot) == 10000
tags, rows, releases = registry(Path("construction-dataset/model/iteration-policy.json"), Path("registry"))
expected = {str(r["id"]) for r in rows if r["training_eligible"] or r["split"] == "validation" and r["evaluation_eligible"]}
assert pilot <= {str(r["id"]) for r in rows if r["training_eligible"]}
seen = set()
counts = Counter()
examples = {label: [] for label in LABELS[:-1]}
for tag, folder, packs, group in releases:
    selected = [r for r in group if str(r["id"]) in expected]
    for row, jpg, png in pairs([(tag, folder, packs, selected)]):
        key = str(row["id"])
        assert key in expected and key not in seen
        seen.add(key)
        with Image.open(io.BytesIO(png)) as mask:
            assert mask.size == (row["width"], row["height"])
            raw = np.asarray(mask)
            small = np.asarray(mask.resize((64,64), Image.Resampling.NEAREST))
            assert raw.ndim == 2 and raw.max() <= 56
            native_counts = np.bincount(raw.ravel(), minlength=57)
            grid_counts = np.bincount(small.ravel(), minlength=57)
            for label, idx in zip(LABELS, IDS):
                native, grid = int(native_counts[idx]), int(grid_counts[idx])
                if not native:
                    continue
                for split in ([row["split"], "pilot10k"] if key in pilot else [row["split"]]):
                    for metric, value in (("positive_original", 1), ("positive_grid", int(grid>0)), ("pixels_grid", grid), ("lost_on_grid", int(grid==0))):
                        counts[(label, split, metric)] += value
                if row["split"] != "train":
                    continue
                rank = hashlib.sha256((label+key).encode()).hexdigest()
                pool = examples[label]
                if len(pool) >= 12 and rank >= pool[-1][0]:
                    continue
                # Side-by-side original and binary overlay for human inspection.
                with Image.open(io.BytesIO(jpg)) as source:
                    assert source.size == mask.size
                    photo = source.convert("RGB")
                    photo.thumbnail((384,288))
                region = Image.fromarray((np.asarray(mask.resize(photo.size, Image.Resampling.NEAREST)) == idx).astype("uint8")*128)
                overlay = Image.composite(Image.new("RGB",photo.size,"magenta"), photo, region)
                card = Image.new("RGB",(2*photo.width,photo.height+24),"white")
                card.paste(photo); card.paste(overlay,(photo.width,0))
                ImageDraw.Draw(card).text((3,photo.height+3), f"{label} | {key}", fill="black")
                dest = out / label
                dest.mkdir(exist_ok=True)
                path = dest / (rank+".jpg")
                card.save(path,quality=88)
                if len(pool)==12:
                    old = pool.pop()
                    (out / old[1]["preview"]).unlink()
                pool.append((rank,dict(preview=str(path.relative_to(out)),id=key,label=label,release=tag,
                                       image_path=row["image_path"],mask_path=row["mask_path"],author=row.get("author"),
                                       source=row.get("original_page"),photo_license=row.get("image_license"),
                                       mask_license=row.get("annotation_license"),original_positive_pixels=native,
                                       positive_pixels_64=grid,review_status="pending")))
                pool.sort(key=lambda x:x[0])
    print("AUDITED",tag,len(seen),flush=True)
assert seen == expected
with (out/"coverage.csv").open("w") as handle:
    writer=csv.writer(handle)
    fields=["positive_original","positive_grid","pixels_grid","lost_on_grid"]
    writer.writerow(["material","split",*fields])
    for label in LABELS[:-1]:
        for split in ("train","pilot10k","validation"):
            writer.writerow([label,split,*[counts[label,split,k] for k in fields]])
(out/"review.json").write_text(json.dumps([r for pool in examples.values() for _,r in pool],indent=2))
