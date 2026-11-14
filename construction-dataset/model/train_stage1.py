"""Stage 1: frozen Mask2Former pixel features + trainable surface/material heads."""
import argparse, hashlib, json, random, tarfile
from pathlib import Path
import numpy as np
import torch
from torch import nn
from torch.nn import functional as F
from PIL import Image
from scipy.fft import dctn
from safetensors.torch import save_file, load_file
from transformers import AutoImageProcessor, Mask2FormerForUniversalSegmentation

SURFACES = ['wall', 'floor', 'ceiling']
MATERIALS = ['concrete', 'tile', 'wood', 'carpet', 'brick', 'panel', 'marble', 'stone']
SEED = 42

def sha(path):
    with open(path, 'rb') as f: return hashlib.file_digest(f, 'sha256').hexdigest()

def phash(path):
    a=np.asarray(Image.open(path).convert('L').resize((32,32)),dtype=float)
    d=dctn(a,norm='ortho')[:8,:8].flatten()[1:]
    return d > np.median(d)

class Heads(nn.Module):
    def __init__(self):
        super().__init__()
        self.surface=nn.Conv2d(256,len(SURFACES),1)
        self.material=nn.Conv2d(256,len(MATERIALS),1)
    def forward(self,x): return self.surface(x),self.material(x)

def targets(row, root):
    image=Image.open(root/row['path']).convert('RGB')
    mask=Image.open(root/row['mask_path'])
    assert image.size==mask.size, f"Alignment mismatch: {row['id']}"
    # Source JPEG and source mask use stored pixel orientation; do not apply EXIF to only one.
    mask=np.asarray(mask.resize((64,64),Image.Resampling.NEAREST))
    s=np.full(mask.shape,255,dtype=np.int64); m=s.copy()
    for g in row['regions']:
        selected=mask==g['mask_value']
        if g['object'] in SURFACES: s[selected]=SURFACES.index(g['object'])
        if g.get('material_normalized') in MATERIALS: m[selected]=MATERIALS.index(g['material_normalized'])
    return image.resize((256,256),Image.Resampling.BILINEAR), torch.from_numpy(s), torch.from_numpy(m)

def encode(rows,root,processor,base):
    data=[]
    for i,row in enumerate(rows):
        assert sha(root/row['path'])==row['sha256']
        assert sha(root/row['mask_path'])==row['mask_sha256']
        image,s,m=targets(row,root)
        if not (s!=255).any(): continue
        with torch.no_grad():
            x=processor(images=image,do_resize=False,return_tensors='pt')['pixel_values']
            f=base.model.pixel_level_module(x).decoder_last_hidden_state
        assert f.shape==(1,256,64,64), f.shape
        data.append((f[0].half(),s,m,row['id']))
        if (i+1)%32==0: print(f'Encoded {i+1}/{len(rows)}',flush=True)
    return data

def loss_fn(logits,target):
    return F.cross_entropy(logits,target,ignore_index=255) if (target!=255).any() else logits.sum()*0

@torch.no_grad()
def evaluate(heads,data):
    cms=[torch.zeros((len(k),len(k)),dtype=torch.int64) for k in (SURFACES,MATERIALS)]
    losses=[]
    for f,s,m,_ in data:
        outs=heads(f.float().unsqueeze(0))
        losses.append(sum(loss_fn(o,t.unsqueeze(0)).item() for o,t in zip(outs,(s,m))))
        for cm,o,t in zip(cms,outs,(s,m)):
            valid=t!=255;n=cm.shape[0];p=o.argmax(1)[0]
            cm+=torch.bincount((t[valid]*n+p[valid]),minlength=n*n).reshape(n,n)
    result={'loss':float(np.mean(losses))}
    for name,names,cm in zip(('surface','material'),(SURFACES,MATERIALS),cms):
        support=cm.sum(1);union=cm.sum(0)+support-cm.diag();iou=cm.diag().float()/union.clamp(min=1)
        # Only ground-truth-supported classes enter macro IoU.
        result[name]={'miou':float(iou[support>0].mean()),'classes':{c:{'iou':float(iou[i]) if support[i] else None,'labeled_pixels':int(support[i])} for i,c in enumerate(names)}}
    return result

def main():
    p=argparse.ArgumentParser();p.add_argument('--data',default='training-data');p.add_argument('--base',default='model-package');p.add_argument('--epochs',type=int,default=20);p.add_argument('--train-limit',type=int,default=256);p.add_argument('--val-limit',type=int,default=64);a=p.parse_args()
    torch.set_num_threads(2);torch.manual_seed(SEED);random.seed(SEED);np.random.seed(SEED)
    root=Path(a.data);out=Path('trained-interiors');out.mkdir(exist_ok=True)
    rows=[json.loads(l) for l in (root/'manifest.jsonl').read_text().splitlines()]
    rows=[r for r in rows if r.get('mask_path') and (root/r['path']).exists() and (root/r['mask_path']).exists()]
    val=sorted([r for r in rows if r.get('source_split','val')=='val' and r.get('rights_status')=='author_and_license_match'],key=lambda r:r['id'])[:a.val_limit]
    assert len(val)>=16
    val_hashes={r['sha256'] for r in val}; val_ph=[phash(root/r['path']) for r in val]
    candidates=[r for r in rows if r.get('source_split')=='train' and r['sha256'] not in val_hashes]
    random.shuffle(candidates)
    # Round-robin selection gives rare annotated materials a chance to appear in this pilot.
    buckets=[[r for r in candidates if any(g.get('material_normalized')==mat for g in r['regions'])] for mat in MATERIALS]
    selected={};seen_sha=set();excluded=[]
    while len(selected)<a.train_limit and any(buckets):
        for bucket in buckets:
            if not bucket or len(selected)>=a.train_limit: continue
            r=bucket.pop()
            if r['id'] in selected or r['sha256'] in seen_sha: continue
            h=phash(root/r['path'])
            if any(np.count_nonzero(h!=v)<=6 for v in val_ph):
                excluded.append(r['id']);continue
            selected[r['id']]=r;seen_sha.add(r['sha256'])
    train=list(selected.values());assert len(train)>=64
    split={'seed':SEED,'train_ids':[r['id'] for r in train],'validation_ids':[r['id'] for r in val],'excluded_near_validation':sorted(set(excluded)), 'split_method':'COCO train2017 vs val2017; SHA256 and 63-bit perceptual hash distance <=6 exclusion across splits; building identity unavailable'}
    (out/'split.json').write_text(json.dumps(split,indent=2))
    processor=AutoImageProcessor.from_pretrained(a.base,local_files_only=True,use_fast=False)
    base=Mask2FormerForUniversalSegmentation.from_pretrained(a.base,local_files_only=True,use_safetensors=True).eval()
    for param in base.parameters():param.requires_grad_(False)
    train_data=encode(train,root,processor,base);val_data=encode(val,root,processor,base)
    assert len(train_data)==len(train) and len(val_data)==len(val)
    del base
    heads=Heads();initial={k:v.detach().clone() for k,v in heads.state_dict().items()}
    initial_eval=evaluate(heads,val_data)
    optimizer=torch.optim.AdamW(heads.parameters(),lr=0.001,weight_decay=0.01)
    best=float('inf');history=[];best_epoch=0
    for epoch in range(1,a.epochs+1):
        random.shuffle(train_data);heads.train();losses=[]
        for f,s,m,_ in train_data:
            optimizer.zero_grad(set_to_none=True)
            outs=heads(f.float().unsqueeze(0));loss=sum(loss_fn(o,t.unsqueeze(0)) for o,t in zip(outs,(s,m)))
            assert torch.isfinite(loss);loss.backward();nn.utils.clip_grad_norm_(heads.parameters(),1.0);optimizer.step();losses.append(loss.item())
        heads.eval();metrics=evaluate(heads,val_data)
        record={'epoch':epoch,'train_loss':float(np.mean(losses)),'validation':metrics};history.append(record)
        print(json.dumps(record),flush=True)
        if metrics['loss']<best:
            best=metrics['loss'];best_epoch=epoch;save_file(heads.state_dict(),str(out/'heads.safetensors'))
        (out/'history.json').write_text(json.dumps(history,indent=2))
    heads.load_state_dict(load_file(str(out/'heads.safetensors')))
    changed=max(float((initial[k]-v).abs().max()) for k,v in heads.state_dict().items());assert changed>0
    final=evaluate(heads,val_data)
    config={'architecture':'frozen Mask2Former pixel-level module plus two 1x1 convolution heads','base_model':'facebook/mask2former-swin-small-ade-semantic','base_revision':'717a6bb84e96b508536efed40a8718b6a45cd87c','base_weight_sha256':'2533310a1e902580a79e575814f1fa04078a99e2321b9bda7afd4f22bba49189','input_size':[256,256],'surface_labels':SURFACES,'material_labels':MATERIALS,'ignore_index':255,'feature_channels':256,'requires_base_model':True}
    (out/'adapter_config.json').write_text(json.dumps(config,indent=2))
    report={'status':'completed','stage':'pilot head-only transfer learning; backbone frozen','epochs':a.epochs,'best_epoch':best_epoch,'train_images':len(train_data),'validation_images':len(val_data),'optimizer_steps':len(train_data)*a.epochs,'trainable_parameters':sum(p.numel() for p in heads.parameters()),'max_parameter_change':changed,'initial_random_head_validation':initial_eval,'best_validation':final,'limitations':['Not full-dataset or full-network training.','Validation is used for checkpoint selection, not an independent final test.','Metrics cover annotated pixels at 64x64 only; unlabeled pixels are ignored, not background.','No validated wiring, plaster, linoleum or trained color head.','Some training images still need individual author/license review; checkpoint license remains other.','No building-level split possible without building IDs.','Material heads have no unknown/background class; inference must use baseline surface gating and still needs human review.']}
    (out/'training-report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report),flush=True)
    (out/'SHA256SUMS').write_text(''.join(f'{sha(f)}  {f.name}\n' for f in sorted(out.iterdir()) if f.is_file() and f.name!='SHA256SUMS'))
    with tarfile.open('interiors-stage1-heads.tar.gz','w:gz') as tar:tar.add(out,arcname=out.name)

if __name__=='__main__': main()
