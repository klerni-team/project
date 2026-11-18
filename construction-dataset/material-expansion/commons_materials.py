"""Download licensed source candidates. Discovery terms are not pixel annotations."""
import concurrent.futures
import hashlib
import io
import json
from pathlib import Path
import re
import time
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen
from PIL import Image

QUERIES={"brick":"brick wall","carpet_or_rug":"carpet","ceiling_tile_unspecified_composition":"ceiling tiles",
"ceramic":"ceramic tiles","concrete":"exposed concrete","cork":"cork floor","engineered_stone":"quartz countertop",
"fabric":"fabric upholstery","fiberglass_wool":"fiberglass insulation","glass":"glass partition","metal":"metal staircase",
"mirror":"mirror","paint_or_plaster_or_enamel":"plastered wall","clear_plastic":"acrylic partition",
"opaque_plastic":"plastic panel","rubber_or_latex":"rubber flooring","natural_stone_unspecified":"stone wall",
"polished_stone_unspecified":"polished marble","tile_unspecified":"floor tiles","wallpaper":"wallpaper","wood":"wood panelling",
"linoleum":"linoleum floor"}
ROOT=Path("new-photo-candidates")
AGENT="InteriorMaterialResearch/1.0 (https://github.com/klerni-team/project)"
def get(url):
    with urlopen(Request(url,headers={"User-Agent":AGENT}),timeout=12) as r:
        return r.read(26000001)
def collect():
    ROOT.mkdir()
    seen=set()
    report={}
    with (ROOT/"manifest.jsonl").open("w") as manifest:
        for name,term in QUERIES.items():
            count=0
            errors=[]
            params=dict(action="query",format="json",generator="search",gsrsearch=f'"{term}" interior filetype:bitmap',
                        gsrnamespace=6,gsrlimit=30,prop="imageinfo",iiprop="url|extmetadata|size|mime")
            try:
                data=json.loads(get("https://commons.wikimedia.org/w/api.php?"+urlencode(params)))
                if "error" in data: raise ValueError(data["error"]["code"])
                for page in data.get("query",{}).get("pages",{}).values():
                    info=page.get("imageinfo",[{}])[0]
                    meta=info.get("extmetadata",{})
                    author=meta.get("Artist",{}).get("value","")
                    license_url=meta.get("LicenseUrl",{}).get("value","")
                    if not re.fullmatch(r"https?://creativecommons.org/(licenses/by(-sa)?/[234]\.0|publicdomain/zero/1\.0)/?",license_url):
                        continue
                    if info.get("mime")!="image/jpeg" or not author or info.get("size",0)>25000000:
                        continue
                    if urlsplit(info["url"]).hostname!="upload.wikimedia.org":continue
                    try:
                        photo=get(info["url"])
                        if len(photo)!=info["size"]:raise ValueError("Incomplete photo")
                        with Image.open(io.BytesIO(photo)) as im:
                            if im.format!="JPEG":raise ValueError("Image is not JPEG")
                            im.verify()
                        key=hashlib.sha256(photo).hexdigest()
                        if key in seen:continue
                        folder=ROOT/name
                        folder.mkdir(exist_ok=True)
                        (folder/(key+".jpg")).write_bytes(photo)
                        manifest.write(json.dumps(dict(candidate_class=name,photo_sha256=key,author=author,
                            license_url=license_url,original_page=info["descriptionurl"],original_url=info["url"],
                            training_eligible=False,status="requires scene, material, duplicate and human mask review"))+"\n")
                        seen.add(key)
                        count+=1
                    except Exception as e:
                        errors.append(str(e)[:160])
                    if count==10:break
            except Exception as e:
                errors.append(str(e)[:160])
            report[name]=dict(downloaded=count,errors=errors)
            print(name,count,errors[:1],flush=True)
            time.sleep(1)
    (ROOT/"report.json").write_text(json.dumps(report,indent=2))
if __name__=="__main__":
    collect()
