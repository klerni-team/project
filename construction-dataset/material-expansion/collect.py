"""Research-only DMS interior material expansion. No model training."""
import concurrent.futures,collections,hashlib,gzip,io,json,os,random,re,shutil,subprocess,tarfile,time,urllib.request,zipfile
from pathlib import Path
import cv2,numpy as np
from PIL import Image
from scipy.fft import dctn
URL='https://docs-assets.developer.apple.com/ml-research/datasets/dms/dms_v1_labels.zip'
EXPECTED='78e22ffa002e168c096a007ad3e50aa4fb5f1d2a04182c31f1a73733d1867290'
TARGETS=[3,5,6,7,10,11,12,13,14,20,26,27,29,33,34,35,43,44,46,47,52]
ROOT=Path('material-expansion');ROOT.mkdir(exist_ok=True)
TAG=os.environ.get('DATA_RELEASE','');cv2.setNumThreads(1)
def sha(p):
 with open(p,'rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def fetch(url):
 for attempt in range(2):
  try:
   with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'InteriorMaterialResearch/1.0'}),timeout=25) as r:
    b=r.read(25000001)
    if len(b)>25000000:raise ValueError('image above 25MB limit')
    return b
  except Exception:
   if attempt:raise
   time.sleep(1)
def fingerprint(im):
 a=cv2.resize(im.mean(axis=2,dtype=np.float32),(90,90),interpolation=cv2.INTER_AREA)
 dx=cv2.Sobel(a,cv2.CV_32F,1,0,ksize=1).reshape(3,30,3,30).mean(axis=(1,3))
 dy=cv2.Sobel(a,cv2.CV_32F,0,1,ksize=1).reshape(3,30,3,30).mean(axis=(1,3))
 return np.rad2deg(np.arctan2(dy,dx))%360

def phash(image):
 a=np.asarray(image.convert('L').resize((32,32)),float);d=dctn(a,norm='ortho')[:8,:8].flatten()[1:];b=d>np.median(d)
 return sum(int(v)<<i for i,v in enumerate(b))
class HashIndex:
 def __init__(self):self.bands=collections.defaultdict(list)
 def add(self,h,id):
  for i in range(7):self.bands[(i,(h>>(i*9))&511)].append((h,id))
 def match(self,h):
  for i in range(7):
   for other,id in self.bands.get((i,(h>>(i*9))&511),[]):
    if (h^other).bit_count()<=6:return id
  return None

def photoid(row):
 u=row.get('OriginalLandingURL') or row.get('original_page') or row.get('original_url','')
 if 'flickr.com' not in u:return None
 found=re.findall(r'\d{6,}',u);return found[-1] if found else None

def main():
 archive=Path('dms-labels.zip')
 if not archive.exists():
  with urllib.request.urlopen(URL,timeout=120) as r,archive.open('wb') as f:shutil.copyfileobj(r,f)
 assert sha(archive)==EXPECTED,'DMS archive hash mismatch'
 z=zipfile.ZipFile(archive);data=json.loads(gzip.decompress(z.read('DMS_v1/info.json.gz')));taxonomy=json.loads(z.read('DMS_v1/taxonomy.json'))
 (ROOT/'taxonomy.json').write_text(json.dumps(taxonomy,indent=2))
 names=taxonomy['names'];candidates=[r for r in data if 'indoor' in r.get('predicted_scene_level1_attributes',[]) and any(r['label_fraction'][i]>=.02 for i in TARGETS)]
 random.Random(42).shuffle(candidates);selection={}
 for split,limit in [('train',600),('validation',100),('test',100)]:
  for target in TARGETS:
   for r in [r for r in candidates if r['split']==split and r['label_fraction'][target]>=.02][:limit]:selection[r['id']]=r
 oldrows=[json.loads(l) for l in Path('old-data/manifest.jsonl').read_text().splitlines()];oldids={photoid(r) for r in oldrows};oldids.discard(None);oldph=HashIndex()
 for r in oldrows:
  p=Path('old-data')/r['path']
  if p.exists():
   with Image.open(p) as im:oldph.add(phash(im),r['id'])
 audit=[];chosen=[]
 for r in selection.values():
  md=r['openimages_metadata']
  if photoid(md) in oldids:audit.append({'id':r['id'],'status':'excluded_existing_source','split':r['split']});continue
  if md.get('License')!='https://creativecommons.org/licenses/by/2.0/' or not md.get('Author'):audit.append({'id':r['id'],'status':'excluded_license_metadata','split':r['split']});continue
  chosen.append(r)
 rows=[];shards=[]
 def collect(pair):
  r,mask_bytes=pair;md=r['openimages_metadata'];errors=[]
  for url in dict.fromkeys([md['OriginalURL'],md.get('Thumbnail300KURL')]):
   if not url:continue
   try:
    raw=fetch(url);orig=cv2.imdecode(np.frombuffer(raw,np.uint8),cv2.IMREAD_COLOR)
    if orig is None or min(orig.shape[:2])<256:raise ValueError('unreadable or short side under 256px')
    h,w=r['height'],r['width'];ref=np.array(r['rotation_descriptor']);valid=None;rotation=None
    for k in range(4):
     a=np.ascontiguousarray(np.rot90(orig,k))
     if abs((a.shape[1]/a.shape[0])/(w/h)-1)>.01:continue
     resized=cv2.resize(a,(w,h),interpolation=cv2.INTER_AREA if a.shape[0]>=h else cv2.INTER_CUBIC)
     im=Image.fromarray(resized[:,:,::-1]);buf=io.BytesIO();im.save(buf,format='JPEG',quality=95);jpg=buf.getvalue()
     decoded=cv2.imdecode(np.frombuffer(jpg,np.uint8),cv2.IMREAD_COLOR)
     diff=np.abs((fingerprint(decoded)-ref+180)%360-180)
     if (diff<=5).mean()>=.5 and diff.max()<=30:valid=(jpg,im);rotation=k*90;break
    if valid is None:raise ValueError('orientation descriptor or aspect ratio mismatch')
    jpg,im=valid;mask=Image.open(io.BytesIO(mask_bytes));assert mask.size==(w,h),'mask dimensions mismatch'
    values=np.asarray(mask);assert values.ndim==2 and values.max()<len(names),'unexpected mask values'
    ph=phash(im);old_match=oldph.match(ph)
    if old_match:return {'id':r['id'],'split':r['split'],'status':'excluded_near_existing','match':old_match}
    imgpath=ROOT/'staging'/'photos'/f"{r['id']}.jpg";mpath=ROOT/'staging'/'masks'/f"{r['id']}.png"
    imgpath.parent.mkdir(parents=True,exist_ok=True);mpath.parent.mkdir(parents=True,exist_ok=True);imgpath.write_bytes(jpg);mpath.write_bytes(mask_bytes)
    counts=np.bincount(values.flatten(),minlength=len(names))
    return {'id':r['id'],'status':'verified_pair','split':r['split'],'image_path':f"photos/{r['id']}.jpg",'mask_path':f"masks/{r['id']}.png",'image_sha256':hashlib.sha256(jpg).hexdigest(),'mask_sha256':hashlib.sha256(mask_bytes).hexdigest(),'phash63':str(ph),'width':w,'height':h,'rotation_ccw_degrees':rotation,'download_url':url,'original_url':md['OriginalURL'],'original_page':md['OriginalLandingURL'],'author':md['Author'],'image_license':md['License'],'license_evidence':'DMS Open Images metadata; current original-page license not individually reverified','annotation_license':'CC-BY-NC-4.0','source_image_id':md['ImageID'],'scene':r['predicted_scene_type'],'scene_status':'source-predicted indoor; not manually confirmed','class_pixels':{names[i]:int(counts[i]) for i in TARGETS if counts[i]},'training_eligible':False,'evaluation_eligible':False}
   except Exception as e:errors.append(str(e))
  return {'id':r['id'],'split':r['split'],'status':'download_or_alignment_failed','errors':errors}
 for start in range(0,len(chosen),1000):
  batch=chosen[start:start+1000];pairs=[(r,z.read('DMS_v1/'+r['label_path'])) for r in batch]
  with concurrent.futures.ThreadPoolExecutor(max_workers=24) as pool:outcomes=list(pool.map(collect,pairs))
  successful=[r for r in outcomes if r['status']=='verified_pair'];audit.extend(outcomes);rows.extend(successful)
  shard=Path(f'materials-dms-{start//1000+1:03d}.tar.gz')
  if successful:
   with tarfile.open(shard,'w:gz') as t:
    for r in successful:
     for key in ['image_path','mask_path']:t.add(ROOT/'staging'/r[key],arcname=r[key])
   digest=sha(shard);shards.append({'name':shard.name,'sha256':digest,'pairs':len(successful),'bytes':shard.stat().st_size})
   subprocess.run(['gh','release','upload',TAG,str(shard)],check=True);shard.unlink();shutil.rmtree(ROOT/'staging')
  (ROOT/'collection-audit.json').write_text(json.dumps(audit,indent=2));print('COLLECTED',len(rows),'processed',start+len(batch),'of',len(chosen),flush=True)
 # Preserve official partitions; block exact/perceptual overlap between independent splits.
 protected=HashIndex();seen=set();ids=set()
 for split in ['test','validation','train']:
  for r in [r for r in rows if r['split']==split]:
   duplicate=r['image_sha256'] in seen or r['source_image_id'] in ids
   near=protected.match(int(r['phash63']))
   if duplicate or near:r['eligibility_reason']='duplicate or near another split';r['matched_id']=near
   else:
    r['training_eligible']=split=='train';r['evaluation_eligible']=split in ['test','validation'];r['eligibility_reason']='passed automated checks; research-only; source scene/labels not manually reviewed'
   seen.add(r['image_sha256']);ids.add(r['source_image_id'])
  if split!='train':
   for r in [r for r in rows if r['split']==split]:protected.add(int(r['phash63']),r['id'])
 with (ROOT/'manifest.jsonl').open('w') as f:
  for r in rows:f.write(json.dumps(r)+'\n')
 counts={name:{split:sum(name in r['class_pixels'] and r['split']==split and (r['training_eligible'] or r['evaluation_eligible']) for r in rows) for split in ['train','validation','test']} for name in [names[i] for i in TARGETS]}
 summary={'source':'DMS v1, Upchurch and Niu, ECCV 2022','annotation_license':'CC-BY-NC-4.0; non-commercial research only','source_annotations':len(data),'indoor_candidates':len(candidates),'selected_candidates':len(selection),'downloaded_verified_pairs':len(rows),'training_eligible':sum(r['training_eligible'] for r in rows),'evaluation_eligible':sum(r['evaluation_eligible'] for r in rows),'status_counts':dict(collections.Counter(r['status'] for r in audit)),'class_image_counts':counts,'shards':shards,'annotation_archive_sha256':EXPECTED,'limitations':['No accuracy guarantee; no training performed.','Scene indoor is a source classifier prediction, not human verification.','Paint/plaster/enamel is one label; polished stone is not necessarily marble.','No separate linoleum, laminate, gypsum board or panel class in this source.','Photo rights recorded from upstream metadata; not independently reverified per original page.','No building IDs; duplicates screened but building-level independence not established.','Masks retain original taxonomy; do not feed into existing 17-class model without explicit mapping.','Check eligibility flags; archives also contain pairs blocked from train/evaluation by cross-split deduplication.']}
 (ROOT/'collection-report.json').write_text(json.dumps(summary,indent=2))
 (ROOT/'ATTRIBUTION.md').write_text('DMS: Paul Upchurch and Ransen Niu. A Dense Material Segmentation Dataset for Indoor and Outdoor Scene Parsing. ECCV 2022. https://github.com/apple-aiml-research/ml-dms-dataset\nAnnotations: https://creativecommons.org/licenses/by-nc/4.0/\nPhoto author, original URL and CC-BY-2.0 evidence are recorded per image in manifest.jsonl. Images resized/re-encoded and sometimes rotated to match source masks; all changes recorded. No endorsement by original authors.\n')
 (ROOT/'SHA256SUMS').write_text(''.join(f"{x['sha256']}  {x['name']}\n" for x in shards)+''.join(f'{sha(p)}  {p.name}\n' for p in sorted(ROOT.iterdir()) if p.is_file() and p.name!='SHA256SUMS'))
 print(json.dumps(summary),flush=True)
if __name__=='__main__':main()
