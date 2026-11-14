"""Continue learned heads using every eligible image; frozen pretrained feature extractor."""
import json,random,hashlib,tarfile,time,shutil
from pathlib import Path
import numpy as np
import torch
from torch import nn
from torch.nn import functional as F
from PIL import Image,ImageDraw
from safetensors.torch import load_file,save_file
from transformers import AutoImageProcessor,Mask2FormerForUniversalSegmentation
from train_stage1 import SURFACES, MATERIALS as OLD_MATERIALS,sha,phash

MATERIALS=OLD_MATERIALS+['paint','wallpaper','granite_or_marble','linoleum','metal','glass','fabric','plastic','carpet_or_rug']
ALIASES={'Metal':'metal','Glass':'glass','Fabric/cloth':'fabric','Plastic - opaque':'plastic'}
OUT=Path('trained-all'); ROOT=Path('training-data'); CACHE=Path('feature-cache')

class Heads(nn.Module):
    def __init__(self):
        super().__init__();self.surface=nn.Conv2d(256,3,1);self.material=nn.Conv2d(256,len(MATERIALS),1)
    def forward(self,x):return self.surface(x),self.material(x)

def material(g):return ALIASES.get(g.get('material_normalized'),g.get('material_normalized'))

def targets(row):
    with Image.open(ROOT/row['path']) as src:
        assert src.getexif().get(274,1)==1,'nontrivial EXIF orientation requires review'
        image=src.convert('RGB');w,h=image.size
    s=np.full((256,256),255,np.int64);m=s.copy();sc=np.zeros(s.shape,bool);mc=sc.copy()
    source_mask=None
    if row.get('mask_path'):
        assert sha(ROOT/row['mask_path'])==row['mask_sha256'],'mask hash mismatch'
        source=Image.open(ROOT/row['mask_path']);assert source.size==image.size,'mask/image size mismatch'
        source_mask=np.asarray(source.resize((256,256),Image.Resampling.NEAREST))
    elif row.get('source')=='OpenSurfaces':
        assert (row['width'],row['height'])==image.size,'source polygon size mismatch'
    for g in row.get('regions',[]):
        if g['object'] not in SURFACES:continue
        if source_mask is not None:
            region=source_mask==g['mask_value']
        elif g.get('vertices_normalized') and g.get('triangle_indices'):
            verts=np.asarray(g['vertices_normalized'],float).reshape(-1,2)
            idx=np.asarray(g['triangle_indices'],int).reshape(-1,3)
            assert np.isfinite(verts).all() and verts.min()>=-0.01 and verts.max()<=1.01,'invalid vertices'
            assert idx.min()>=0 and idx.max()<len(verts),'invalid triangle indices'
            canvas=Image.new('1',(256,256));draw=ImageDraw.Draw(canvas)
            for tri in idx:draw.polygon([tuple(v*255) for v in np.clip(verts[tri],0,1)],fill=1)
            region=np.asarray(canvas,dtype=bool)
        elif g.get('bbox_xyxy_normalized') and g['object'] in SURFACES:
            box=np.asarray(g['bbox_xyxy_normalized']);assert (box>=0).all() and (box<=1).all()
            canvas=Image.new('1',(256,256));ImageDraw.Draw(canvas).rectangle(tuple(box*255),fill=1);region=np.asarray(canvas,dtype=bool)
        else:continue
        for arr,conflict,label in [(s,sc,SURFACES.index(g['object'])),(m,mc,MATERIALS.index(material(g)) if material(g) in MATERIALS else None)]:
            if label is None:continue
            conflict|=region & (arr!=255) & (arr!=label)
            arr[region & ~conflict]=label;arr[conflict]=255
    def down(a):return np.asarray(Image.fromarray(a.astype('uint8')).resize((64,64),Image.Resampling.NEAREST)).astype('int64')
    return image.resize((256,256),Image.Resampling.BILINEAR),down(s),down(m)

@torch.no_grad()
def evaluate(heads,paths):
    cms=[torch.zeros((n,n),dtype=torch.int64) for n in (3,len(MATERIALS))];losses=[]
    for path in paths:
        with np.load(path) as d:
            x=torch.from_numpy(d['features'].astype('float32')).T[None,:,None,:]
            targets_=[torch.from_numpy(d[k].astype('int64'))[None,None,:] for k in ['surface','material']]
        outputs=heads(x);loss=0
        for cm,o,t in zip(cms,outputs,targets_):
            valid=t!=255;n=len(cm)
            if valid.any():loss+=F.cross_entropy(o,t,ignore_index=255).item();cm+=torch.bincount(t[valid]*n+o.argmax(1)[valid],minlength=n*n).reshape(n,n)
        losses.append(loss)
    result={'loss':float(np.mean(losses))}
    for name,labels,cm in zip(['surface','material'],[SURFACES,MATERIALS],cms):
        support=cm.sum(1);union=cm.sum(0)+support-cm.diag();iou=cm.diag()/union.clamp(min=1)
        result[name]={'miou':float(iou[support>0].mean()),'classes':{v:{'iou':float(iou[i]) if support[i] else None,'labeled_pixels':int(support[i])} for i,v in enumerate(labels)}}
    return result

def charts(history):
    import matplotlib;matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    fig,ax=plt.subplots(1,2,figsize=(12,4));epochs=[r['epoch'] for r in history]
    for k,label in [('train_loss','Train'),('val_loss','Validation')]:ax[0].plot(epochs,[r[k] if k=='train_loss' else r['validation']['loss'] for r in history],label=label)
    for k in ['surface','material']:ax[1].plot(epochs,[100*r['validation'][k]['miou'] for r in history],label=k)
    ax[0].set(title='Loss (lower is better)',xlabel='Epoch');ax[1].set(title='Validation mIoU, % (annotated pixels)',xlabel='Epoch',ylim=(0,100))
    for a in ax:a.legend();a.grid(alpha=.2)
    fig.tight_layout();fig.savefig(OUT/'learning-curves.png',dpi=160);plt.close(fig)

def main():
    torch.set_num_threads(2);torch.manual_seed(42);random.seed(42);rng=np.random.default_rng(42)
    OUT.mkdir(exist_ok=True);CACHE.mkdir(exist_ok=True)
    old_config=json.loads(Path('previous/adapter_config.json').read_text());assert old_config['material_labels']==OLD_MATERIALS
    assert sha('model-package/model.safetensors')==old_config['base_weight_sha256']
    old_split=json.loads(Path('previous/split.json').read_text());val_ids=set(old_split['validation_ids'])
    rows=[json.loads(l) for l in (ROOT/'manifest.jsonl').read_text().splitlines()]
    audit=[];eligible=[]
    for r in rows:
        item={'id':r['id'],'source':r.get('source','COCO-Stuff')};audit.append(item)
        try:
            assert (ROOT/r['path']).exists(),'missing image'
            assert sha(ROOT/r['path'])==r['sha256'],'image hash mismatch'
            image,s,m=targets(r)
            assert (s!=255).any() or (m!=255).any(),'no usable target pixels'
            if r['id'] in val_ids:split='validation'
            elif r.get('source_split')=='train':split='train'
            elif r.get('source')=='OpenSurfaces':
                group=r.get('original_page') or r['id'];split='validation' if int(hashlib.sha256(group.encode()).hexdigest(),16)%10==0 else 'train'
            elif r.get('source')=='Wikimedia Commons':split='train'
            else:split='reserved_coco_validation'
            item['status']=split
            if split in ['train','validation']:eligible.append((r,item))
        except Exception as e:item.update(status='excluded',reason=str(e))
    validation=[r for r,a in eligible if a['status']=='validation'];vh={r['sha256'] for r in validation};vp=[phash(ROOT/r['path']) for r in validation]
    seen=set();used=[]
    for r,a in eligible:
        if a['status']=='train':
            if r['sha256'] in vh or r['sha256'] in seen:a.update(status='excluded',reason='exact duplicate');continue
            h=phash(ROOT/r['path'])
            if any(np.count_nonzero(h!=v)<=6 for v in vp):a.update(status='excluded',reason='near validation perceptual hash');continue
            seen.add(r['sha256'])
        used.append((r,a))
    (OUT/'coverage.json').write_text(json.dumps(audit,indent=2))
    split={k:[r['id'] for r,a in used if a['status']==k] for k in ['train','validation']}
    (OUT/'split.json').write_text(json.dumps(split,indent=2))
    print('COVERAGE',json.dumps({k:sum(x['status']==k for x in audit) for k in {x['status'] for x in audit}}),flush=True)
    processor=AutoImageProcessor.from_pretrained('model-package',local_files_only=True,use_fast=False)
    base=Mask2FormerForUniversalSegmentation.from_pretrained('model-package',local_files_only=True,use_safetensors=True).eval()
    for p in base.parameters():p.requires_grad_(False)
    paths={'train':[],'validation':[]};source_ids={}
    for i,(r,a) in enumerate(used):
        image,s,m=targets(r)
        with torch.no_grad():
            inputs=processor(images=image,do_resize=False,return_tensors='pt')
            features=base.model.pixel_level_module(inputs['pixel_values']).decoder_last_hidden_state[0].flatten(1).T.cpu().numpy()
        s=s.flatten();m=m.flatten();indices=np.flatnonzero((s!=255)|(m!=255))
        if a['status']=='train' and len(indices)>1024:
            # Uniform labeled pixels; do not invent dense labels in unannotated regions.
            indices=rng.choice(indices,1024,replace=False)
        path=CACHE/(r['id']+'.npz');np.savez(path,features=features[indices].astype('float16'),surface=s[indices].astype('uint8'),material=m[indices].astype('uint8'))
        paths[a['status']].append(path);source_ids[str(path)]=r['id']
        if (i+1)%100==0:print(f'FEATURES {i+1}/{len(used)}',flush=True)
    del base
    heads=Heads();old=load_file('previous/heads.safetensors')
    with torch.no_grad():
        heads.surface.weight.copy_(old['surface.weight']);heads.surface.bias.copy_(old['surface.bias'])
        heads.material.weight[:len(OLD_MATERIALS)].copy_(old['material.weight']);heads.material.bias[:len(OLD_MATERIALS)].copy_(old['material.bias'])
    initial=evaluate(heads,paths['validation']);best=initial['loss'];best_epoch=0
    save_file(heads.state_dict(),str(OUT/'heads.safetensors'))
    optimizer=torch.optim.AdamW(heads.parameters(),lr=0.0002,weight_decay=.01)
    history=[];visited=set();steps=0;epochs=20
    for epoch in range(1,epochs+1):
        random.shuffle(paths['train']);losses=[];heads.train()
        for path in paths['train']:
            with np.load(path) as d:
                x=torch.from_numpy(d['features'].astype('float32')).T[None,:,None,:]
                ts=[torch.from_numpy(d[k].astype('int64'))[None,None,:] for k in ['surface','material']]
            outputs=heads(x);loss=sum(F.cross_entropy(o,t,ignore_index=255) if (t!=255).any() else o.sum()*0 for o,t in zip(outputs,ts))
            assert torch.isfinite(loss);optimizer.zero_grad(set_to_none=True);loss.backward();nn.utils.clip_grad_norm_(heads.parameters(),1);optimizer.step()
            losses.append(loss.item());visited.add(source_ids[str(path)]);steps+=1
        heads.eval();metrics=evaluate(heads,paths['validation']);record={'epoch':epoch,'train_loss':float(np.mean(losses)),'validation':metrics};history.append(record)
        if metrics['loss']<best:best=metrics['loss'];best_epoch=epoch;save_file(heads.state_dict(),str(OUT/'heads.safetensors'))
        save_file(heads.state_dict(),str(OUT/'last-heads.safetensors'))
        torch.save({'optimizer':optimizer.state_dict(),'epoch':epoch,'seed':42},OUT/'optimizer-state.pt')
        (OUT/'history.json').write_text(json.dumps(history,indent=2));charts(history)
        print('EPOCH',json.dumps(record),flush=True)
    assert visited==set(split['train']),'not all selected images trained'
    heads.load_state_dict(load_file(str(OUT/'heads.safetensors')));final=evaluate(heads,paths['validation'])
    config={**old_config,'material_labels':MATERIALS,'architecture':'frozen Mask2Former pixel features + continued and expanded 1x1 heads'}
    (OUT/'adapter_config.json').write_text(json.dumps(config,indent=2))
    report={'status':'completed','stage':'all eligible data; continued heads; backbone frozen','parent_release':'interiors-trained-43634325158','epochs':epochs,'best_epoch':best_epoch,'train_images':len(paths['train']),'validation_images':len(paths['validation']),'unique_training_images_seen':len(visited),'all_eligible_training_images_seen':True,'optimizer_steps':steps,'trainable_parameters':sum(p.numel() for p in heads.parameters()),'initial_expanded_head_validation':initial,'best_validation':final,'coverage_counts':{k:sum(a['status']==k for a in audit) for k in sorted({a['status'] for a in audit})},'limitations':['Backbone remains frozen; not full-network finetuning.','Validation set expanded with OpenSurfaces and label space expanded: not directly comparable to pilot mIoU.','IoU on annotated pixels at 64x64, not all-photo accuracy.','Some original licenses/authorship still require review; base model license other.','No building IDs; building-level separation not guaranteed.','No validated wiring or plaster model; colors not trained.','Up to 1024 annotated training pixels per photo cached; all eligible photos seen.','No independent final test; validation selects checkpoint.']}
    (OUT/'training-report.json').write_text(json.dumps(report,indent=2))
    (OUT/'SHA256SUMS').write_text(''.join(f'{sha(p)}  {p.name}\n' for p in sorted(OUT.iterdir()) if p.is_file() and p.name!='SHA256SUMS'))
    with tarfile.open('interiors-all-heads.tar.gz','w:gz') as tar:tar.add(OUT,arcname='trained-all')
    print('FINAL',json.dumps(report),flush=True)

if __name__=='__main__':main()
