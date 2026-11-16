"""Research-only DMS material branch: transferred linear weights + nonlinear residual."""
import argparse,io,json,hashlib,random,tarfile,shutil
from pathlib import Path
import numpy as np
import torch
from torch import nn
from torch.nn import functional as F
from PIL import Image
from safetensors.torch import load_file,save_file
from transformers import AutoImageProcessor,Mask2FormerForUniversalSegmentation

IDS=[3,5,6,7,10,11,12,13,14,20,26,27,29,33,34,35,43,44,46,47,52]
LABELS=['brick','carpet_or_rug','ceiling_tile_unspecified_composition','ceramic','concrete','cork','engineered_stone','fabric','fiberglass_wool','glass','metal','mirror','paint_or_plaster_or_enamel','clear_plastic','opaque_plastic','rubber_or_latex','natural_stone_unspecified','polished_stone_unspecified','tile_unspecified','wallpaper','wood','other_labeled_content']
COPY={'brick':'brick','carpet_or_rug':'carpet_or_rug','concrete':'concrete','fabric':'fabric','glass':'glass','metal':'metal','paint_or_plaster_or_enamel':'paint','opaque_plastic':'plastic','natural_stone_unspecified':'stone','tile_unspecified':'tile','wallpaper':'wallpaper','wood':'wood'}
IGNORE={0,9,22,28,54,55}
OUT=Path('trained-dms');DATA=Path('dms-data');CACHE=Path('dms-cache')
class MaterialHead(nn.Module):
 def __init__(self):
  super().__init__();self.linear=nn.Linear(256,len(LABELS));self.residual=nn.Sequential(nn.LayerNorm(256),nn.Linear(256,128),nn.GELU(),nn.Dropout(.1),nn.Linear(128,len(LABELS)))
  nn.init.zeros_(self.residual[-1].weight);nn.init.zeros_(self.residual[-1].bias)
 def forward(self,x):return self.linear(x)+self.residual(x)
def sha(path):
 with open(path,'rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def target_mask(a):
 b=np.full(a.shape,len(LABELS)-1,np.int64)
 for source,target in zip(IDS,range(len(IDS))):b[a==source]=target
 for source in IGNORE:b[a==source]=255
 return b

def encode(row,base,processor,pair=None):
 if pair is None:
  ip=DATA/row['image_path'];mp=DATA/row['mask_path']
  assert sha(ip)==row['image_sha256'] and sha(mp)==row['mask_sha256'],'checksum mismatch'
 else:
  ip,mp=map(io.BytesIO,pair)
 with Image.open(ip) as i,Image.open(mp) as mask:
  assert i.size==mask.size==(row['width'],row['height']);assert i.getexif().get(274,1)==1
  image=i.convert('RGB').resize((256,256),Image.Resampling.BILINEAR)
  a=np.asarray(mask.resize((64,64),Image.Resampling.NEAREST));assert a.ndim==2 and a.max()<=56
  target=target_mask(a).flatten();valid=np.flatnonzero(target!=255)
 with torch.no_grad():
  x=processor(images=image,do_resize=False,return_tensors='pt')['pixel_values']
  f=base.model.pixel_level_module(x).decoder_last_hidden_state[0].flatten(1).T
 return f.cpu().numpy(),target,valid

def summarize(cm,losses):
 support=cm.sum(1);union=cm.sum(0)+support-cm.diag();iou=cm.diag().float()/union.clamp(min=1)
 target_support=support[:-1]>0
 return {'loss':float(np.mean(losses)),'material':{'miou':float(iou[:-1][target_support].mean()),'classes':{n:{'iou':float(iou[i]) if support[i] else None,'labeled_pixels':int(support[i])} for i,n in enumerate(LABELS)}},'metric':'macro IoU of supported target material classes; other excluded from macro but included in confusion matrix'}
@torch.no_grad()
def evaluate(head,items):
 head.eval();cm=torch.zeros((len(LABELS),len(LABELS)),dtype=torch.int64);losses=[]
 for x,y in items:
  x=torch.as_tensor(x,dtype=torch.float32);y=torch.as_tensor(y,dtype=torch.long)
  if not y.numel():continue
  logits=head(x);losses.append(F.cross_entropy(logits,y).item())
  cm+=torch.bincount(y*len(LABELS)+logits.argmax(1),minlength=len(LABELS)**2).reshape(len(LABELS),len(LABELS))
 return summarize(cm,losses)
def cached(paths):
 for path in paths:
  with np.load(path) as d:yield d['x'].astype('float32'),d['y'].astype('int64')
def plot(history):
 import matplotlib;matplotlib.use('Agg')
 import matplotlib.pyplot as plt
 fig,axes=plt.subplots(1,2,figsize=(12,4));e=[h['epoch'] for h in history]
 axes[0].plot(e,[h['train_loss'] for h in history],label='Train (class weighted)');axes[0].plot(e,[h['validation']['loss'] for h in history],label='Validation (unweighted)')
 axes[1].plot(e,[100*h['validation']['material']['miou'] for h in history],label='Target material mIoU')
 axes[0].set_title('Loss: different weighting, not directly comparable');axes[1].set(title='Validation on annotated 64x64 pixels',ylim=(0,100),ylabel='mIoU, %')
 for ax in axes:ax.set_xlabel('Epoch');ax.grid(alpha=.2);ax.legend()
 fig.tight_layout();fig.savefig(OUT/'learning-curves.png',dpi=160);plt.close(fig)

def main():
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--resume-dms',action='store_true',help='Start from the previous DMS material checkpoint on an expanded train split.')
 parser.add_argument('--mixed-policy',type=Path,help='Stream the verified corpus from the releases in this policy.')
 parser.add_argument('--epochs',type=int,default=20)
 args=parser.parse_args()
 if args.epochs<1:parser.error('--epochs must be positive')
 if args.mixed_policy and not args.resume_dms:parser.error('--mixed-policy requires --resume-dms')
 parent_release='interiors-trained-43691723645' if args.resume_dms else 'interiors-trained-43635573640'
 data_releases=['materials-dms-43685792992']
 if args.resume_dms:data_releases.append('materials-dms-43720376332')
 if args.mixed_policy:
  from mixed_release_data import pairs, registry
  parent_release=json.loads(args.mixed_policy.read_text())['state']['last_training_release']
  data_releases,rows,releases=registry(args.mixed_policy,Path('release-data'))
 torch.set_num_threads(2);torch.manual_seed(42);random.seed(42);rng=np.random.default_rng(42)
 OUT.mkdir(exist_ok=True);CACHE.mkdir(exist_ok=True)
 old_config=json.loads(Path('previous/adapter_config.json').read_text());assert sha('model-package/model.safetensors')==old_config['base_weight_sha256']
 if not args.mixed_policy:
  rows=[json.loads(l) for l in (DATA/'manifest.jsonl').read_text().splitlines()]
 groups={s:[r for r in rows if r['split']==s and r['training_eligible' if s=='train' else 'evaluation_eligible']] for s in ['train','validation','test']}
 if not args.mixed_policy:
  expected_train=7787 if args.resume_dms else 5229
  assert len(groups['train'])==expected_train
  assert len(groups['validation'])==1024 and len(groups['test'])==1053
 assert all(groups.values()), 'an entire split is empty'
 selected=[r for group in groups.values() for r in group]
 for key in ('id','image_path','mask_path','image_sha256','source_image_id'):
  assert len({r[key] for r in selected})==len(selected),f'duplicate selected {key}'
 if args.resume_dms:
  locked=json.loads(Path('resume/split.json').read_text())
  for split in ('validation','test'):
   assert [r['id'] for r in groups[split]]==locked[split],f'{split} changed'
  assert {r['id'] for r in groups['train']}.issuperset(locked['train'])
 sets=[{r['source_image_id'] for r in groups[s]} for s in groups];assert not (sets[0]&sets[1] or sets[0]&sets[2] or sets[1]&sets[2])
 (OUT/'split.json').write_text(json.dumps({s:[r['id'] for r in rs] for s,rs in groups.items()},indent=2))
 print('SPLITS',json.dumps({s:len(rs) for s,rs in groups.items()}),flush=True)
 processor=AutoImageProcessor.from_pretrained('model-package',local_files_only=True,use_fast=False)
 base=Mask2FormerForUniversalSegmentation.from_pretrained('model-package',local_files_only=True,use_safetensors=True).eval()
 for p in base.parameters():p.requires_grad_(False)
 paths={'train':[],'validation':[]};hist=np.zeros(len(LABELS),np.int64);excluded=[];id_for_path={}
 if args.mixed_policy:
  paths['test']=[]
  photos=((row,(photo,mask)) for row,photo,mask in pairs(releases))
 else:
  photos=((row,None) for split in paths for row in groups[split])
 progress={split:0 for split in paths}
 limit=512 if args.mixed_policy else 1024
 uniform=248 if args.mixed_policy else 512
 per_class=12 if args.mixed_policy else 24
 for row,pair in photos:
  split=row['split']
  f,t,valid=encode(row,base,processor,pair)
  progress[split]+=1
  if not len(valid):
   excluded.append({'id':row['id'],'split':split,'reason':'no usable labels after resizing'})
   if args.mixed_policy and split!='train':raise ValueError(f'Fixed evaluation example lost its labels: {row["id"]}')
   continue
  if split=='train':
   hist+=np.bincount(t[valid],minlength=len(LABELS))
   if len(valid)>limit:
    # Sample across the image and reserve examples for rare labels.
    selected=[rng.choice(valid,uniform,replace=False)]
    for label in np.unique(t[valid]):
     candidates=valid[t[valid]==label]
     selected.append(rng.choice(candidates,min(per_class,len(candidates)),replace=False))
    valid=np.unique(np.concatenate(selected))
  path=CACHE/f"{row['id']}.npz"
  dtype='float32' if split=='test' else 'float16'
  np.savez(path,x=f[valid].astype(dtype),y=t[valid].astype('uint8'))
  paths[split].append(path);id_for_path[str(path)]=row['id']
  if progress[split]%200==0:
   print(f'FEATURES {split}: {progress[split]}/{len(groups[split])}',flush=True)
 if args.mixed_policy:
  assert all(progress[s]==len(groups[s]) for s in paths), 'stream did not visit entire verified corpus'
  # Archive order may differ from the original validation manifest order.
  validation_order={str(CACHE/f"{r['id']}.npz"):i for i,r in enumerate(groups['validation'])}
  paths['validation'].sort(key=lambda p:validation_order[str(p)])
 del base
 head=MaterialHead();copied=[]
 if args.resume_dms:
  resume_config=json.loads(Path('resume/adapter_config.json').read_text())
  assert resume_config['base_weight_sha256']==old_config['base_weight_sha256']
  assert resume_config['material_labels']==LABELS and resume_config['dms_ids']==IDS
  head.load_state_dict(load_file('resume/material-head.safetensors'))
 else:
  old=load_file('previous/heads.safetensors')
  with torch.no_grad():
   for dest,source in COPY.items():
    if source in old_config['material_labels']:
     j=LABELS.index(dest);k=old_config['material_labels'].index(source);head.linear.weight[j].copy_(old['material.weight'][k,:,0,0]);head.linear.bias[j].copy_(old['material.bias'][k]);copied.append({'new_label':dest,'initialized_from':source})
 weights=np.zeros(len(LABELS),np.float32);present=hist>0;weights[present]=np.sqrt(np.median(hist[present])/hist[present]);weights[present]=np.clip(weights[present],.25,4);weight=torch.from_numpy(weights)
 initial=evaluate(head,cached(paths['validation']));best=initial['loss'];best_epoch=0;save_file(head.state_dict(),str(OUT/'material-head.safetensors'))
 history=[];optimizer=torch.optim.AdamW(head.parameters(),lr=.0002,weight_decay=.01);visited=set();steps=0;epochs=args.epochs
 for epoch in range(1,epochs+1):
  head.train();random.shuffle(paths['train']);losses=[]
  for path in paths['train']:
   with np.load(path) as d:x=torch.from_numpy(d['x'].astype('float32'));y=torch.from_numpy(d['y'].astype('int64'))
   optimizer.zero_grad(set_to_none=True);loss=F.cross_entropy(head(x),y,weight=weight);assert torch.isfinite(loss)
   loss.backward();nn.utils.clip_grad_norm_(head.parameters(),1);optimizer.step();losses.append(loss.item());visited.add(id_for_path[str(path)]);steps+=1
  metrics=evaluate(head,cached(paths['validation']));record={'epoch':epoch,'train_loss':float(np.mean(losses)),'validation':metrics};history.append(record)
  if metrics['loss']<best:best=metrics['loss'];best_epoch=epoch;save_file(head.state_dict(),str(OUT/'material-head.safetensors'))
  save_file(head.state_dict(),str(OUT/'last-material-head.safetensors'));torch.save({'optimizer':optimizer.state_dict(),'epoch':epoch},OUT/'optimizer-state.pt')
  (OUT/'history.json').write_text(json.dumps(history,indent=2));plot(history);print('EPOCH',json.dumps(record),flush=True)
 assert len(visited)==len(paths['train']);head.load_state_dict(load_file(str(OUT/'material-head.safetensors')));head.eval();final=evaluate(head,cached(paths['validation']))
 if args.mixed_policy:
  test=evaluate(head,cached(paths['test']))
 else:
  # Evaluate the fixed test split after checkpoint selection.
  base=Mask2FormerForUniversalSegmentation.from_pretrained('model-package',local_files_only=True,use_safetensors=True).eval()
  def test_items():
   for i,row in enumerate(groups['test']):
    f,t,valid=encode(row,base,processor)
    if len(valid):yield f[valid],t[valid]
    else:excluded.append({'id':row['id'],'split':'test','reason':'no usable labels after resizing'})
    if (i+1)%200==0:print(f'TEST {i+1}/{len(groups["test"])}',flush=True)
  test=evaluate(head,test_items())
 # Verify serialized head reload reproduces output; keep previous surface/material branch intact.
 clone=MaterialHead().eval();clone.load_state_dict(load_file(str(OUT/'material-head.safetensors')))
 probe=torch.zeros((8,256));assert torch.allclose(head(probe),clone(probe))
 shutil.copy('previous/heads.safetensors',OUT/'previous-heads.safetensors');shutil.copy('previous/adapter_config.json',OUT/'previous-adapter-config.json')
 config={'architecture':'linear + LayerNorm/Linear256x128/GELU/Dropout0.1/Linear128x22 residual; frozen Mask2Former pixel features','base_revision':old_config['base_revision'],'base_weight_sha256':old_config['base_weight_sha256'],'material_labels':LABELS,'dms_ids':IDS,'ignored_dms_ids':sorted(IGNORE),'other_index':len(LABELS)-1,'input_size':[256,256],'evaluation_grid':[64,64],'initialization':copied,'parent_release':parent_release,'use_restriction':'research only; DMS annotations CC-BY-NC-4.0'}
 (OUT/'adapter_config.json').write_text(json.dumps(config,indent=2));(OUT/'coverage.json').write_text(json.dumps({'excluded':excluded,'train_ids_seen':sorted(visited,key=str),'source_counts':{s:len(rs) for s,rs in groups.items()}},indent=2))
 report={'status':'completed','stage':'DMS nonlinear material head transfer learning; backbone frozen; previous surface branch retained unchanged','parent_release':parent_release,'data_release':data_releases[0],'data_releases':data_releases,'train_images':len(paths['train']),'validation_images':len(paths['validation']),'test_images':len(groups['test'])-sum(r['split']=='test' for r in excluded),'epochs':epochs,'best_epoch':best_epoch,'optimizer_steps':steps,'unique_training_images_seen':len(visited),'trainable_parameters':sum(p.numel() for p in head.parameters()),'initial_validation':initial,'best_validation':final,'independent_test':test,'per_class_90_percent_reached':all(v['iou'] is not None and v['iou']>=.9 for k,v in test['material']['classes'].items() if k!='other_labeled_content'),'limitations':['No 90% guarantee; compare against initial result on this same label set, not prior pilot.','21 target material labels plus other content; no separate linoleum or plaster classifier.','IoU on annotated 64x64 pixels; not full-resolution all-photo accuracy.','Backbone frozen; not full-network fine-tuning.','Class-weighted train loss and unweighted validation loss are not directly comparable.','Source-predicted interior scenes; no building-level split guarantee.','Research-only annotations; base checkpoint license other; photo rights from source metadata.','Some classes initialized from narrower/broader old classes only as a starting point, not relabeled ground truth.']}
 if args.mixed_policy:
  report['stage']='Mixed-source nonlinear material head transfer learning; backbone frozen'
  report['train_pixel_sample_cap']=limit
  report['corpus_selected_counts']={s:len(rs) for s,rs in groups.items()}
 if args.resume_dms:
  report['test_note']='Previously reported DMS test split; fixed benchmark for comparison, not a fresh final test.'
  report['limitations'].append(report['test_note'])
  report['per_class_90_percent_on_reused_benchmark']=report.pop('per_class_90_percent_reached')
  report['final_target_confirmed']=False
 (OUT/'training-report.json').write_text(json.dumps(report,indent=2));(OUT/'SHA256SUMS').write_text(''.join(f'{sha(p)}  {p.name}\n' for p in sorted(OUT.iterdir()) if p.is_file() and p.name!='SHA256SUMS'))
 with tarfile.open('interiors-dms-heads.tar.gz','w:gz') as t:t.add(OUT,arcname=OUT.name)
 print('FINAL',json.dumps(report),flush=True)
if __name__=='__main__':main()
