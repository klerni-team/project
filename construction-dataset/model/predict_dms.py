"""Run the research-only DMS material branch on a photo."""
import argparse,json
from pathlib import Path
import numpy as np
import torch
from PIL import Image,ImageOps
from torch.nn import functional as F
from safetensors.torch import load_file
from transformers import AutoImageProcessor,Mask2FormerForUniversalSegmentation
from train_dms import MaterialHead,LABELS,sha

p=argparse.ArgumentParser()
p.add_argument('--image',required=True);p.add_argument('--base',default='model-package')
p.add_argument('--adapter',default='trained-dms');p.add_argument('--output',default='dms-prediction')
p.add_argument('--threshold',type=float,default=.6)
a=p.parse_args()
assert 0<=a.threshold<=1
torch.set_num_threads(2)
config=json.loads((Path(a.adapter)/'adapter_config.json').read_text())
assert config['material_labels']==LABELS
assert sha(Path(a.base)/'model.safetensors')==config['base_weight_sha256']
head=MaterialHead().eval();head.load_state_dict(load_file(str(Path(a.adapter)/'material-head.safetensors')))
base=Mask2FormerForUniversalSegmentation.from_pretrained(a.base,local_files_only=True,use_safetensors=True).eval()
processor=AutoImageProcessor.from_pretrained(a.base,local_files_only=True,use_fast=False)
im=ImageOps.exif_transpose(Image.open(a.image)).convert('RGB');im.thumbnail((1280,1280))
with torch.inference_mode():
 x=processor(images=im.resize((256,256),Image.Resampling.BILINEAR),do_resize=False,return_tensors='pt')['pixel_values']
 f=base.model.pixel_level_module(x).decoder_last_hidden_state[0]
 logits=head(f.flatten(1).T).T.reshape(1,len(LABELS),64,64)
 probs=F.interpolate(logits,size=(im.height,im.width),mode='bilinear',align_corners=False).softmax(1)
 confidence,ids=probs.max(1);ids=ids[0];ids[confidence[0]<a.threshold]=255
 result=ids.cpu().numpy().astype('uint8')
out=Path(a.output);out.mkdir(parents=True,exist_ok=True)
Image.fromarray(result).save(out/'material-labels.png')
(out/'labels.json').write_text(json.dumps(dict(enumerate(LABELS)),indent=2))
summary={'pixels_by_label':{n:int((result==i).sum()) for i,n in enumerate(LABELS)},'unknown_pixels':int((result==255).sum()),'unknown_id':255,'threshold':a.threshold,'confidence_calibrated':False,'use':'research only','note':'Paint/plaster/enamel is a combined class; no separate linoleum or plaster classifier.'}
(out/'summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary))
