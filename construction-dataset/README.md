# Construction interior dataset

Current manifest: 5,146 images. Target of 50,000 has not been reached.

Sources: 2,812 OpenSurfaces images, 99 visually reviewed COCO validation images, 2,231 automatically selected COCO training candidates, and 4 Wikimedia Commons images. Annotations are partial. Only two images explicitly mark visible fixed wiring; plaster coverage remains unverified.

The manifest records image sources, licenses, authors where known, SHA-256 hashes, material and surface labels, observed colors, polygons and mask paths. COCO training candidates need visual and author review. For 99 COCO validation images, the Flickr audit found 68 matching author/license records, 28 unavailable pages and 3 license differences. OpenSurfaces rights information is from its original release metadata. Wikimedia licenses were checked on their file pages.

## Files

- `manifest-parts/`: ordered binary parts of the complete annotations ZIP.
- `restore.py`: assembles the ZIP, restores original source photos and masks, verifies hashes, and packages verified bytes with status reports.
- `DOWNLOADS.md`: links to the existing image archives saved in ChatGPT. Those links require the owner's account.

Run `python -m pip install Pillow==13.0.0 numpy` and `python restore.py`. Failed downloads and byte mismatches remain visible in the reports. The GitHub Actions job publishes a release archive and a summary of verified counts.

## Attribution

OpenSurfaces: Sean Bell, Paul Upchurch, Noah Snavely, Kavita Bala, SIGGRAPH 2013. https://opensurfaces.cs.cornell.edu/publications/opensurfaces/

COCO-Stuff: Holger Caesar, Jasper Uijlings, Vittorio Ferrari, CVPR 2018. https://github.com/nightrome/cocostuff

Source annotations: CC BY 4.0. Image licenses are recorded per image in the manifest. Alterations and original image authors are recorded where available. Observed colors depend on lighting and are not paint manufacturer codes.
