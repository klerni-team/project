"""Collect verified brick pairs and train a binary segmentation specialist on their labels."""
import hashlib
import io
import json
import random
from collections import Counter
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from safetensors.torch import load_file, save_file
from torch import nn
from torch.nn import functional as F

from mixed_release_data import pairs, registry
from train_dms import AutoImageProcessor, MaterialHead, Mask2FormerForUniversalSegmentation, target_mask, LABELS, sha

OUT = Path("brick-results")
PHOTOS = Path("brick-train")
CACHE = Path("brick-cache")
BRICK = LABELS.index("brick")


def write(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2))


def choose_negatives(rows):
    candidates = [r for r in rows if r["split"] == "train" and r["training_eligible"]]
    return {r["id"] for r in random.Random(1729).sample(candidates, min(2400, len(candidates)))}


def prepare():
    _, rows, releases = registry(Path("construction-dataset/model/iteration-policy.json"), Path("registry"))
    locked = json.loads(Path("resume/split.json").read_text())
    for split in ("train", "validation", "test"):
        ids = {r["id"] for r in rows if r["split"] == split}
        if ids != set(locked[split]):
            raise ValueError(f"Changed {split} split")
    if set(locked["train"]) & (set(locked["validation"]) | set(locked["test"])):
        raise ValueError("Training and evaluation overlap")
    negatives = choose_negatives(rows)
    config = json.loads(Path("resume/adapter_config.json").read_text())
    if config["material_labels"] != LABELS or config["base_weight_sha256"] != sha("model-package/model.safetensors"):
        raise ValueError("Parent weights are incompatible")
    base = Mask2FormerForUniversalSegmentation.from_pretrained("model-package",local_files_only=True).eval().requires_grad_(False)
    pixel = base.model.pixel_level_module
    pilot = json.loads(Path("projection/training-report.json").read_text())
    if pilot["base_weight_sha256"] != config["base_weight_sha256"] or pilot["parent_release"] != "interiors-trained-44258922982":
        raise ValueError("Pixel projection is incompatible")
    pixel.decoder.mask_projection.load_state_dict(load_file("projection/mask-projection.safetensors"))
    processor = AutoImageProcessor.from_pretrained("model-package", local_files_only=True, use_fast=False)
    rng = np.random.default_rng(1729)
    groups = {"train": [], "validation": []}
    counts = Counter()
    # Keep fixed test imagery out of selection, training and checkpoint evaluation.
    inventory = [(tag, folder, packs, [r for r in rs if r["split"] != "test"])
                 for tag, folder, packs, rs in releases]
    with (PHOTOS / "manifest.jsonl").open("w") as positives:
        for tag, folder, packs, selected in inventory:
            for row, jpg, png in pairs([(tag, folder, packs, selected)]):
                split = row["split"]
                with Image.open(io.BytesIO(png)) as mask:
                    raw = np.asarray(mask)
                    if raw.ndim != 2 or mask.size != (row["width"], row["height"]):
                        raise ValueError("Unexpected material mask geometry")
                    labeled_brick = bool((raw == 3).any())
                    labels = target_mask(np.asarray(mask.resize((64,64),Image.Resampling.NEAREST))).ravel()
                counts[split+"_inspected"] += 1
                if split == "train" and labeled_brick:
                    name = str(row["id"])
                    if not name.replace("-","").replace("_","").isalnum(): raise ValueError("Unsafe image ID")
                    (PHOTOS / (name+".jpg")).write_bytes(jpg)
                    (PHOTOS / (name+".png")).write_bytes(png)
                    positives.write(json.dumps(dict(row, release=tag, collected_photo=name+".jpg", collected_mask=name+".png"))+"\n")
                    counts["train_positive_original"] += 1
                if split == "train" and not labeled_brick and row["id"] not in negatives:
                    continue
                valid = np.flatnonzero(labels != 255)
                brick = np.flatnonzero(labels == BRICK)
                if not len(valid) or (split=="train" and labeled_brick and not len(brick)):
                    if split == "validation": raise ValueError("Empty locked validation mask")
                    counts["train_omitted_at_64"] += 1
                    continue
                if split == "train" and len(valid)>640:
                    fixed = rng.choice(valid,640,replace=False)
                    valid = np.union1d(fixed,rng.choice(brick,min(128,len(brick)),replace=False))
                with Image.open(io.BytesIO(jpg)) as image:
                    if image.size != (row["width"],row["height"]) or image.getexif().get(274,1)!=1:
                        raise ValueError("Photo and mask alignment mismatch")
                    rgb=image.convert("RGB").resize((256,256),Image.Resampling.BILINEAR)
                with torch.no_grad():
                    x=processor(images=rgb,do_resize=False,return_tensors="pt")["pixel_values"]
                    feats=pixel(x).decoder_last_hidden_state[0].flatten(1).T[valid]
                path=CACHE/(str(row["id"])+".npz")
                np.savez(path,x=feats.numpy().astype(np.float16),y=(labels[valid]==BRICK).astype(np.uint8))
                groups[split].append((row["id"],path))
                counts[split+("_with_brick" if len(brick) else "_without_labeled_brick")] += 1
            print("SOURCE",tag,dict(counts),flush=True)
    if counts["train_inspected"] != len(locked["train"]) or len(groups["validation"]) != len(locked["validation"]):
        raise ValueError("Incomplete coverage")
    write("coverage.json",dict(counts))
    write("split.json",{s:[i for i,_ in g] for s,g in groups.items()})
    return groups


class BrickHead(nn.Module):
    def __init__(self):
        super().__init__()
        self.parent = MaterialHead().eval().requires_grad_(False)
        self.parent.load_state_dict(load_file("resume/material-head.safetensors"))
        self.adjustment=nn.Sequential(nn.LayerNorm(256),nn.Linear(256,96),nn.GELU(),nn.Linear(96,1))
        nn.init.zeros_(self.adjustment[-1].weight)
        nn.init.zeros_(self.adjustment[-1].bias)

    def forward(self,x):
        with torch.no_grad():
            logits=self.parent(x)
            other=torch.cat((logits[:,:BRICK],logits[:,BRICK+1:]),dim=1)
            margin=logits[:,BRICK]-other.max(1).values
        return margin+self.adjustment(x).squeeze(-1)


def items(group):
    for _,path in group:
        with np.load(path) as d:
            yield torch.from_numpy(d["x"].astype(np.float32)),torch.from_numpy(d["y"].astype(np.float32))


@torch.no_grad()
def evaluate(model,group):
    tp=fp=fn=0
    for x,y in items(group):
        pred=model(x)>0
        true=y.bool()
        tp+=int((pred & true).sum())
        fp+=int((pred & ~true).sum())
        fn+=int((~pred & true).sum())
    return dict(iou=tp/max(1,tp+fp+fn),tp=tp,fp=fp,fn=fn)


def main():
    torch.manual_seed(1729)
    torch.set_num_threads(2)
    for folder in (OUT,PHOTOS,CACHE):folder.mkdir()
    groups=prepare()
    head=BrickHead().eval()
    optimizer=torch.optim.AdamW(head.adjustment.parameters(),lr=0.0001)
    best=initial=evaluate(head,groups["validation"])
    epoch_best=0
    target=str(OUT/"brick-adjustment.safetensors")
    save_file(head.adjustment.state_dict(),target)
    history=[]
    for epoch in range(1,9):
        random.Random(1729+epoch).shuffle(groups["train"])
        for x,y in items(groups["train"]):
            optimizer.zero_grad(set_to_none=True)
            loss=F.binary_cross_entropy_with_logits(head(x),y)
            if not torch.isfinite(loss): raise ValueError("Nonfinite loss")
            loss.backward()
            nn.utils.clip_grad_norm_(head.adjustment.parameters(),1)
            optimizer.step()
        scores=evaluate(head,groups["validation"])
        history.append(dict(epoch=epoch,validation=scores))
        if scores["iou"]>best["iou"]:
            best=scores
            epoch_best=epoch
            save_file(head.adjustment.state_dict(),target)
        print("EPOCH",epoch,scores,flush=True)
        write("history.json",history)
    write("report.json",dict(initial=initial,best=best,best_epoch=epoch_best,epochs=len(history),
          target_class="brick",validation_grid=[64,64],threshold_logit=0,external_test_evaluated=False,
          base="interiors-model-43633804001",parent_head="interiors-trained-44258922982",
          projection_artifact=14438615454,train_sources="source masks from locked research corpus",
          excluded_pixels="ignored or unlabeled areas",train_images=len(groups["train"]),
          validation_images=len(groups["validation"])))
    import matplotlib.pyplot as plt
    fig,ax=plt.subplots()
    ax.plot(range(len(history)+1),[100*initial["iou"]]+[100*h["validation"]["iou"] for h in history],marker="o")
    ax.set(xlabel="Epoch",ylabel="Brick validation IoU (%)")
    fig.savefig(OUT/"learning-curves.png")
    plt.close(fig)


if __name__=="__main__":
    main()
