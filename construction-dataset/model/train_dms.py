"""Research-only DMS material branch: transferred linear weights + nonlinear residual."""
import json,hashlib,random,tarfile,shutil
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

def encode(row,base,processor):
 ip=DATA/row['image_path'];mp=DATA/row['mask_path']
 assert sha(ip)==row['image_sha256'] and sha(mp)==row['mask_sha256'],'checksum mismatch'
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
 torch.set_num_threads(2);torch.manual_seed(42);random.seed(42);rng=np.random.default_rng(42)
 OUT.mkdir(exist_ok=True);CACHE.mkdir(exist_ok=True)
 old_config=json.loads(Path('previous/adapter_config.json').read_text());assert sha('model-package/model.safetensors')==old_config['base_weight_sha256']
 rows=[json.loads(l) for l in (DATA/'manifest.jsonl').read_text().splitlines()]
 groups={s:[r for r in rows if r['split']==s and r['training_eligible' if s=='train' else 'evaluation_eligible']] for s in ['train','validation','test']}
 assert len(groups['train'])==5229;assert sum(len(groups[s]) for s in ['validation','test'])==2077
 sets=[{r['source_image_id'] for r in groups[s]} for s in groups];assert not (sets[0]&sets[1] or sets[0]&sets[2] or sets[1]&sets[2])
 (OUT/'split.json').write_text(json.dumps({s:[r['id'] for r in rs] for s,rs in groups.items()},indent=2))
 print('SPLITS',json.dumps({s:len(rs) for s,rs in groups.items()}),flush=True)
 processor=AutoImageProcessor.from_pretrained('model-package',local_files_only=True,use_fast=False)
 base=Mask2FormerForUniversalSegmentation.from_pretrained('model-package',local_files_only=True,use_safetensors=True).eval()
 for p in base.parameters():p.requires_grad_(False)
 paths={'train':[],'validation':[]};hist=np.zeros(len(LABELS),np.int64);excluded=[];id_for_path={}
 for split in paths:
  for i,row in enumerate(groups[split]):
   f,t,valid=encode(row,base,processor)
   if not len(valid):excluded.append({'id':row['id'],'split':split,'reason':'no usable labels after resizing'});continue
   if split=='train':
    hist+=np.bincount(t[valid],minlength=len(LABELS))
    if len(valid)>1024:
     # Extra rare-label pixels supplement a uniform sample, chosen only from training labels.
     selected=[rng.choice(valid,512,replace=False)]
     for label in np.unique(t[valid]):
      candidates=valid[t[valid]==label];selected.append(rng.choice(candidates,min(24,len(candidates)),replace=False))
     valid=np.unique(np.concatenate(selected))
   path=CACHE/f"{row['id']}.npz";np.savez(path,x=f[valid].astype('float16'),y=t[valid].astype('uint8'));paths[split].append(path);id_for_path[str(path)]=row['id']
   if (i+1)%200==0:print(f'FEATURES {split}: {i+1}/{len(groups[split])}',flush=True)
 del base
 head=MaterialHead();old=load_file('previous/heads.safetensors');copied=[]
 with torch.no_grad():
  for dest,source in COPY.items():
   if source in old_config['material_labels']:
    j=LABELS.index(dest);k=old_config['material_labels'].index(source);head.linear.weight[j].copy_(old['material.weight'][k,:,0,0]);head.linear.bias[j].copy_(old['material.bias'][k]);copied.append({'new_label':dest,'initialized_from':source})
 weights=np.zeros(len(LABELS),np.float32);present=hist>0;weights[present]=np.sqrt(np.median(hist[present])/hist[present]);weights[present]=np.clip(weights[present],.25,4);weight=torch.from_numpy(weights)
 initial=evaluate(head,cached(paths['validation']));best=initial['loss'];best_epoch=0;save_file(head.state_dict(),str(OUT/'material-head.safetensors'))
 history=[];optimizer=torch.optim.AdamW(head.parameters(),lr=.0002,weight_decay=.01);visited=set();steps=0;epochs=20
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
 # Independent test is encoded and evaluated only once after checkpoint selection.
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
 config={'architecture':'linear + LayerNorm/Linear256x128/GELU/Dropout0.1/Linear128x22 residual; frozen Mask2Former pixel features','base_revision':old_config['base_revision'],'base_weight_sha256':old_config['base_weight_sha256'],'material_labels':LABELS,'dms_ids':IDS,'ignored_dms_ids':sorted(IGNORE),'other_index':len(LABELS)-1,'input_size':[256,256],'evaluation_grid':[64,64],'initialization':copied,'use_restriction':'research only; DMS annotations CC-BY-NC-4.0'}
 (OUT/'adapter_config.json').write_text(json.dumps(config,indent=2));(OUT/'coverage.json').write_text(json.dumps({'excluded':excluded,'train_ids_seen':sorted(visited),'source_counts':{s:len(rs) for s,rs in groups.items()}},indent=2))
 report={'status':'completed','stage':'DMS nonlinear material head transfer learning; backbone frozen; previous surface branch retained unchanged','parent_release':'interiors-trained-43635573640','data_release':'materials-dms-43685792992','train_images':len(paths['train']),'validation_images':len(paths['validation']),'test_images':len(groups['test'])-sum(r['split']=='test' for r in excluded),'epochs':epochs,'best_epoch':best_epoch,'optimizer_steps':steps,'unique_training_images_seen':len(visited),'trainable_parameters':sum(p.numel() for p in head.parameters()),'initial_validation':initial,'best_validation':final,'independent_test':test,'per_class_90_percent_reached':all(v['iou'] is not None and v['iou']>=.9 for k,v in test['material']['classes'].items() if k!='other_labeled_content'),'limitations':['No 90% guarantee; compare against initial result on this same label set, not prior pilot.','21 target material labels plus other content; no separate linoleum or plaster classifier.','IoU on annotated 64x64 pixels; not full-resolution all-photo accuracy.','Backbone frozen; not full-network fine-tuning.','Class-weighted train loss and unweighted validation loss are not directly comparable.','Source-predicted interior scenes; no building-level split guarantee.','Research-only annotations; base checkpoint license other; photo rights from source metadata.','Some classes initialized from narrower/broader old classes only as a starting point, not relabeled ground truth.']}
 (OUT/'training-report.json').write_text(json.dumps(report,indent=2));(OUT/'SHA256SUMS').write_text(''.join(f'{sha(p)}  {p.name}\n' for p in sorted(OUT.iterdir()) if p.is_file() and p.name!='SHA256SUMS'))
 with tarfile.open('interiors-dms-heads.tar.gz','w:gz') as t:t.add(OUT,arcname=OUT.name)
 print('FINAL',json.dumps(report),flush=True)
if __name__=='__main__':main()
