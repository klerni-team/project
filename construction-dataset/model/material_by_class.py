"""Index real material masks and fit independent one-vs-rest heads on verified pixels."""
import argparse
import hashlib
import heapq
from collections import Counter
import io
import json
from pathlib import Path
import random

import numpy as np
from PIL import Image
import torch
from torch.nn import functional as F
from safetensors.torch import load_file, save_file

from mixed_release_data import registry, pairs
from train_dms import LABELS, IDS, MaterialHead, load_feature_shards

NAMES = LABELS[:-1]
POLICY = Path("construction-dataset/model/iteration-policy.json")


def dump(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2))


def index(out, rows, releases):
    counts = Counter()
    seen = set()
    examples = {label: [] for label in NAMES}
    for label in NAMES:
        (out / "photos" / label).mkdir(parents=True)
    expected = {str(row["id"]) for row in rows if row["training_eligible"]}
    for tag, folder, packs, release_rows in releases:
        eligible = [r for r in release_rows if r["training_eligible"] and r["split"] == "train"]
        for name, checksum in sorted(packs.items()):
            # A one-archive shard may contain only some of the release's rows.
            for row, jpg, png in pairs([(tag, folder, {name: checksum}, eligible)], 0, 2):
                key = str(row["id"])
                if key in seen:
                    raise ValueError(f"Repeated photo {key}")
                seen.add(key)
                with Image.open(io.BytesIO(png)) as mask:
                    raw = np.asarray(mask)
                    if raw.ndim != 2 or mask.size != (row["width"], row["height"]):
                        raise ValueError(f"Unexpected mask geometry for {key}")
                    pixels = np.bincount(raw.ravel(), minlength=57)
                record = dict(row, archive=name, release=tag, archive_sha256=checksum)
                for label, class_id in zip(NAMES, IDS):
                    if pixels[class_id]:
                        counts[label] += 1
                        # Retain actual pairs for download, sampled independently of archive order.
                        score = int.from_bytes(hashlib.sha256((label + key).encode()).digest(), "big")
                        heap = examples[label]
                        dest = out / "photos" / label
                        if len(heap) < 60 or score < -heap[0][0]:
                            if len(heap) == 60:
                                _, removed = heapq.heappop(heap)
                                for ext in (".jpg", ".png", ".json"):
                                    (dest / (removed + ext)).unlink()
                            token = hashlib.sha256(key.encode()).hexdigest()
                            heapq.heappush(heap, (-score, token))
                            (dest / (token+".jpg")).write_bytes(jpg)
                            (dest / (token+".png")).write_bytes(png)
                            dump(dest / (token+".json"),dict(record,class_id=class_id))
                        with (out / (label + ".jsonl")).open("a") as f:
                            f.write(json.dumps(dict(record, class_id=class_id, class_pixels=int(pixels[class_id])))+"\n")
        print("INDEX", tag, len(seen), flush=True)
    if seen != expected:
        raise ValueError("Incomplete training photo inventory")
    dump(out/"coverage.json",dict(inspected=len(seen), photos_with_class=dict(counts), downloadable_example_pairs={k:len(v) for k,v in examples.items()}))


def margin(parent, x):
    with torch.no_grad():
        logits = parent(x)
        values, labels = logits.topk(2, dim=1)
        competitor = torch.where(labels[:, :1] == torch.arange(len(NAMES)), values[:, 1:2], values[:, :1])
        return logits[:, :len(NAMES)] - competitor


def samples(paths):
    for path in paths:
        with np.load(path) as data:
            yield torch.from_numpy(data["x"].astype("float32")), torch.from_numpy(data["y"].astype("int64"))


@torch.no_grad()
def evaluate(parent, adjustment, paths):
    counts = torch.zeros(3, len(NAMES), dtype=torch.long)
    for x, y in samples(paths):
        true = y[:, None] == torch.arange(len(NAMES))
        pred = margin(parent, x) + adjustment(x) > 0
        counts += torch.stack(((pred & true).sum(0), (pred & ~true).sum(0), (~pred & true).sum(0)))
    return counts


def train(out, rows):
    torch.manual_seed(1729)
    torch.set_num_threads(2)
    rng = random.Random(1729)
    groups = {s:[r for r in rows if r["split"]==s] for s in ("train","validation","test")}
    locked = json.loads(Path("resume/split.json").read_text())
    for split, group in groups.items():
        if {str(r["id"]) for r in group} != set(map(str, locked[split])):
            raise ValueError(f"Changed {split} split")
    paths, _, excluded, ids = load_feature_shards(Path("feature-cache"), groups, len(LABELS))
    config = json.loads(Path("resume/adapter_config.json").read_text())
    if config["material_labels"] != LABELS:
        raise ValueError("Parent head label order changed")
    parent = MaterialHead().eval().requires_grad_(False)
    parent.load_state_dict(load_file("resume/material-head.safetensors"))
    layer = torch.nn.Linear(256, len(NAMES))
    torch.nn.init.zeros_(layer.weight)
    torch.nn.init.zeros_(layer.bias)
    opt = torch.optim.AdamW(layer.parameters(), lr=0.00005, weight_decay=0)
    initial = evaluate(parent, layer, paths["validation"])
    best = initial.clone()
    epoch_best = torch.zeros(len(NAMES), dtype=torch.long)
    weights = {k:v.clone() for k,v in layer.state_dict().items()}
    history = []
    for epoch in range(1,7):
        rng.shuffle(paths["train"])
        for x,y in samples(paths["train"]):
            truth = y[:,None] == torch.arange(len(NAMES))
            # Use every observed positive class and a sample of absent classes per photo.
            active = truth.any(0) | (torch.rand(len(NAMES)) < 0.20)
            if not active.any():
                continue
            scores = margin(parent,x) + layer(x)
            loss = F.binary_cross_entropy_with_logits(scores[:,active],truth[:,active].float())
            if not torch.isfinite(loss):
                raise ValueError("Nonfinite loss")
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(layer.parameters(),1)
            opt.step()
        c = evaluate(parent,layer,paths["validation"])
        iou = c[0] / c.sum(0).clamp_min(1)
        better = iou > best[0] / best.sum(0).clamp_min(1)
        best[:,better] = c[:,better]
        epoch_best[better] = epoch
        for key, tensor in layer.state_dict().items():
            weights[key][better] = tensor[better]
        history.append(dict(epoch=epoch,iou=dict(zip(NAMES,iou.tolist()))))
        print("EPOCH",epoch,float(iou.mean()),flush=True)
    layer.load_state_dict(weights)
    if not torch.equal(best,evaluate(parent,layer,paths["validation"])):
        raise ValueError("Reloaded specialists do not reproduce their scores")
    save_file(weights,str(out/"material-specialists.safetensors"))
    records = {}
    for j,label in enumerate(NAMES):
        def metric(m):
            tp,fp,fn = m[:,j].tolist()
            return dict(iou=tp/(tp+fp+fn) if tp+fp+fn else None,tp=tp,fp=fp,fn=fn)
        records[label] = dict(initial=metric(initial),selected=metric(best),epoch=int(epoch_best[j]))
    dump(out/"report.json",dict(classes=records,train=len(paths["train"]),validation=len(paths["validation"]),
         excluded=excluded,test_evaluated=False,base_weight_sha256=config["base_weight_sha256"],
         parent_release="interiors-trained-44258922982",decision="independent positive margins > 0; masks may overlap"))
    dump(out/"history.json",history)
    dump(out/"split.json",{s:[ids[str(p)] for p in seq] for s,seq in paths.items()})
    import matplotlib.pyplot as plt
    fig,ax=plt.subplots(figsize=(9,7))
    ix=np.arange(len(NAMES))
    ax.barh(ix-0.2,[100*records[l]["initial"]["iou"] for l in NAMES],0.4,label="Baseline")
    ax.barh(ix+0.2,[100*records[l]["selected"]["iou"] for l in NAMES],0.4,label="Selected")
    ax.set_yticks(ix,labels=NAMES);ax.set_xlabel("Validation IoU (%)");ax.legend()
    fig.tight_layout();fig.savefig(out/"material-iou.png");plt.close(fig)


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("mode",choices=("index","train"))
    mode=parser.parse_args().mode
    out=Path("material-"+mode)
    out.mkdir()
    _,rows,releases=registry(POLICY,Path("material-registry-"+mode))
    if mode=="index":
        index(out,rows,releases)
    else:
        train(out,rows)
