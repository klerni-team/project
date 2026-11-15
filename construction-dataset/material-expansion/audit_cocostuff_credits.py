"""Audit original Flickr author and license on a reproducible COCO-Stuff pilot."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
import json
from pathlib import Path
import random
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

ALPHABET = "123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"


class StructuredData(HTMLParser):
    def __init__(self):
        super().__init__()
        self.chunks = None
        self.documents = []

    def handle_starttag(self, tag, attrs):
        if tag == "script" and dict(attrs).get("type") == "application/ld+json":
            self.chunks = []

    def handle_endtag(self, tag):
        if tag == "script" and self.chunks is not None:
            try:
                self.documents.append(json.loads("".join(self.chunks)))
            except ValueError:
                pass
            self.chunks = None

    def handle_data(self, data):
        if self.chunks is not None:
            self.chunks.append(data)


def short_url(photo_id):
    encoded = []
    value = int(photo_id)
    while value:
        value, digit = divmod(value, 58)
        encoded.append(ALPHABET[digit])
    return "https://flic.kr/p/" + "".join(reversed(encoded))


def nodes(value):
    if isinstance(value, dict):
        yield value
        yield from nodes(value.get("@graph"))
    elif isinstance(value, list):
        for child in value:
            yield from nodes(child)


def original_credit(row):
    photo_id = row["flickr_photo_id"]
    try:
        url = short_url(photo_id)
        request = Request(url, headers={"User-Agent": "InteriorDatasetResearch/1.0"})
        with urlopen(request, timeout=18) as response:
            page = response.url
            parsed = urlsplit(page)
            if parsed.hostname not in ("flickr.com", "www.flickr.com") or parsed.path.rstrip("/").split("/")[-1] != photo_id:
                raise ValueError("original photo page could not be verified")
            html = response.read(3_000_001)
            if len(html) > 3_000_000:
                raise ValueError("oversize original page")
        parser = StructuredData()
        parser.feed(html.decode("utf-8", "replace"))
        for document in parser.documents:
            for item in nodes(document):
                if item.get("@type") != "ImageObject":
                    continue
                if urlsplit(item.get("acquireLicensePage", "")).path.rstrip("/").split("/")[-1] != photo_id:
                    continue
                license_url = item.get("license", "")
                if license_url.replace("https:", "http:", 1) != row["image_license_from_coco"]:
                    return {"id": row["id"], "status": "license_mismatch"}
                author = item.get("author", {})
                if not isinstance(author, dict) or not author.get("name"):
                    return {"id": row["id"], "status": "missing_author"}
                return {"id": row["id"], "status": "original_credit_verified",
                        "original_page": page, "license": license_url, "author": author["name"],
                        "author_url": author.get("url")}
        raise ValueError("no matching structured license on original page")
    except (ValueError, OSError) as error:
        return {"id": row["id"], "status": "original_page_unverified", "error": str(error)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("candidates", type=Path)
    parser.add_argument("--size", type=int, default=32)
    args = parser.parse_args()
    rows = [json.loads(line) for line in args.candidates.read_text().splitlines()]
    subset = random.Random(42).sample(rows, min(args.size, len(rows)))
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(original_credit, subset))
    output = {"sample_size": len(results), "counts": Counter(row["status"] for row in results),
              "training_eligible": 0, "results": results}
    args.candidates.with_name("rights-pilot.json").write_text(json.dumps(output, indent=2) + "\n")
    print(json.dumps(output["counts"]), flush=True)


if __name__ == "__main__":
    main()
