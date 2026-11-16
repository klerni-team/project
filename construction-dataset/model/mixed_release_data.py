"""Read verified release manifests and stream aligned training pairs one archive at a time."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile


def download(tag, asset, folder):
    subprocess.run(
        ["gh", "release", "download", tag, "--pattern", asset, "--dir", str(folder)],
        check=True,
    )
    return folder / asset


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def registry(policy_path, workspace):
    policy = json.loads(policy_path.read_text())
    tags = policy["state"]["release_tags"]
    if len(tags) != len(set(tags)) or not all(re.fullmatch(r"materials-[a-z0-9-]+", tag) for tag in tags):
        raise ValueError("Invalid or repeated release tags")
    releases = []
    rows = []
    for tag in tags:
        folder = workspace / tag
        folder.mkdir(parents=True, exist_ok=True)
        checks = {}
        for line in download(tag, "SHA256SUMS", folder).read_text().splitlines():
            expected, name = line.split()
            if not re.fullmatch(r"[0-9a-f]{64}", expected) or name in checks:
                raise ValueError(f"Invalid checksum list for {tag}")
            checks[name] = expected
        path = download(tag, "manifest.jsonl", folder)
        if digest(path) != checks["manifest.jsonl"]:
            raise ValueError(f"Manifest checksum failed for {tag}")
        selected = []
        for line in path.open():
            row = json.loads(line)
            split = row["split"]
            if split not in ("train", "validation", "test"):
                raise ValueError(f"Unexpected split in {tag}")
            if row["training_eligible"] and split != "train" or row["evaluation_eligible"] and split == "train":
                raise ValueError(f"Eligibility disagrees with split in {tag}")
            if row["training_eligible"] or row["evaluation_eligible"]:
                selected.append(row)
        packs = {key: val for key, val in checks.items() if re.fullmatch(r"materials-[a-z0-9-]+\.tar\.gz", key)}
        if not packs or not selected:
            raise ValueError(f"No paired imagery in {tag}")
        releases.append((tag, folder, packs, selected))
        rows.extend(selected)
    if sum(r["split"] == "train" for r in rows) != policy["state"]["known_training_eligible"]:
        raise ValueError("Train count disagrees with the verified corpus count")
    for field in ("id", "source_image_id", "image_sha256", "image_path", "mask_path"):
        values = [str(row[field]) for row in rows]
        if len(values) != len(set(values)):
            raise ValueError(f"Repeated {field} across selected releases")
    return tags, rows, releases


def pairs(releases):
    for tag, folder, packs, rows in releases:
        by_path = {}
        for row in rows:
            by_path[row["image_path"]] = (row, "image")
            by_path[row["mask_path"]] = (row, "mask")
        seen = set()
        pending = {}
        for name, expected in sorted(packs.items()):
            with tempfile.TemporaryDirectory(dir=folder) as temp:
                bundle = download(tag, name, Path(temp))
                if digest(bundle) != expected:
                    raise ValueError(f"Checksum failed: {tag}/{name}")
                with tarfile.open(bundle, "r|gz") as archive:
                    for member in archive:
                        if member.name not in by_path:
                            continue
                        if member.name in seen or not member.isfile() or member.size > 50_000_000:
                            raise ValueError(f"Invalid or repeated archive member: {member.name}")
                        seen.add(member.name)
                        row, kind = by_path[member.name]
                        content = archive.extractfile(member).read()
                        expected_file = row["image_sha256" if kind == "image" else "mask_sha256"]
                        if hashlib.sha256(content).hexdigest() != expected_file:
                            raise ValueError(f"Photo or mask checksum failed: {tag}/{member.name}")
                        item = pending.setdefault(row["id"], {})
                        item[kind] = content
                        if len(item) == 2:
                            del pending[row["id"]]
                            yield row, item["image"], item["mask"]
                if pending:
                    raise ValueError(f"Photo and mask separated or missing in {tag}/{name}")
            print(f"ARCHIVE {tag}/{name}: {len(seen)//2}/{len(rows)} pairs", flush=True)
        if len(seen) != len(by_path):
            raise ValueError(f"Missing {len(by_path)-len(seen)} files in {tag}")
