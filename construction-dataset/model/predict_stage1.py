"""Inference for the stage-1 adapter. Model outputs are experimental predictions."""
import argparse,json
from pathlib import Path
import numpy as np
import torch
from torch.nn import functional as F
from PIL import Image,ImageOps
from safetensors.torch import load_file
from transformers import AutoImageProcessor,Mask2FormerForUniversalSegmentation
from train_stage1 import Heads,SURFACES,MATERIALS,sha

p=argparse.ArgumentParser()
p.add_argument('--base',default='model-package');p.add_argument('--adapter',default='trained-interiors')
p.add_argument('--image',required=True);p.add_argument('--output',default='prediction-stage1')
p.add_argument('--threshold',type=float,default=0.6)
a=p.parse_args();torch.set_num_threads(2)
config=json.loads((Path(a.adapter)/'adapter_config.json').read_text())
assert sha(Path(a.base)/'model.safetensors')==config['base_weight_sha256']
assert config['surface_labels']==SURFACES and config['material_labels']==MATERIALS
im=ImageOps.exif_transpose(Image.open(a.image)).convert('RGB')
processor=AutoImageProcessor.from_pretrained(a.base,local_files_only=True,use_fast=False)
base=Mask2FormerForUniversalSegmentation.from_pretrained(a.base,local_files_only=True,use_safetensors=True).eval()
heads=Heads().eval();heads.load_state_dict(load_file(str(Path(a.adapter)/'heads.safetensors')))
with torch.inference_mode():
    inputs=processor(images=im.resize((256,256),Image.Resampling.BILINEAR),do_resize=False,return_tensors='pt')
    outputs=base(**inputs,output_hidden_states=True)
    original=processor.post_process_semantic_segmentation(outputs,target_sizes=[(256,256)])[0]
    surface_ids=[k for k,v in base.config.id2label.items() if v in SURFACES]
    gate=torch.zeros_like(original,dtype=torch.bool)
    for k in surface_ids: gate|=original==k
    prediction=heads(outputs.pixel_decoder_last_hidden_state)
    result={}
    out=Path(a.output);out.mkdir(parents=True,exist_ok=True)
    for name,logits,labels in zip(('surface','material'),prediction,(SURFACES,MATERIALS)):
        probabilities=F.interpolate(logits,size=(256,256),mode='bilinear',align_corners=False).softmax(1)
        confidence,ids=probabilities.max(1);ids=ids[0];ids[(confidence[0]<a.threshold)|~gate]=255
        mask=Image.fromarray(ids.cpu().numpy().astype('uint8')).resize(im.size,Image.Resampling.NEAREST)
        mask.save(out/f'{name}.png')
        pixels=np.asarray(mask)
        result[name]={label:int((pixels==i).sum()) for i,label in enumerate(labels)}
    result.update({'unknown_id':255,'threshold':a.threshold,'confidence_calibrated':False,'note':'Experimental; baseline surface gating; no wiring/plaster/linoleum classifier; colors not trained.'})
    (out/'summary.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
