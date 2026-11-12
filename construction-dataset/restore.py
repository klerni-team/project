"""Restore the published dataset from its per-photo source URLs."""
import concurrent.futures
import hashlib
import io
import json
import shutil
import urllib.request
import zipfile
import tarfile

import numpy as np
from pathlib import Path

from PIL import Image

root = Path(__file__).resolve().parent
archive = root / "interiors-target-manifest-v2.zip"
if not archive.exists():
    with archive.open("wb") as dst:
        for part in sorted((root / "manifest-parts").glob("*.part")):
            with part.open("rb") as src:
                shutil.copyfileobj(src, dst)
with zipfile.ZipFile(archive) as z:
    rows = [json.loads(line) for line in z.read("manifest.jsonl").splitlines()]
    for name in ("manifest.jsonl", "coco-val-rights-audit.jsonl", "scene-review.jsonl", "coco-labels.txt"):
        (root/name).write_bytes(z.read(name))

def download(row):
    path = root/row["path"]
    expected = row["sha256"]
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == expected:
        return {"id":row["id"],"status":"verified"}
    url = row.get("source_url") or row.get("original_url")
    if row.get("source","COCO-Stuff") == "Wikimedia Commons":
        from urllib.parse import quote
        title = row["title"]
        md5 = hashlib.md5(title.encode()).hexdigest()
        url = f"https://upload.wikimedia.org/wikipedia/commons/{md5[0]}/{md5[:2]}/{quote(title)}"
    try:
        request = urllib.request.Request(url,headers={"User-Agent":"ConstructionInteriorDataset/1.0"})
        with urllib.request.urlopen(request,timeout=45) as response:
            data = response.read()
        if row.get("source","COCO-Stuff") == "OpenSurfaces":
            if hashlib.md5(data).hexdigest() != row["source_md5"]:
                raise ValueError("source MD5 mismatch")
            with Image.open(io.BytesIO(data)) as image:
                image = image.convert("RGB")
                image.thumbnail((1280,1280),Image.Resampling.LANCZOS)
                buf = io.BytesIO()
                image.save(buf,format="JPEG",quality=88)
                data = buf.getvalue()
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError("JPEG SHA256 mismatch")
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_bytes(data)
        return {"id":row["id"],"status":"verified"}
    except Exception as exc:
        return {"id":row["id"],"status":"failed","error":str(exc)}

with (root/"download-status.jsonl").open("w",buffering=1) as report:
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        for result in pool.map(download,rows):
            report.write(json.dumps(result)+"\n")
print("Photo download finished. Review download-status.jsonl.")

mask_source = root/"source-masks.zip"
mask_url = "http://calvin.inf.ed.ac.uk/wp-content/uploads/data/cocostuffdataset/stuffthingmaps_trainval2017.zip"
if not mask_source.exists():
    urllib.request.urlretrieve(mask_url, mask_source)
with zipfile.ZipFile(mask_source) as masks, (root/"mask-status.jsonl").open("w",buffering=1) as report:
    for row in rows:
        if not row.get("mask_path"):
            continue
        try:
            split = row.get("source_split","val")
            key = row["id"][5:]
            with Image.open(io.BytesIO(masks.read(f"{split}2017/{key}.png"))) as im:
                pixels = np.asarray(im)
            converted = np.zeros_like(pixels)
            for region in row["regions"]:
                value = region["mask_value"]
                converted[pixels==value-1] = value
            buf = io.BytesIO()
            Image.fromarray(converted).save(buf,format="PNG")
            data = buf.getvalue()
            if hashlib.sha256(data).hexdigest() != row["mask_sha256"]:
                raise ValueError("mask SHA256 mismatch")
            path = root/row["mask_path"]
            path.parent.mkdir(parents=True,exist_ok=True)
            path.write_bytes(data)
            report.write(json.dumps({"id":row["id"],"status":"verified"})+"\n")
        except Exception as exc:
            report.write(json.dumps({"id":row["id"],"status":"failed","error":str(exc)})+"\n")

counts = {}
for report in ("download-status","mask-status"):
    results = [json.loads(line) for line in (root/f"{report}.jsonl").read_text().splitlines()]
    counts[report] = {
        "verified":sum(r["status"]=="verified" for r in results),
        "failed":sum(r["status"]=="failed" for r in results),
    }
(root/"restore-summary.json").write_text(json.dumps(counts,indent=2))
with tarfile.open(root/"interiors-restored.tar.gz","w:gz") as archive:
    for name in ("photos","masks","manifest.jsonl","download-status.jsonl","mask-status.jsonl",
                 "restore-summary.json","coco-val-rights-audit.jsonl","scene-review.jsonl","README.md"):
        if (root/name).exists():
            archive.add(root/name,arcname=name)
print(json.dumps(counts))

